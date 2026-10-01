using NAudio.Wave;

namespace CfTeamspeed.Desktop.Services.Audio;

// ============================================================
//  麦克风采集
//
//  数据流：
//    NAudio WaveInEvent（16-bit PCM，按设备原生采样率）
//      → 转 float32 单声道
//      → 重采样到 48kHz（若不是）
//      → 按 512 样点切帧 → 交降噪 → 回调给上层编码
//
//  ★ 为什么统一到 48kHz / 512 样点：
//    · 48kHz 是 Opus 的原生采样率，也是 WebRTC 的标准音频时钟，
//      在采集侧就转好可以避免后面二次重采样（每次重采样都会掉质量）；
//    · 512 样点是 DeepFilterNet3 的帧长，降噪必须在采集侧做，
//      因为这里拿到的是最干净的原始信号。
//
//  ★ 线程纪律（这里最容易写出难查的 bug）：
//    DataAvailable 跑在 NAudio 的采集线程上，且**必须尽快返回**。
//    在这里做任何阻塞（锁竞争、写文件、等 UI）都会导致爆音/丢帧。
//    所以：降噪结果通过回调交给上层，但上层若要做重活必须自己再抛出去。
// ============================================================

    /// <summary>采集到一帧 48kHz 单声道浮点音频（已降噪）。</summary>
    public delegate void AudioFrameHandler(ReadOnlySpan<float> frame);

    /// <summary>
    /// 把一帧 PCM16 编码成 Opus 的委托（由 RTC 层注入）。
    /// 返回 null 表示这一帧编码失败，直接丢弃。
    ///
    /// 为什么用委托而不是让采集器直接引用 RTC 层：
    ///   采集器不该知道 RTP / SDP 的存在 —— 它只负责「拿到干净的音频」。
    ///   这样音频链路可以脱离网络单独测试（自检就是这么做的）。
    /// </summary>
    public delegate byte[]? AudioEncodeHandler(short[] pcm);

/// <summary>
/// 麦克风采集器。一实例一设备；换设备 = Dispose 旧的 + 建新的。
/// </summary>
public sealed class MicrophoneCapture : IDisposable
{
    /// <summary>统一的工作采样率（Opus / WebRTC 标准）。</summary>
    public const int TargetSampleRate = 48000;

    /// <summary>降噪帧长。</summary>
    public const int FrameSize = 512;

    private readonly AudioFrameHandler _onFrame;
    private readonly DenoiseProcessor _denoise;

    private WaveIn? _waveIn;
    private int _sourceSampleRate;
    private bool _disposed;

    /// <summary>帧缓冲区：累积到 512 样点才交出去（不足则留在缓冲里等下一批）。</summary>
    private readonly float[] _frameBuffer = new float[FrameSize];
    private int _frameFill;

    /// <summary>重采样用的相位累加器（简单线性插值，语音够用）。</summary>
    private double _resamplePhase;
    private float _lastSample;

    public MicrophoneCapture(int deviceNumber, DenoiseProcessor denoise, AudioFrameHandler onFrame)
    {
        _denoise = denoise ?? throw new ArgumentNullException(nameof(denoise));
        _onFrame = onFrame ?? throw new ArgumentNullException(nameof(onFrame));

        // NAudio 3.0：WaveInEvent 已更名为 WaveIn。
        _waveIn = new WaveIn
        {
            // deviceNumber = -1 表示系统默认设备（NAudio 约定）
            DeviceNumber = deviceNumber < 0 ? 0 : deviceNumber,

            // 20ms 一块：比 10ms 更抗抖动，又足够低延迟。
            // 太小会放大驱动层抖动，太大则增加端到端延迟。
            BufferMilliseconds = 20,
            NumberOfBuffers = 3,
            WaveFormat = new WaveFormat(TargetSampleRate, 16, 1),
        };

        _sourceSampleRate = _waveIn.WaveFormat.SampleRate;
        _waveIn.DataAvailable += OnDataAvailable;
        _waveIn.RecordingStopped += OnRecordingStopped;
    }

    /// <summary>开始采集。失败会抛（设备被占用 / 权限等），由上层翻译成人话。</summary>
    public void Start()
    {
        PrimeDenoiserDelay();
        _waveIn?.StartRecording();
    }

    /// <summary>
    /// 用一帧静音「预热」降噪器，抵消模型的算法固有延迟。
    ///
    /// 为什么需要这一步（实测踩到的）：
    ///   DeepFilterNet3 的 STFT/合成链路有 d = frame 样点（512 @48kHz）的固有延迟。
    ///   离线处理时可以「跑完再丢掉开头 512 个样点」来对齐（自检里就是这么做的），
    ///   但**实时流里没有"跑完"这一刻**，没法事后裁剪 ——
    ///   不处理的话，本机听到的与对方听到的会差约 10.7ms，
    ///   而且模型输出的前几帧还是从零状态「爬升」出来的、带杂音。
    ///
    ///   先喂一帧静音，等于把这 d 个样点的延迟提前吃进去：
    ///   之后每一帧进来，出来的就是与它对齐的降噪结果。
    /// </summary>
    private void PrimeDenoiserDelay()
    {
        var silence = new float[FrameSize];
        _denoise.Process(silence);
    }

    public void Stop()
    {
        try
        {
            _waveIn?.StopRecording();
        }
        catch
        {
            // 设备已经拔了 / 已停止时 StopRecording 会抛，忽略即可
        }
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (_disposed || e.BytesRecorded <= 0) return;

        // 16-bit PCM → float32 [-1, 1]
        var samples = e.BytesRecorded / 2;
        for (var i = 0; i < samples; i++)
        {
            var raw = BitConverter.ToInt16(e.Buffer, i * 2);
            var value = raw / 32768f;

            // 采样率不是 48k 时先重采样（线性插值：语音场景足够，
            // 且成本远低于带抗混叠滤波的高质量重采样器）
            if (_sourceSampleRate != TargetSampleRate)
            {
                value = Resample(value);
            }

            PushSample(value);
        }
    }

    /// <summary>线性插值重采样到 48kHz。</summary>
    private float Resample(float input)
    {
        var ratio = (double)TargetSampleRate / _sourceSampleRate;
        _resamplePhase += 1.0;

        if (_resamplePhase < ratio)
        {
            _lastSample = input;
            return input;
        }

        _resamplePhase -= ratio;
        var t = (float)(_resamplePhase / ratio);
        var outSample = _lastSample + (input - _lastSample) * t;
        _lastSample = input;
        return outSample;
    }

    private void PushSample(float value)
    {
        _frameBuffer[_frameFill++] = value;
        if (_frameFill < FrameSize) return;

        _frameFill = 0;

        // 1) 降噪（512 样点一帧，与 Dfn3 帧长对齐）
        _denoise.Process(_frameBuffer);

        // 2) 交给上层（自检用：统计电平）
        _onFrame(_frameBuffer);

        // 3) 编码并发出（有 RTC 链路时才做）
        EncodeAndEmit();
    }

    /// <summary>
    /// 把降噪后的 512 样点帧重新打包成 960 样点的 Opus 包再编码。
    ///
    /// 两级帧长不一致的原因（实测）：
    ///   · 降噪（DeepFilterNet3）要求 512 样点/帧；
    ///   · Opus 要求 960 样点/20ms，给 512 会抛 OPUS_BAD_ARG。
    /// 所以这里用一个 960 长的缓冲做重分段，攒满才编一包。
    /// </summary>
    private void EncodeAndEmit()
    {
        var encoder = EncodingRequested;
        if (encoder is null) return;

        // 512 样点 → PCM16，追加进 960 的 Opus 缓冲
        for (var i = 0; i < FrameSize; i++)
        {
            // 软限幅后转 16-bit：直接硬截断在过载时会产生刺耳的削波
            var v = Math.Tanh(_frameBuffer[i]);
            _opusBuffer[_opusFill++] = (short)(v * 32000);

            if (_opusFill < OpusFrameSize) continue;

            _opusFill = 0;
            EncodeOnePacket(encoder);
        }
    }

    private void EncodeOnePacket(AudioEncodeHandler encoder)
    {
        try
        {
            var encoded = encoder(_opusBuffer);
            if (encoded is { Length: > 0 })
            {
                EncodedFrameCount++;
                LastEncodeError = null;
                EncodedFrameReady?.Invoke(this, encoded);
            }
        }
        catch (Exception ex)
        {
            // 单帧编码失败不该把采集线程带走，但也不能静默 ——
            // 「采集正常但一帧都没发出去」是最难查的一类症状，
            // 把原因留在 LastEncodeError 上，自检/日志能直接看到。
            LastEncodeError = ex;
        }
    }

    /// <summary>已编码好的一帧 Opus 数据（RTC 层订阅它并发送）。</summary>
    public event EventHandler<byte[]>? EncodedFrameReady;

    private void OnRecordingStopped(object? sender, StoppedEventArgs e)
    {
        // 采集意外停止（拔设备 / 驱动崩）时，把异常交给上层决定要不要重开
        if (e.Exception is not null)
        {
            CaptureFailed?.Invoke(this, e.Exception);
        }
    }

    /// <summary>采集链路出错（设备被拔、被独占等）。</summary>
    public event EventHandler<Exception>? CaptureFailed;

    /// <summary>
    /// Opus 编码器（由 RTC 层在建立发布链路时注入）。
    /// 为 null 时只采集不发送 —— 自检场景就是这种，不需要真的编码。
    /// </summary>
    public AudioEncodeHandler? EncodingRequested { get; set; }

    /// <summary>已成功编码并交给 RTC 层的帧数（供诊断用）。</summary>
    public long EncodedFrameCount;

    /// <summary>最近一次编码失败的原因（null = 没错过）。放出来是为了让「静默没声音」可诊断。</summary>
    public Exception? LastEncodeError { get; private set; }


    /// <summary>
    /// Opus 编码帧长：960 样点 = 20ms @48kHz。
    ///
    /// ★ 这里必须与降噪帧长（512，Dfn3 要求）解耦，不能混用。
    ///   实测：Opus 只接受合法的帧长，512 / 1024 都会被
    ///   OpusException(OPUS_BAD_ARG) 拒绝；960 才通过。
    ///   两者恰好不等，所以中间必须有一个重分段缓冲。
    /// </summary>
    private const int OpusFrameSize = 960;

    /// <summary>Opus 编码缓冲：累积到 960 样点才编一包。</summary>
    private readonly short[] _opusBuffer = new short[OpusFrameSize];
    private int _opusFill;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        if (_waveIn is not null)
        {
            _waveIn.DataAvailable -= OnDataAvailable;
            _waveIn.RecordingStopped -= OnRecordingStopped;

            try
            {
                _waveIn.StopRecording();
            }
            catch
            {
                // 忽略
            }

            _waveIn.Dispose();
            _waveIn = null;
        }
    }
}
