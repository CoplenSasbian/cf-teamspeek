using CfTeamspeed.Desktop.Services.Audio.Dsp;

namespace CfTeamspeed.Desktop.Services.Audio;

// ============================================================
//  实时降噪
//
//  ★ 先把一个概念边界说清楚（这决定了整个设计）：
//
//    本项目做的是【语音增强 / 降噪】(speech enhancement)：
//      输入 = 单声道混音（人声 + 键盘 + 风扇 + 电流声…）
//      输出 = 单声道、把非人声成分压下去
//
//    本项目【不】做、当前技术下也做不到的是【实时音源分离】
//    (source separation / stem separation)：
//      即「把说话声、键盘声、音乐声、游戏音效各自拆成独立音轨」。
//    做不到的原因不是库没选对，而是：
//      · 分离模型需要较长的时域上下文，流式分段会产生严重边界伪影；
//      · 算力差两三个数量级 —— Demucs 这类在 CPU 上实时率远低于 1；
//      · 业界所有「分轨」功能（DJ 软件、Peel Stems 等）都是对整段音频
//        预先处理一遍，没有一个是通话中实时做的。
//
//    所以「只摘出人声、其它声音都分离」在【实时通话】里无法实现；
//    真要分轨，正确形态是【服务端离线处理】（进房录音 → 出房后跑 Demucs）。
//
//  实现上给三档，都作用在同一条链路上：
//    Off    —— 直通（不做任何处理）
//    Gate   —— 语音门限：不说话时整段静音，成本最低
//    Dfn3   —— DeepFilterNet3（ONNX）神经网络降噪，效果最好
//
//  Dfn3 的模型文件不随仓库附带（约 13MB），缺失时自动降级到 Gate，
//  并在界面上说明原因 —— 绝不让「模型没下载」表现成「降噪坏了」。
// ============================================================

/// <summary>降噪档位（界面上的「设置」，可热切换）。</summary>
public enum DenoiseLevel
{
    /// <summary>关闭：直通。</summary>
    Off,

    /// <summary>轻量：只用语音门限，不用神经网络。</summary>
    Gate,

    /// <summary>神经网络降噪（DeepFilterNet3）。模型缺失时自动降级到 <see cref="Gate"/>。</summary>
    Neural,
}

/// <summary>
/// 降噪处理器。
///
/// 线程模型：<b>每个声道一个实例</b>，且只能在同一个线程上调用
/// （Dfn3 的 GRU 隐状态不是线程安全的）。采集回调固定在一个线程上跑，
/// 所以正常使用时天然满足；不要把它共享给多个采集源。
/// </summary>
public sealed class DenoiseProcessor : IDisposable
{
    /// <summary>Dfn3 的帧长：48kHz 下 512 样点 ≈ 10.67ms。</summary>
    public const int FrameSize = 512;
    public const int SampleRate = 48000;

    private readonly object _gate = new();
    private DenoiseLevel _level;
    private readonly VoiceGate _voiceGate = new();
    private Dfn3Model? _model;
    private bool _disposed;

    /// <summary>模型加载失败的原因（null = 正常）。界面据此解释「为什么没生效」。</summary>
    public string? ModelUnavailableReason { get; private set; }

    public DenoiseProcessor(DenoiseLevel level)
    {
        _level = level;
        
        EnsureModel();
    }

    /// <summary>当前档位。</summary>
    public DenoiseLevel Level
    {
        get { lock (_gate) return _level; }
    }

    /// <summary>实际生效的档位（Dfn3 模型缺失时会降级，界面要显示真实生效的那个）。</summary>
    public DenoiseLevel EffectiveLevel
    {
        get
        {
            lock (_gate)
            {
                if (_level == DenoiseLevel.Neural && _model is null) return DenoiseLevel.Gate;
                return _level;
            }
        }
    }

    /// <summary>热切换档位 —— 不需要重进房间（设置里改完立即生效）。</summary>
    public void SetLevel(DenoiseLevel level)
    {
        lock (_gate)
        {
            if (_level == level) return;
            _level = level;

            // 从「不降噪」切到「降噪」时重置门限状态，
            // 否则门限会带着切换前的电平判断，出现一小段误切。
            _voiceGate.Reset();
        }

        if (level == DenoiseLevel.Neural) EnsureModel();
    }

    private void EnsureModel()
    {
        if (_model is not null) return;

        try
        {
            var dir = Dfn3Model.ResolveModelDirectory();
            var onnx = dir is null ? null : Path.Combine(dir, "denoiser_model.onnx");
            var states = dir is null ? null : Path.Combine(dir, "initial_states.npz");

            if (onnx is null || !File.Exists(onnx) || states is null || !File.Exists(states))
            {
                ModelUnavailableReason =
                    "未找到 DeepFilterNet3 模型文件（需要 denoiser_model.onnx 与 initial_states.npz）。" +
                    "已自动降级为「语音门限」模式。";
                return;
            }

            _model = new Dfn3Model(onnx, states);
            ModelUnavailableReason = null;
        }
        catch (Exception ex)
        {
            // 模型加载失败绝不能把采集线程带走：降级 + 记录原因
            _model = null;
            ModelUnavailableReason = $"降噪模型加载失败（{ex.Message}），已降级为「语音门限」模式。";
        }
    }

    /// <summary>
    /// 处理一帧 48kHz 单声道浮点音频（原地修改 <paramref name="frame"/>）。
    ///
    /// 约定：<paramref name="frame"/> 长度必须是 <see cref="FrameSize"/>。
    /// 长度不符时直接原样返回 —— 宁可少降噪，也不要把音频切坏。
    /// </summary>
    public void Process(Span<float> frame)
    {
        if (frame.Length != FrameSize) return;

        DenoiseLevel effective;
        Dfn3Model? model;
        lock (_gate)
        {
            effective = _level == DenoiseLevel.Neural && _model is null
                ? DenoiseLevel.Gate
                : _level;
            model = _model;
        }

        switch (effective)
        {
            case DenoiseLevel.Off:
                return;

            case DenoiseLevel.Gate:
                _voiceGate.Process(frame);
                return;

            case DenoiseLevel.Neural:
                // 先过门限再上神经网络：门限能挡掉的静音段就不必浪费推理
                _voiceGate.Process(frame);
                model!.Process(frame);
                return;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _model?.Dispose();
        _model = null;
    }
}

/// <summary>
/// 把「噪音电平」换算成增益的语音门限。
///
/// 实现要点：
///   · RMS 用 dBFS 表示，与界面上的阈值同一量纲，避免换算出错；
///   · 攻击/释放分开：说话时快速打开（不能咬字），说完慢慢关闭
///     （否则句尾的尾音会被切掉，听感像「被掐断」）。
/// </summary>
internal sealed class VoiceGate
{
    /// <summary>打开阈值（dBFS）。低于它认为「在说话」。</summary>
    private const double OpenDb = -45.0;

    /// <summary>关闭阈值比打开阈值低 6dB，形成滞回，避免在阈值附近抖动。</summary>
    private const double CloseDb = OpenDb - 6.0;

    /// <summary>增益趋近目标的速度（每帧）。快开慢关。</summary>
    private const float AttackCoeff = 0.6f;
    private const float ReleaseCoeff = 0.08f;

    private float _gain = 1f;
    private bool _open = true;

    public void Reset()
    {
        _gain = 1f;
        _open = true;
    }

    public void Process(Span<float> frame)
    {
        double sum = 0;
        for (var i = 0; i < frame.Length; i++) sum += frame[i] * (double)frame[i];
        var rms = Math.Sqrt(sum / frame.Length);
        var db = rms <= 1e-9 ? -120.0 : 20.0 * Math.Log10(rms);

        // 滞回：开门后要掉到更低才关，避免在阈值附近来回跳
        if (_open)
        {
            if (db < CloseDb) _open = false;
        }
        else
        {
            if (db > OpenDb) _open = true;
        }

        var target = _open ? 1f : 0f;
        var coeff = target > _gain ? AttackCoeff : ReleaseCoeff;
        _gain += (target - _gain) * coeff;

        if (_gain >= 0.999f) return; // 全开时省掉乘法

        for (var i = 0; i < frame.Length; i++) frame[i] *= _gain;
    }
}
