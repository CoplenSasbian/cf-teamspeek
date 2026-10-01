using NAudio.Wave;

namespace CfTeamspeed.Desktop.Services.Audio;

// ============================================================
//  远端音频播放（混音）
//
//  ★ 核心设计：一个 WaveOut，多个「音源」
//
//    直觉写法是「每个远端用户开一个 WaveOut」—— 那是错的：
//      · 每个 WaveOut 是独立的系统音频流，各自有独立的缓冲与抖动，
//        几条流之间会**互相不同步**，听起来像回声/错位；
//      · 系统音量控制里会冒出 N 个「CfTeamspeed」，用户没法理解；
//      · 每流一个线程，N 大了开销无谓增加。
//
//    正确做法：一个输出设备 + 一个混音器，把各路远端音频
//    按 uid 分别乘上该用户音量后求和，再一次性送进设备。
//    这也正好对上已有的 VolumeSettings.Users（按 uid 存音量）。
//
//  ★ 线程纪律：
//    混音跑在 WaveOut 的播放线程上（固定节拍回调），
//    读共享字典时必须短锁 + 快照，不能在里面做任何重活。
// ============================================================

/// <summary>
/// 一路远端音频（某个用户）。
///
/// 生产者（RTP 接收线程）写、消费者（播放线程）读，
/// 所以内部用环形缓冲解耦，两个线程之间不直接传递对象。
/// </summary>
public sealed class RemoteAudioSource
{
    private readonly float[] _buffer;
    private readonly object _gate = new();

    private int _readPos;
    private int _writePos;
    private int _count;

    public RemoteAudioSource(string uid, int capacitySamples = 48000 * 2)
    {
        Uid = uid;
        _buffer = new float[capacitySamples];
    }

    public string Uid { get; }

    /// <summary>该用户的音量（0..2，1 = 原始）。界面改音量时直接写这里。</summary>
    public volatile float Volume = 1f;

    /// <summary>是否被本地单独静音。</summary>
    public volatile bool Muted;

    /// <summary>当前缓冲里可读的样点数（用于检测欠载）。</summary>
    public int Available
    {
        get { lock (_gate) return _count; }
    }

    /// <summary>写入远端解出来的 PCM（由 RTP 接收线程调用）。</summary>
    public void Write(ReadOnlySpan<float> samples)
    {
        lock (_gate)
        {
            foreach (var s in samples)
            {
                // 缓冲满 = 播放侧跟不上（设备卡了/线程被抢）。
                // 丢弃最旧的数据而不是覆盖最新：宁可听到一点断裂，
                // 也不要让延迟无限累积（累积会造成「越聊越延迟」）。
                if (_count == _buffer.Length)
                {
                    _readPos = (_readPos + 1) % _buffer.Length;
                    _count--;
                }

                _buffer[_writePos] = s;
                _writePos = (_writePos + 1) % _buffer.Length;
                _count++;
            }
        }
    }

    /// <summary>
    /// 取出最多 <paramref name="count"/> 个样点，按音量缩放后累加到
    /// <paramref name="destination"/>。返回实际取出的样点数。
    /// </summary>
    public int MixInto(Span<float> destination, int count, float masterVolume)
    {
        var gain = Muted ? 0f : Volume * masterVolume;

        lock (_gate)
        {
            var take = Math.Min(count, _count);
            for (var i = 0; i < take; i++)
            {
                destination[i] += _buffer[_readPos] * gain;
                _readPos = (_readPos + 1) % _buffer.Length;
            }

            _count -= take;
            return take;
        }
    }

    /// <summary>清掉积压的数据（重新进房 / 对端重连时用，避免播放旧音频）。</summary>
    public void Clear()
    {
        lock (_gate)
        {
            _readPos = 0;
            _writePos = 0;
            _count = 0;
        }
    }
}

/// <summary>
/// 把多路远端音频混到一起送给扬声器。
/// </summary>
public sealed class AudioMixerPlayback : IDisposable
{
    /// <summary>混音块大小（48kHz 下 10ms）。</summary>
    private const int BlockSamples = 480;

    private readonly object _gate = new();
    private readonly Dictionary<string, RemoteAudioSource> _sources = new(StringComparer.Ordinal);

    private WaveOut? _waveOut;
    private BufferedWaveProvider? _provider;
    private float[] _mixBuffer = new float[BlockSamples];
    private bool _disposed;

    /// <summary>总播放音量（0..2）。</summary>
    public volatile float MasterVolume = 1f;

    /// <summary>开始播放（可在进房后调用）。</summary>
    public void Start(int deviceNumber)
    {
        if (_waveOut is not null) return;

        var format = new WaveFormat(MicrophoneCapture.TargetSampleRate, 16, 1);

        // NAudio 3.0：BufferDuration 是只读属性，缓冲时长只能从构造函数给。
        // 200ms 足够吸收调度抖动，又不会把延迟堆起来。
        _provider = new BufferedWaveProvider(format, TimeSpan.FromMilliseconds(200))
        {
            // 允许丢弃旧数据：这里我们自己做了混音与缓冲管理，
            // 再叠一层无界缓冲只会把延迟越堆越高。
            DiscardOnBufferOverflow = true,
            ReadFully = true,
        };

        // NAudio 3.0：WaveOutEvent 已更名为 WaveOut（旧的仍可用但标记为过时）。
        _waveOut = new WaveOut
        {
            DeviceNumber = deviceNumber < 0 ? 0 : deviceNumber,
        };

        _waveOut.Init(_provider);
        _waveOut.Play();

        // 用一个独立线程主动往 provider 里灌混音结果。
        // 为什么不用 provider 自己拉：我们需要「每次填多少就混多少」的
        // 精确控制，且混音涉及多路取数据，放在一个明确节奏的线程上更好推理。
        _pump = new Thread(PumpLoop) { IsBackground = true, Name = "audio-mix-pump" };
        _pump.Start();
    }

    private Thread? _pump;

    private void PumpLoop()
    {
        var bytes = new byte[BlockSamples * 2];

        while (!_disposed)
        {
            try
            {
                Array.Clear(_mixBuffer);

                RemoteAudioSource[] snapshot;
                lock (_gate)
                {
                    snapshot = _sources.Values.ToArray();
                }

                var master = MasterVolume;
                foreach (var source in snapshot)
                {
                    source.MixInto(_mixBuffer, BlockSamples, master);
                }

                // float → 16-bit PCM，并做软限幅。
                // 多人同时说话时简单相加会超过 ±1，硬截断会产生刺耳的爆音，
                // 所以这里用 tanh 做软饱和（听感上「压得住」而不是「劈」）。
                for (var i = 0; i < BlockSamples; i++)
                {
                    var v = (float)Math.Tanh(_mixBuffer[i]);
                    var s = (short)(v * 32000);
                    bytes[i * 2] = (byte)(s & 0xFF);
                    bytes[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
                }

                _provider?.AddSamples(bytes, 0, bytes.Length);

                // 10ms 一块 → 睡 ~9ms（留 1ms 给实际计算，避免节奏漂移）
                Thread.Sleep(9);
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (ThreadInterruptedException)
            {
                return;
            }
            catch
            {
                // 混音线程绝不能因为单次异常整个退出（否则一崩就彻底没声音），
                // 睡一下继续下一轮
                Thread.Sleep(10);
            }
        }
    }

    /// <summary>取得（必要时创建）某个用户对应的音源。</summary>
    public RemoteAudioSource GetOrAddSource(string uid)
    {
        lock (_gate)
        {
            if (_sources.TryGetValue(uid, out var existing)) return existing;

            var created = new RemoteAudioSource(uid);
            _sources[uid] = created;
            return created;
        }
    }

    public RemoteAudioSource? FindSource(string uid)
    {
        lock (_gate)
        {
            return _sources.TryGetValue(uid, out var s) ? s : null;
        }
    }

    /// <summary>移除某个用户的音源（他离开房间时）。</summary>
    public void RemoveSource(string uid)
    {
        lock (_gate)
        {
            _sources.Remove(uid);
        }
    }

    public void ClearSources()
    {
        lock (_gate)
        {
            _sources.Clear();
        }
    }

    public void Stop()
    {
        try
        {
            _waveOut?.Stop();
        }
        catch
        {
            // 忽略
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try
        {
            _pump?.Interrupt();
        }
        catch
        {
            // 忽略
        }

        Stop();

        _waveOut?.Dispose();
        _waveOut = null;
        _provider = null;
        _pump = null;
    }
}
