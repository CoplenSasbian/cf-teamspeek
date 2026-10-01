using NAudio.Wave;
using CfTeamspeed.Desktop.Services.Audio.Dsp;

namespace CfTeamspeed.Desktop.Services.Audio;

// ============================================================
//  音频设备枚举
//
//  ★ 为什么不用 SIPSorceryMedia.Windows 里的封装：
//    它把「选设备」这件事隐藏了（内部直接用 WaveIn 默认设备），
//    而本项目明确要求「能够切换设置」（换麦克风 / 换扬声器）。
//    所以设备层直接用 NAudio 走 WaveIn/WaveOut，把 device number 握在手里，
//    SIPSorcery 只用在 RTP / Opus 那一层的编解码与传输上。
//
//  设备 id 用「编号 + 名称」组合：
//    纯编号在换 USB 设备后会漂移（插拔顺序变了编号就变），
//    纯名称会重名（两块同名耳机会选错）。
//    组合起来既不漂移、也能让用户看清是哪个。
// ============================================================

/// <summary>一个音频设备（输入或输出）。</summary>
public sealed record AudioDevice(int Number, string Name)
{
    /// <summary>持久化用的稳定 id：编号 + 名称。</summary>
    public string Id => $"{Number}|{Name}";

    public override string ToString() => Name;
}

/// <summary>设备枚举（麦克风 / 扬声器）。</summary>
public static class AudioDevices
{
    /// <summary>列出可用的录音设备（麦克风）。</summary>
    public static IReadOnlyList<AudioDevice> Inputs()
    {
        var list = new List<AudioDevice>();
        try
        {
            var count = WaveIn.DeviceCount;
            for (var i = 0; i < count; i++)
            {
                var caps = WaveIn.GetCapabilities(i);
                list.Add(new AudioDevice(i, caps.ProductName));
            }
        }
        catch
        {
            // 没装声卡 / 驱动异常时返回空表，让界面显示「未找到设备」而不是崩
        }

        return list;
    }

    /// <summary>列出可用的播放设备（扬声器）。</summary>
    public static IReadOnlyList<AudioDevice> Outputs()
    {
        var list = new List<AudioDevice>();
        try
        {
            var count = WaveOut.DeviceCount;
            for (var i = 0; i < count; i++)
            {
                var caps = WaveOut.GetCapabilities(i);
                list.Add(new AudioDevice(i, caps.ProductName));
            }
        }
        catch
        {
            // 同上
        }

        return list;
    }

    /// <summary>
    /// 把持久化的设备 id 解析成当前存在的设备编号。
    /// 找不到（设备拔了 / 编号变了）时返回 null —— 调用方退化为「系统默认」，
    /// 而不是报错，这样换设备不会让语音直接不可用。
    /// </summary>
    public static int? Resolve(IReadOnlyList<AudioDevice> available, string? savedId, string? savedName)
    {
        if (string.IsNullOrWhiteSpace(savedId)) return null;

        // 先按完整 id 匹配（最精确）
        var exact = available.FirstOrDefault(d => string.Equals(d.Id, savedId, StringComparison.Ordinal));
        if (exact is not null) return exact.Number;

        // 再按名称匹配（设备插到了别的编号上）
        if (!string.IsNullOrWhiteSpace(savedName))
        {
            var byName = available.FirstOrDefault(d =>
                string.Equals(d.Name, savedName, StringComparison.Ordinal));
            if (byName is not null) return byName.Number;
        }

        return null;
    }
}
