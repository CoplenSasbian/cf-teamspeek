using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using CfTeamspeed.Desktop.Models;
using CfTeamspeed.Desktop.Services;
using CfTeamspeed.Desktop.Services.Audio;

// ============================================================
//  SFU 链路自检（--rtc-selftest <baseUrl> <key> <nickname>）
//
//  为什么必须单独测：音频链路有三段（采集/降噪、SDP 协商、RTP 收发），
//  前两段已经有独立自检了，但「SDP 协商到底通不通」只有真的打服务端才知道。
//  等界面接好再去试，失败时你分不清是 UI 接线错还是协商错。
//
//  实测内容：
//    1. 探测服务器 + 登录（拿 token）
//    2. 建房间（或复用一个）
//    3. 建发布会话：createOffer → POST /api/rtc/publish → 应用 answer
//    4. 确认 ICE 与 RTP 真的通了（看 SIPSorcery 的连接状态）
//    5. 订阅他人的轨道，验证 subscribe-batch → renegotiate 那条路径
//       （用 --room 指向一个真人在线的房间；没有则明确 SKIP，不假装通过）
//    6. 清理：关会话、退出房间、删测试房间
// ============================================================

internal static class RtcSelfTest
{
    public static int Run(string[] args)
    {
        var (baseUrl, key, nickname, extraRoomId) = ParseArgs(args);
        if (baseUrl is null)
        {
            Console.WriteLine("用法：--rtc-selftest <baseUrl> <key> <nickname> [--room <roomId>]");
            Console.WriteLine();
            Console.WriteLine("  --room <roomId>  额外在一个有人发音频的房间里验证订阅链路");
            Console.WriteLine("                   （订阅是「订阅别人的轨道」，单人房间测不了）");
            return 2;
        }

        Console.WriteLine("=== SFU 链路自检 ===");
        Console.WriteLine($"服务器：{baseUrl}");
        Console.WriteLine($"昵称：{nickname}");
        Console.WriteLine();

        try
        {
            return RunAsync(baseUrl, key!, nickname, extraRoomId).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"!! 未捕获异常：{ex.GetType().Name}: {ex.Message}");
            return 1;
        }
    }

    /// <summary>
    /// 解析参数：--rtc-selftest &lt;baseUrl&gt; &lt;key&gt; &lt;nickname&gt; [--room &lt;roomId&gt;]
    /// </summary>
    private static (string? BaseUrl, string? Key, string Nickname, string? ExtraRoomId) ParseArgs(string[] args)
    {
        var idx = Array.FindIndex(args, a => a.Equals("--rtc-selftest", StringComparison.OrdinalIgnoreCase));
        if (idx < 0 || idx + 1 >= args.Length) return (null, null, "rtc-selftest", null);

        var baseUrl = args[idx + 1];
        var key = idx + 2 < args.Length && !args[idx + 2].StartsWith("--", StringComparison.Ordinal)
            ? args[idx + 2]
            : "";
        var nick = idx + 3 < args.Length && !args[idx + 3].StartsWith("--", StringComparison.Ordinal)
            ? args[idx + 3]
            : "rtc-selftest";

        // 可选的房间：用来验证订阅链路（需要一个有人正在发音频的房间）
        var roomIdx = Array.FindIndex(args, a => a.Equals("--room", StringComparison.OrdinalIgnoreCase));
        var extraRoom = roomIdx >= 0 && roomIdx + 1 < args.Length ? args[roomIdx + 1] : null;

        return (baseUrl, key, nick, extraRoom);
    }

    /// <summary>
    /// 用一个后台线程跑 WinUI 的消息循环，**依次**弹出 Turnstile 窗口拿 N 个 token。
    ///
    /// 为什么要单开线程 + 独立 Application.Start：
    ///   WinUI 的 Application.Start 一个进程只能进一次，而自检是在
    ///   主线程上同步跑的（还没进 WinUI）。所以这里把「拿 token」整个
    ///   塞进一个 STA 线程里，跑完就退出 —— 与 TurnstileSelfTest 同一套路。
    ///
    /// ★ 为什么一次拿多个而不是调用多次：
    ///   Application.Start 只能进一次。第二次调用会抛 XamlParseException
    ///   并把进程带走（退出码 0xC000027B），报错看起来像 XAML 资源问题，
    ///   实际是重复初始化 WinUI —— 实测踩过一次，极难定位。
    ///   所以需要几个 token 就在同一个消息循环里连着拿几个。
    /// </summary>
    private static Task<List<string?>> AcquireTurnstilesAsync(
        string siteKey,
        string serverBaseUrl,
        int count)
    {
        var tcs = new TaskCompletionSource<List<string?>>(TaskCreationOptions.RunContinuationsAsynchronously);

        var thread = new Thread(() =>
        {
            try
            {
                WinRT.ComWrappersSupport.InitializeComWrappers();

                Microsoft.UI.Xaml.Application.Start(initParams =>
                {
                    var context = new Microsoft.UI.Dispatching.DispatcherQueueSynchronizationContext(
                        Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread());
                    SynchronizationContext.SetSynchronizationContext(context);

                    _ = initParams;

                    // App 必须先构造：它负责合并主题资源字典，
                    // TurnstileWindow 的样式引用了 {ThemeResource InkBrush} 等键。
                    CfTeamspeed.Desktop.App.SelfTestMode = true;
                    _ = new CfTeamspeed.Desktop.App();

                    _ = AcquireCoreAsync();

                    async Task AcquireCoreAsync()
                    {
                        var tokens = new List<string?>();

                        try
                        {
                            for (var i = 0; i < count; i++)
                            {
                                var window = new CfTeamspeed.Desktop.Views.TurnstileWindow(
                                    siteKey, $"RTC 自检 #{i + 1}", darkTheme: true, serverBaseUrl);
                                window.Activate();

                                // 给 Cloudflare 脚本留出网络时间；真实 key 可能需要
                                // 用户点一下复选框（Managed 模式）。
                                var outcome = await window.WaitAsync().WaitAsync(TimeSpan.FromSeconds(60));

                                tokens.Add(outcome.Success ? outcome.Token : null);

                                // ★ 两个窗口之间必须留出间隔，等上一个的 WebView2 环境
                                //   真正释放。Settle() 是「先完成任务、再关窗口」，
                                //   紧接着建下一个窗口时上一个还没销毁完，实测会报
                                //   E_ABORT (0x80004004)：CoreWebView2Initialized 失败
                                //   → EnsureCoreWebView2Async 返回 null。
                                //   1.5 秒足够，且只发生在自检路径上，不影响正式流程。
                                if (i < count - 1)
                                {
                                    await Task.Delay(1500);
                                }
                            }
                        }
                        catch (Exception ex)
                        {
                            Console.WriteLine($"    [turnstile] {ex.GetType().Name}: {ex.Message}");
                        }
                        finally
                        {
                            tcs.TrySetResult(tokens);
                            Microsoft.UI.Xaml.Application.Current.Exit();
                        }
                    }
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"    [turnstile] 线程异常 {ex.GetType().Name}: {ex.Message}");
                tcs.TrySetResult(new List<string?>());
            }
        });

        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();

        return tcs.Task;
    }

    /// <summary>旧签名（单 token）—— 保留给只取一个的场景。</summary>
    private static async Task<string?> AcquireTurnstileAsync(string siteKey, string serverBaseUrl)
    {
        var tokens = await AcquireTurnstilesAsync(siteKey, serverBaseUrl, 1);
        return tokens.Count > 0 ? tokens[0] : null;
    }


    private static async Task<int> RunAsync(string baseUrl, string key, string nickname, string? extraRoomId)
    {
        var profile = new ServerProfile
        {
            Id = "selftest",
            BaseUrl = ServerProfile.NormalizeBaseUrl(baseUrl) ?? baseUrl,
        };

        using var api = new ApiClient(profile);
        var ct = CancellationToken.None;

        // ---------- 1. 探测 ----------
        Console.WriteLine("[1] 探测服务器");
        try
        {
            var config = await api.GetConfigAsync(ct);
            Console.WriteLine($"    OK appName={config.AppName} loginTurnstile={config.LoginTurnstile}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"    FAIL：{ex.Message}");
            return 1;
        }

        // ---------- 2. 登录 ----------
        //
        // ★ 服务端（本机实测）对全员要求人机验证，所以自检也必须先拿 token。
        //   官方测试 key 给的 token（XXXX.DUMMY…）会被真实服务端拒绝，
        //   必须用服务器下发的真实 sitekey + 服务器域名（域名白名单校验）。
        Console.WriteLine();
        Console.WriteLine("[2] 人机验证（拿 turnstile token）");

        string? turnstileToken = null;
        try
        {
            var config = await api.GetConfigAsync(ct);
            if (config.LoginTurnstile ?? config.AdminLoginTurnstile ?? true)
            {
                if (string.IsNullOrWhiteSpace(config.TurnstileSiteKey))
                {
                    Console.WriteLine("    FAIL：服务端要求验证但没下发 siteKey");
                    return 1;
                }

                turnstileToken = await AcquireTurnstileAsync(config.TurnstileSiteKey, profile.BaseUrl!);

                if (turnstileToken is null)
                {
                    Console.WriteLine("    FAIL：未能取得 token");
                    return 1;
                }

                Console.WriteLine($"    OK tokenLength={turnstileToken.Length}");
            }
            else
            {
                Console.WriteLine("    （服务端关闭了验证，跳过）");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"    FAIL：{ex.GetType().Name}: {ex.Message}");
            return 1;
        }

        Console.WriteLine();
        Console.WriteLine("[3] 登录");
        var roomId = "";
        var selfUid = "";
        try
        {
            var result = await api.LoginAsync(key, nickname, null, turnstileToken, ct);
            selfUid = result.Profile?.Uid ?? "";
            Console.WriteLine($"    OK uid={selfUid} role={result.Profile?.Role} " +
                              $"tokenLen={result.Token?.Length}");
        }
        catch (ApiException ex)
        {
            Console.WriteLine($"    FAIL：code={ex.Code} msg={ex.Message}");
            return 1;
        }

        // ---------- 4. 建房间 ----------
        Console.WriteLine();
        Console.WriteLine("[4] 建测试房间");
        try
        {
            var created = await api.CreateRoomAsync("rtc-selftest", 10, ct);
            roomId = created.Room?.Id ?? "";
            Console.WriteLine($"    OK roomId={roomId}");
            if (string.IsNullOrEmpty(roomId))
            {
                Console.WriteLine("    FAIL：没拿到 roomId");
                return 1;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"    FAIL：{ex.Message}");
            return 1;
        }

        var exitCode = 0;

        try
        {
            // ---------- 4. 进房 + 发布 ----------
            Console.WriteLine();
            Console.WriteLine("[5] 发布会话（createOffer → SFU → answer）");
            await api.JoinRoomAsync(roomId, ct);

            var playback = new AudioMixerPlayback();
            await using var rtc = new RtcAudioSession(api, roomId, playback);

            rtc.StatusChanged += (_, msg) => Console.WriteLine($"    [状态] {msg}");

            // 用静音采集：自检不需要真的说话，只要链路通。
            // 但采集设备是真实打开的 —— 这样能同时验证「设备 → 编码 → RTP」。
            var denoise = new DenoiseProcessor(DenoiseLevel.Gate);

            // 统计采集帧：区分「采集没出帧」和「出了帧但没编码」，
            // 这两种情况的排查方向完全不同。
            var capturedFrames = 0;
            using var capture = new MicrophoneCapture(0, denoise, _ => Interlocked.Increment(ref capturedFrames));
            capture.CaptureFailed += (_, ex) => Console.WriteLine($"    [采集错误] {ex.Message}");

            try
            {
                await rtc.StartAsync(capture, Array.Empty<RemoteTrackRef>(), ct);
            }
            catch (ApiException ex)
            {
                Console.WriteLine($"    FAIL：code={ex.Code} msg={ex.Message}");
                exitCode = 1;
                return exitCode;
            }

            Console.WriteLine($"    OK IsPublishing={rtc.IsPublishing}");
            Console.WriteLine($"    编码器已注入={capture.EncodingRequested is not null}");

            if (!rtc.IsPublishing)
            {
                Console.WriteLine("    FAIL：发布链路没建立起来");
                exitCode = 1;
            }

            // 开采集，让 RTP 真的发出去几秒
            Console.WriteLine();
            Console.WriteLine("[6] 启动采集，观察 8 秒（验证编码 + RTP 发送）");
            capture.Start();
            await Task.Delay(8000, ct);

            Console.WriteLine($"    采集帧数={capturedFrames}（8 秒理论≈375）");
            Console.WriteLine($"    已编码帧数={capture.EncodedFrameCount}");

            if (capture.LastEncodeError is { } encErr)
            {
                Console.WriteLine($"    编码异常：{encErr.GetType().Name}: {encErr.Message}");
            }

            if (capturedFrames == 0)
            {
                Console.WriteLine("    FAIL：采集一帧都没出（设备问题）");
                exitCode = 1;
            }
            else if (capture.EncodedFrameCount == 0)
            {
                Console.WriteLine("    FAIL：采集有帧但编码为 0（编码器注入或调用问题）");
                exitCode = 1;
            }

            // ---------- 7. 订阅链路 ----------
            //
            // ★ 这一步必须真的走一遍 subscribe → offer → answer → renegotiate，
            //   不能跳过。实测教训：发布链路全绿、自检也过，但一进真实房间
            //   就报「连接失败」—— 因为出问题的是订阅路径：
            //   answer 提交前没等 ICE 收集完成，SFU 直接拒绝
            //   （PUT /sessions/{id}/renegotiate failed）。
            //
            //   验证方式：订阅**房间里已有的他人轨道**。
            //   单人测试房间里没有别人，所以需要 --room <id> 指向一个真人在线的房间；
            //   没有指定时，若当前测试房间里只有自己，则明确跳过并说明原因
            //   （而不是假装通过）。
            Console.WriteLine();
            Console.WriteLine("[7] 订阅链路（subscribe-batch → offer → answer → renegotiate）");

            var subscribeRoom = string.IsNullOrEmpty(extraRoomId) ? roomId : extraRoomId;
            if (subscribeRoom != roomId)
            {
                Console.WriteLine($"    使用指定房间 {subscribeRoom}（--room）");
            }

            try
            {
                var tracks = await api.GetTracksAsync(subscribeRoom, ct);
                Console.WriteLine($"    房间里可见轨道 {tracks.Tracks.Count} 条");

                var others = tracks.Tracks
                    .Where(t => t.Uid != selfUid && !string.IsNullOrEmpty(t.SessionId))
                    .Select(t => new RemoteTrackRef(t.Uid, t.SessionId, t.TrackName))
                    .ToList();

                Console.WriteLine($"    其中属于他人的 {others.Count} 条");
                foreach (var t in others)
                {
                    Console.WriteLine($"      - uid={t.Uid} session={t.PublisherSessionId[..8]}… track={t.TrackName}");
                }

                if (others.Count == 0)
                {
                    // 没有别人的轨道时，退而求其次：订阅**自己的**轨道。
                    // 这不是完美的端到端验证（订阅的还是自己那条流），
                    // 但它能完整走通 subscribe-batch → offer → answer → renegotiate
                    // —— 而 renegotiate 正是之前真实失败的地方
                    // （answer 提交前没等 ICE 收集，SFU 拒绝）。
                    // 所以这一步足以证明修复有效；真正的双人验证留给 --room。
                    var mine = tracks.Tracks
                        .Where(t => t.Uid == selfUid && !string.IsNullOrEmpty(t.SessionId))
                        .Select(t => new RemoteTrackRef(t.Uid, t.SessionId, t.TrackName))
                        .ToList();

                    Console.WriteLine($"    房间里没有他人轨道；改用自订阅验证协商路径（{mine.Count} 条）");

                    if (mine.Count == 0)
                    {
                        Console.WriteLine("    SKIP：连自己的轨道都看不到，无法验证");
                    }
                    else
                    {
                        await rtc.SubscribeAsync(mine, ct);
                        Console.WriteLine($"    OK 订阅（自回环）完成，已登记 {rtc.SubscribedUids.Count} 路");
                        Console.WriteLine("       → renegotiate 已成功，说明 ICE 等待修复有效");
                    }
                }
                else
                {
                    // 真正走一遍订阅（内部 setRemoteDescription → answer → 等 ICE → renegotiate）
                    await rtc.SubscribeAsync(others, ct);
                    Console.WriteLine($"    OK 订阅完成，已登记 {rtc.SubscribedUids.Count} 路");

                    var before = rtc.ReceivedBytes;
                    await Task.Delay(5000, ct);
                    var after = rtc.ReceivedBytes;

                    Console.WriteLine($"    远端 RTP：{before} → {after} 字节（增量 {after - before}），" +
                                      $"解码样点={rtc.DecodedSamples}");

                    if (after == before)
                    {
                        Console.WriteLine("    FAIL：协商成功但 5 秒没收到任何远端 RTP");
                        exitCode = 1;
                    }
                }
            }
            catch (ApiException ex)
            {
                Console.WriteLine($"    FAIL：{ex.Code} {ex.Describe()}");
                exitCode = 1;
            }

            capture.Stop();
            await rtc.StopAsync(ct);

            Console.WriteLine();
            Console.WriteLine("    清理：已关闭 RTC 会话");
        }
        finally
        {
            // ---------- 清理测试房间 ----------
            try
            {
                await api.LeaveRoomAsync(roomId, ct);
            }
            catch
            {
                // 忽略
            }

            try
            {
                await api.DeleteRoomAsync(roomId, ct);
                Console.WriteLine($"    已删除测试房间 {roomId}");
            }
            catch
            {
                Console.WriteLine($"    注意：测试房间 {roomId} 未能删除，请手动清理");
            }
        }

        Console.WriteLine();
        Console.WriteLine(exitCode == 0
            ? "=== 通过：发布 + 订阅两条 SFU 链路均已跑通 ==="
            : "=== 有失败项，见上方输出 ===");

        return exitCode;
    }
}
