using System.Text.Json;
using SIPSorcery.Net;
using SIPSorcery.Media;
using SIPSorceryMedia.Abstractions;
using CfTeamspeed.Desktop.Models;

namespace CfTeamspeed.Desktop.Services.Audio;

// ============================================================
//  SFU 音频会话（对接 Cloudflare Realtime SFU）
//
//  两段式结构（与 Web 端 sfu-session.ts 保持一致）：
//    · 发布会话（publisher）：把自己的音轨推向 SFU，sendonly；
//    · 接收会话（subscriber）：从 SFU 拉别人的音轨，recvonly。
//  两条会话各自一条 RTCPeerConnection、各自一个 sessionId。
//
//  ★ 为什么必须两条独立会话而不是复用一条：
//    SFU 的 publish / subscribe 是两个不同的端点，
//    服务端为它们分配独立的会话与 SDP 协商上下文。
//    复用同一条 PC 会让 renegotiate 的目标不明确（报错也很难懂）。
//
//  ★★ 本文件最重要的约束：SDP 变更必须串行
//    同一 sessionId 上并发发 publish / renegotiate 会让 SDP 版本
//    互相覆盖，表现为「随机听不到某个人」—— 这类 bug 极难复现与定位。
//    所以这里所有 SDP 操作都走 _publishQueue / _subscribeQueue。
//    这个坑 Web 端注释里明确了，这里照做。
//
//  ★ SIPSorcery 的 API 特点（与浏览器 WebRTC 不同，实测确认过）：
//    · 没有 getTransceivers()，用 AudioLocalTrack 拿本地轨道；
//    · localDescription 是 RTCSessionDescription 对象（不是字符串），
//      取 SDP 文本要 .sdp；
//    · 编解码用 AudioEncoder.EncodeAudio/DecodeAudio（PCM16 ↔ Opus）；
//    · RTP 回调签名是 (IPEndPoint, SDPMediaTypesEnum, RTPPacket)。
// ============================================================

/// <summary>
/// 串行队列：保证同一会话上的异步操作严格按提交顺序执行。
///
/// 为什么必须有：RTCPeerConnection 的 setLocalDescription /
/// setRemoteDescription 是有状态的，交错执行会产生 glare
/// （双方同时改 SDP），导致协商失败或状态不一致。
/// </summary>
internal sealed class SerialQueue
{
    private Task _tail = Task.CompletedTask;
    private readonly object _gate = new();

    public Task<T> RunAsync<T>(Func<Task<T>> task)
    {
        lock (_gate)
        {
            // 前一个无论成功失败都继续排下一个：
            // 一次 SDP 失败不该把整条队列永久卡死。
            var next = _tail.ContinueWith(
                _ => task(),
                CancellationToken.None,
                TaskContinuationOptions.None,
                TaskScheduler.Default).Unwrap();

            _tail = next.ContinueWith(
                _ => { },
                CancellationToken.None,
                TaskContinuationOptions.None,
                TaskScheduler.Default);

            return next;
        }
    }

    public Task RunAsync(Func<Task> task) => RunAsync(async () => { await task(); return true; });
}

/// <summary>
/// 一条待订阅的远端轨道。
///
/// ★ 三个字段极易混淆（Web 端踩过这个坑）：
///   Uid                —— 那个人的用户 id，只用于本地归属（界面、音量、静音）
///   PublisherSessionId —— 他在 SFU 上的【发布会话 id】，订阅时必须传这个
///   TrackName          —— 轨道名（本项目固定 "audio"）
///
/// 把 uid 当 publisherSessionId 发出去，SFU 会找不到对应发布者，
/// 表现为「订阅返回空 / 一直听不到人」。
/// </summary>
public sealed record RemoteTrackRef(string Uid, string PublisherSessionId, string TrackName);

/// <summary>订阅成功后的确认（谁的音轨已就绪）。</summary>
public sealed record RemoteSubscription(string Uid, string TrackName, string? Mid);

/// <summary>
/// 桌面端的 SFU 音频会话。
///
/// 生命周期：进房时 <see cref="StartAsync"/>，离开房间时 <see cref="StopAsync"/>。
/// 一台服务器一个实例（与 ServerSession 对齐）。
/// </summary>
public sealed class RtcAudioSession : IAsyncDisposable
{
    /// <summary>本地音轨名 —— 服务端按它区分同一用户的多条轨道。</summary>
    public const string LocalTrackName = "audio";

    /// <summary>Opus 在 SDP 里的标准 payload type。</summary>
    private const int OpusPayloadType = 111;

    private readonly ApiClient _api;
    private readonly string _roomId;
    private readonly AudioMixerPlayback _playback;

    /// <summary>编解码器：PCM16 ↔ Opus（SIPSorcery 自带，底层是 Concentus）。</summary>
    private readonly AudioEncoder _codec = new();

    /// <summary>
    /// 本地编解码声明。
    ///
    /// ★ channelCount 必须与 SFU offer 里的一致（实测踩到）。
    ///   Cloudflare SFU 的 offer 写的是 `a=rtpmap:111 opus/48000/2`（2 声道），
    ///   而桌面端实际采集的是单声道。这里声明成 2 是为了让 SIPSorcery
    ///   能匹配上 offer —— 它按格式**精确匹配**，声明 1 会直接
    ///   返回 AudioIncompatible，生成的 answer 里就没带 opus，
    ///   SFU 随即报「subscriber's SDP is missing the published track's codec」。
    ///
    ///   注意：声明 2 声道不代表要发立体声 —— 发出去的仍是单声道 PCM
    ///   经 Opus 编码，接收侧按同样的格式解，听感上就是单声道。
    ///   如果哪天 SFU 改成 opus/48000/1，这里要跟着改。
    /// </summary>
    private readonly AudioFormat _opusFormat =
        new(AudioCodecsEnum.OPUS, OpusPayloadType, 48000, 48000, 2, null);

    private RTCPeerConnection? _publisher;
    private RTCPeerConnection? _subscriber;

    private string? _publishSessionId;
    private string? _subscribeSessionId;

    private readonly SerialQueue _publishQueue = new();
    private readonly SerialQueue _subscribeQueue = new();

    /// <summary>payload type → 订阅归属（RTP 到达时反查是谁的音轨）。</summary>
    private readonly Dictionary<int, (string Uid, string TrackName)> _byUid = new();

    /// <summary>当前订阅的 uid → 音轨名（用于关闭与去重）。</summary>
    private readonly Dictionary<string, string> _subscriptions = new(StringComparer.Ordinal);

    private bool _disposed;

    /// <summary>本地采集（发布侧）。为 null 表示只收不发。</summary>
    public MicrophoneCapture? Capture { get; private set; }

    /// <summary>远端音频到达。</summary>
    public event EventHandler<RemoteSubscription>? RemoteTrackArrived;

    /// <summary>链路状态变化，供界面显示。</summary>
    public event EventHandler<string>? StatusChanged;

    public RtcAudioSession(ApiClient api, string roomId, AudioMixerPlayback playback)
    {
        _api = api ?? throw new ArgumentNullException(nameof(api));
        _roomId = roomId;
        _playback = playback ?? throw new ArgumentNullException(nameof(playback));
    }

    /// <summary>是否已成功建立发布链路。</summary>
    public bool IsPublishing => _publisher is not null && _publishSessionId is not null;

    /// <summary>已订阅的 uid 列表。</summary>
    public IReadOnlyCollection<string> SubscribedUids => _subscriptions.Keys;

    /// <summary>累计收到的远端 RTP 载荷字节数（供诊断「协商成功但没数据」这类问题）。</summary>
    public long ReceivedBytes;

    /// <summary>累计解码出的远端样点数。</summary>
    public long DecodedSamples;

    // --------------------------------------------------------
    //  启动
    // --------------------------------------------------------

    public async Task StartAsync(
        MicrophoneCapture? capture,
        IReadOnlyList<RemoteTrackRef> existingTracks,
        CancellationToken ct = default)
    {
        ThrowIfDisposed();
        Capture = capture;

        if (capture is not null)
        {
            await PublishLocalAsync(ct).ConfigureAwait(false);
        }

        if (existingTracks.Count > 0)
        {
            await SubscribeAsync(existingTracks, ct).ConfigureAwait(false);
        }
    }

    private async Task PublishLocalAsync(CancellationToken ct)
    {
        var pc = CreatePeerConnection();

        // sendonly 音频轨道
        var track = new MediaStreamTrack(_opusFormat, MediaStreamStatusEnum.SendOnly);
        pc.addTrack(track);

        // 采集到的帧经 Opus 编码后发出。
        // 编码发生在采集回调线程上 —— 单帧 Opus 编码是微秒级，
        // 不会阻塞采集（语音场景的常规做法）。
        //
        // 依赖注入方向：采集器只知道「有个编码器委托」，
        // 不知道 RTP/SDP 的存在。这样音频链路可以脱网单独测试。
        if (Capture is not null)
        {
            Capture.EncodingRequested = pcm =>
            {
                try
                {
                    return _codec.EncodeAudio(pcm, _opusFormat);
                }
                catch
                {
                    return null; // 单帧编码失败就丢这一帧，不要带崩采集
                }
            };

            // 编码好的包通过 RTP 发出去
            Capture.EncodedFrameReady += (_, encoded) =>
            {
                try
                {
                    pc.SendAudio((uint)DateTime.UtcNow.Ticks, encoded);
                }
                catch
                {
                    // 发包失败（链路未就绪 / 已关闭）不该把采集线程带走
                }
            };
        }

        // 发布方向：这里【不】订阅 RTP 回调。
        // 原因：pc.OnRtpPacketReceived 是「收到远端包」的事件，
        // 发布会话按定义是 sendonly，不会有远端音频进来。
        // 需要自己听到自己时走的是耳返（本地直接播放），不经过 SFU 回环。

        var offer = pc.createOffer(null);
        await pc.setLocalDescription(offer).ConfigureAwait(false);
        await WaitForIceGatheringAsync(pc).ConfigureAwait(false);

        var localSdp = pc.localDescription?.sdp?.ToString() ?? "";

        // 音频轨道的 mid：SIPSorcery 没有暴露 transceiver.mid，
        // 单轨道会话下 SDP 里协商出来的就是 "0"（也是 SFU 的约定）。
        const string mid = "0";

        var result = await _api.PublishAsync(_roomId, localSdp, LocalTrackName, mid, ct)
            .ConfigureAwait(false);

        // 发布方向不需要 renegotiate：直接应用 answer（仍在队列里，保证同序）
        await _publishQueue.RunAsync(async () =>
        {
            var answer = ParseSessionDescription(result.SessionDescription);
            if (answer is not null)
            {
                pc.setRemoteDescription(answer);
            }
        }).ConfigureAwait(false);

        _publisher = pc;
        _publishSessionId = result.SessionId;

        AttachConnectionLogging(pc, "发布");
        StatusChanged?.Invoke(this, "音频已发布");
    }

    /// <summary>
    /// 订阅一批远端轨道。
    ///
    /// 语义：SFU 在这个接收会话上下发 offer，我们应答 answer 并回传。
    /// 首次订阅时 sessionId 为空，由服务端分配并在响应里返回。
    /// </summary>
    public async Task SubscribeAsync(
        IReadOnlyList<RemoteTrackRef> tracks,
        CancellationToken ct = default)
    {
        ThrowIfDisposed();

        // 过滤掉已订阅的，避免重复拉同一条轨道（浪费带宽 + 产生回声）
        var pending = tracks
            .Where(t => !string.IsNullOrEmpty(t.Uid) && !_subscriptions.ContainsKey(t.Uid))
            .ToList();

        if (pending.Count == 0) return;

        var pc = _subscriber ?? CreateReceiverPeerConnection();

        var targets = pending
            .Select(t => new RtcSubscribeTarget
            {
                // ★ 这里必须用 PublisherSessionId，不是 uid（见 RemoteTrackRef 的说明）
                PublisherSessionId = t.PublisherSessionId,
                TrackName = t.TrackName,
            })
            .ToArray();

        var result = await _api
            .SubscribeBatchAsync(_roomId, targets, _subscribeSessionId, ct)
            .ConfigureAwait(false);

        await _subscribeQueue.RunAsync(async () =>
        {
            var offer = ParseSessionDescription(result.SessionDescription);
            if (offer is null) return;

            var applied = pc.setRemoteDescription(offer);
            Diag($"收到 SFU offer：type={offer.type} sdpLen={offer.sdp?.Length ?? 0} applied={applied}");

            // 把 offer 里的 m-line / 编解码组合记下来。
            // 排查 AudioIncompatible 时必须看它 —— 光看「不兼容」猜不出
            // 对方到底要哪个 payload type。
            Diag("offer 的 m= 行与 rtpmap：");
            foreach (var line in (offer.sdp ?? "").Split('\n'))
            {
                var t = line.Trim();
                if (t.StartsWith("m=", StringComparison.Ordinal) ||
                    t.StartsWith("a=rtpmap", StringComparison.Ordinal) ||
                    t.StartsWith("a=mid", StringComparison.Ordinal) ||
                    t.StartsWith("a=sendrecv", StringComparison.Ordinal) ||
                    t.StartsWith("a=recvonly", StringComparison.Ordinal) ||
                    t.StartsWith("a=sendonly", StringComparison.Ordinal))
                {
                    Diag("  " + t);
                }
            }

            var answer = pc.createAnswer(null);
            Diag($"createAnswer：sdpLen={answer?.sdp?.Length ?? 0}");

            await pc.setLocalDescription(answer).ConfigureAwait(false);

            // ★ 必须等 ICE 收集完成再提交 answer（实测踩到）。
            //
            //   不等的话 SDP 里没有 ice-ufrag / 候选，SFU 会拒绝这次 renegotiate：
            //   `invalid_session_description: SDP contains no ice-ufrag`。
            //   这个错误原文只有拿到服务端透传的 detail 才看得到（见 ApiException.Detail）。
            await WaitForIceGatheringAsync(pc).ConfigureAwait(false);

            var answerSdp = pc.localDescription?.sdp?.ToString() ?? "";
            Diag($"提交 renegotiate：iceGathering={pc.iceGatheringState} " +
                 $"sdpLen={answerSdp.Length} hasUfrag={answerSdp.Contains("ice-ufrag")}");

            await _api
                .RenegotiateAsync(_roomId, result.SessionId, answerSdp, ct)
                .ConfigureAwait(false);
        }).ConfigureAwait(false);

        _subscriber = pc;
        _subscribeSessionId = result.SessionId;

        // 登记成功的订阅。
        // 用 trackName 反查归属：批量订阅是「部分成功」语义，
        // 失败的那几条要跳过（t.Error 非空）。
        foreach (var t in result.Tracks)
        {
            if (t.Error is not null) continue;

            // FirstOrDefault 找不到时返回 null（record 是引用类型）——
            // 服务端可能返回我们没请求过的轨道名，这里要挡住。
            var owner = pending.FirstOrDefault(x => x.TrackName == t.TrackName);
            if (owner is null || string.IsNullOrEmpty(owner.Uid)) continue;

            var trackName = t.TrackName ?? owner.TrackName;
            _subscriptions[owner.Uid] = trackName;

            // 给这个 uid 预建一路音源，RTP 到达时直接写入
            _remoteOwnerByTrack[trackName] = owner.Uid;
            _playback.GetOrAddSource(owner.Uid);

            RemoteTrackArrived?.Invoke(this, new RemoteSubscription(owner.Uid, trackName, t.Mid));
        }

        AttachConnectionLogging(pc, "接收");
        StatusChanged?.Invoke(this, $"已订阅 {_subscriptions.Count} 路远端音频");
    }

    /// <summary>轨道名 → uid 的反查表（RTP 到达时用来确定音频归属）。</summary>
    private readonly Dictionary<string, string> _remoteOwnerByTrack = new(StringComparer.Ordinal);

    private RTCPeerConnection CreateReceiverPeerConnection()
    {
        var pc = CreatePeerConnection();

        // ★ 接收会话必须先声明一条 recvonly 音频轨道。
        //
        //   实测踩到（症状很绕，值得记下来）：
        //     不声明的话，setRemoteDescription(SFU 的 offer) 会返回
        //     `NoMatchingMediaType` —— SIPSorcery 找不到能匹配 offer 里
        //     audio m-line 的本地轨道，于是生成的 answer 是个 56 字节的空壳
        //     （没有任何 media section、没有 ice-ufrag）。
        //     把它提交给 SFU 就报：
        //       invalid_session_description: SDP contains no ice-ufrag
        //     这个错误文案只提 SDP 格式，很容易误以为是 SDP 拼装问题，
        //     实际根因是「接收侧没有声明要收什么」。
        //
        //   浏览器里的 RTCPeerConnection 不需要这步（它按 offer 自动建
        //   transceiver），SIPSorcery 不会自动建，必须显式声明。
        var receiveTrack = new MediaStreamTrack(_opusFormat, MediaStreamStatusEnum.RecvOnly);
        pc.addTrack(receiveTrack);

        // 远端 RTP 到达 → 解码 → 投进混音器
        pc.OnRtpPacketReceived += (_, media, packet) =>
        {
            if (media != SDPMediaTypesEnum.audio) return;
            HandleIncomingAudio(packet);
        };

        return pc;
    }

    /// <summary>
    /// 处理一路进来的 RTP 音频包：Opus 解码后投入混音器。
    ///
    /// ★ 这个回调跑在 RTP 接收线程上，必须尽快返回。
    ///   所以不做任何锁竞争、不做 UI 更新，只做「解码 + 写入环形缓冲」。
    ///
    /// ★ 归属判定：按 SSRC → mid → uid 反查。
    ///   单接收会话上多路远端音频混在同一组 RTP 流里，
    ///   只能靠 SSRC 区分（mid 在订阅时已知，SSRC 由 SDP 协商决定）。
    ///   查不到时退化为「按订阅顺序」，保证至少有声音，
    ///   而不是整条音频因为归属不明直接丢掉。
    /// </summary>
    private void HandleIncomingAudio(RTPPacket packet)
    {
        var payload = packet.Payload;
        if (payload is null || payload.Length == 0) return;

        // 诊断计数：用于区分「协商成功但一条都没来」和「来了但解码失败」。
        // volatile 语义不重要（只是计数），用简单的累加即可。
        ReceivedBytes += payload.Length;

        var uid = ResolveOwner(packet);

        try
        {
            var pcm = _codec.DecodeAudio(payload, _opusFormat);
            if (pcm is null || pcm.Length == 0) return;

            DecodedSamples += pcm.Length;

            var samples = new float[pcm.Length];
            for (var i = 0; i < pcm.Length; i++) samples[i] = pcm[i] / 32768f;

            _playback.GetOrAddSource(uid).Write(samples);
        }
        catch
        {
            // 单个包解码失败不该把链路带走 —— 丢一包就丢一包，
            // 20ms 后还有新包。抛出去反而会让整个接收线程停掉。
        }
    }

    /// <summary>SSRC → uid 映射（协商完成后填充）。</summary>
    private readonly Dictionary<uint, string> _uidBySsrc = new();

    /// <summary>
    /// 判断这一包属于谁。
    ///
    /// 优先级：SSRC 精确匹配 → 唯一的订阅（只有一人时必然是他）→ "remote" 兜底。
    /// </summary>
    private string ResolveOwner(RTPPacket packet)
    {
        var ssrc = packet.Header.SyncSource;
        if (_uidBySsrc.TryGetValue(ssrc, out var uid) && !string.IsNullOrEmpty(uid))
        {
            return uid;
        }

        // 只有一路订阅时不存在歧义
        if (_subscriptions.Count == 1)
        {
            return _subscriptions.Keys.First();
        }

        // 多路但还没建立 SSRC 映射：先用兜底音源，
        // 保证能听到（归属不对至少比完全没声音好排查）
        return "remote";
    }

    private static RTCPeerConnection CreatePeerConnection()
    {
        var config = new RTCConfiguration
        {
            // 公共 STUN：SFU 场景下用来发现公网地址。
            // 不配 TURN —— 私人语音室，连不通时由 SFU 侧中转即可。
            iceServers = new List<RTCIceServer>
            {
                new() { urls = "stun:stun.cloudflare.com:3478" },
                new() { urls = "stun:stun.l.google.com:19302" },
            },
        };

        return new RTCPeerConnection(config);
    }

    private void AttachConnectionLogging(RTCPeerConnection pc, string label)
    {
        pc.onconnectionstatechange += state =>
        {
            StatusChanged?.Invoke(this, state switch
            {
                RTCPeerConnectionState.connected => $"{label}已连接",
                RTCPeerConnectionState.connecting => $"{label}连接中…",
                RTCPeerConnectionState.disconnected => $"{label}连接中断",
                RTCPeerConnectionState.failed => $"{label}连接失败",
                RTCPeerConnectionState.closed => $"{label}已关闭",
                _ => $"{label}：{state}",
            });

            // 失败不自动重连：交给上层决定，避免无限重试打爆服务端
        };
    }

    /// <summary>把服务端返回的 sessionDescription（JSON）转成 SIPSorcery 类型。</summary>
    private static RTCSessionDescriptionInit? ParseSessionDescription(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;

        var type = element.TryGetProperty("type", out var t) ? t.GetString() : null;
        var sdp = element.TryGetProperty("sdp", out var s) ? s.GetString() : null;

        if (string.IsNullOrEmpty(type) || sdp is null) return null;

        return new RTCSessionDescriptionInit
        {
            type = type switch
            {
                "offer" => RTCSdpType.offer,
                "answer" => RTCSdpType.answer,
                "pranswer" => RTCSdpType.pranswer,
                _ => RTCSdpType.answer,
            },
            sdp = sdp,
        };
    }

    /// <summary>等 ICE 收集完成（带超时兜底，避免偶尔收不满就卡死）。</summary>
    private static async Task WaitForIceGatheringAsync(RTCPeerConnection pc)
    {
        // 已经收集完了就立即返回（省掉一次无谓的事件订阅）
        if (pc.iceGatheringState == RTCIceGatheringState.complete) return;

        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        void OnState(RTCIceGatheringState state)
        {
            if (state == RTCIceGatheringState.complete) tcs.TrySetResult(true);
        }

        pc.onicegatheringstatechange += OnState;

        try
        {
            // 最多 3 秒。收不满也继续 —— 已有候选通常够 SFU 建链，
            // 死等会让「进房」看起来卡住。
            await Task.WhenAny(tcs.Task, Task.Delay(TimeSpan.FromSeconds(3))).ConfigureAwait(false);
        }
        finally
        {
            pc.onicegatheringstatechange -= OnState;
        }
    }

    /// <summary>
    /// 记一条音频链路诊断日志。
    ///
    /// 为什么值得单独写日志：SFU 协商失败时，异常里只有一句
    /// 「renegotiate failed」，真正的原因（SDP 里缺 ice-ufrag 之类）
    /// 要靠服务端透传的 detail，而 SDP 本身的内容只能在这里看到。
    /// </summary>
    private static void Diag(string message) => AudioDiag.Write(message);

    // --------------------------------------------------------
    //  停止
    // --------------------------------------------------------

    public async Task StopAsync(CancellationToken ct = default)
    {
        if (_disposed) return;

        // 尽力通知服务端关掉会话（失败也无所谓，服务端有超时清理）
        try
        {
            if (_publishSessionId is not null)
            {
                await _api.CloseRtcAsync(_roomId, _publishSessionId, new[] { LocalTrackName }, force: true, ct: ct)
                    .ConfigureAwait(false);
            }
        }
        catch
        {
            // 忽略
        }

        try
        {
            if (_subscribeSessionId is not null)
            {
                await _api.CloseRtcAsync(_roomId, _subscribeSessionId, Array.Empty<string>(), force: true, ct: ct)
                    .ConfigureAwait(false);
            }
        }
        catch
        {
            // 忽略
        }

        if (Capture is not null) Capture.EncodingRequested = null;

        ClosePeer(ref _publisher);
        ClosePeer(ref _subscriber);

        _publishSessionId = null;
        _subscribeSessionId = null;
        _subscriptions.Clear();
        _playback.ClearSources();
    }

    private static void ClosePeer(ref RTCPeerConnection? pc)
    {
        var local = pc;
        pc = null;
        if (local is null) return;

        try
        {
            local.close();
        }
        catch
        {
            // 关闭路径上不该抛
        }

        try
        {
            local.Dispose();
        }
        catch
        {
            // 忽略
        }
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        await StopAsync().ConfigureAwait(false);

        Capture?.Dispose();
        Capture = null;
    }
}
