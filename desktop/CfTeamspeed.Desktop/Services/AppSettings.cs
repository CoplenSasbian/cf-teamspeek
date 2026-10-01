using System.Text.Json;
using System.Text.Json.Serialization;
using CfTeamspeed.Desktop.Models;

namespace CfTeamspeed.Desktop.Services;

// ============================================================
//  本地偏好设置（与服务器无关的那部分）
//
//  与 ServerProfile 的分工：
//    - 这里 = 这台电脑上的界面/音频偏好，跨服务器共享；
//    - servers.json = 每台服务器各自的凭据与身份。
//  两者都落在 %LOCALAPPDATA%\CfTeamspeed\，都用原子写。
// ============================================================

/// <summary>界面主题。</summary>
public enum AppTheme
{
    System,
    Light,
    Dark,
}

/// <summary>按 uid 记住的音量偏好（重启后仍在）。</summary>
public sealed class VolumeSettings
{
    /// <summary>自己的录制音量，0..2（1 = 原始增益）。</summary>
    [JsonPropertyName("mic")]
    public double Mic { get; set; } = 1.0;

    /// <summary>总播放音量，0..2。</summary>
    [JsonPropertyName("master")]
    public double Master { get; set; } = 1.0;

    /// <summary>uid → 该成员的播放音量。</summary>
    [JsonPropertyName("users")]
    public Dictionary<string, double> Users { get; set; } = new(StringComparer.Ordinal);

    /// <summary>被我单独静音的 uid。</summary>
    [JsonPropertyName("mutedUsers")]
    public List<string> MutedUsers { get; set; } = new();
}

/// <summary>麦克风降噪引擎（与网页端同一套取值）。</summary>
public enum DenoiseEngine
{
    Off,
    Gtcrn,
    Rnnoise,
    Dfn3,
}

public sealed class DenoiseSettings
{
    [JsonPropertyName("engine")]
    public DenoiseEngine Engine { get; set; } = DenoiseEngine.Off;
}

/// <summary>
/// 浏览器/系统自带的麦克风处理开关。
///
/// 它们作用在采集层，<b>在</b>降噪之前，所以与 GTCRN 是串联关系：
/// 两个降噪叠加容易出水声/抽吸感，AGC 又和本地响度补偿在做同一件事。
/// 是否划算只能在具体设备上试听，因此做成开关，默认全开（与网页端历史行为一致）。
/// </summary>
public sealed class MicInputSettings
{
    [JsonPropertyName("noiseSuppression")]
    public bool NoiseSuppression { get; set; } = true;

    [JsonPropertyName("autoGainControl")]
    public bool AutoGainControl { get; set; } = true;

    /// <summary>语音门限：低于阈值整段不发。</summary>
    [JsonPropertyName("gate")]
    public VoiceGateSettings Gate { get; set; } = new();
}

/// <summary>
/// 语音门限。
///
/// 语义：门检测电平<b>低于</b>阈值时整段不发送（增益归零）；
/// 高于阈值时逐样本原样通过（增益精确等于 1），所以它不改变说话音量。
/// 默认关 —— 它会在你不说话时把麦克风彻底切断，是个有存在感的开关。
/// </summary>
public sealed class VoiceGateSettings
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }

    /// <summary>阈值（dBFS，-100..0）。越接近 0 越激进。</summary>
    [JsonPropertyName("thresholdDb")]
    public double ThresholdDb { get; set; } = -45;
}

/// <summary>
/// 本地偏好设置。<b>不含任何服务器凭据</b> —— token / key 一律在 servers.json。
/// </summary>
public sealed class AppSettings
{
    // ---- 上次登录表单的残留（方便重输，非凭据） ----

    /// <summary>上次用的昵称；添加服务器或重新登录时预填。</summary>
    [JsonPropertyName("nickname")]
    public string Nickname { get; set; } = "";

    [JsonPropertyName("avatarId")]
    public string? AvatarId { get; set; }

    // ---- 服务器栏 ----

    /// <summary>当前选中的服务器 Id（对应 ServerProfile.Id）。</summary>
    [JsonPropertyName("selectedServerId")]
    public string? SelectedServerId { get; set; }

    // ---- 音频 ----

    [JsonPropertyName("volumes")]
    public VolumeSettings Volumes { get; set; } = new();

    /// <summary>自己是否处于静音（关麦）。跨重启保留，符合直觉。</summary>
    [JsonPropertyName("muted")]
    public bool Muted { get; set; }

    /// <summary>是否开启耳返（听自己）。默认关，否则容易啸叫。</summary>
    [JsonPropertyName("monitorSelf")]
    public bool MonitorSelf { get; set; }

    [JsonPropertyName("denoise")]
    public DenoiseSettings Denoise { get; set; } = new();

    [JsonPropertyName("input")]
    public MicInputSettings Input { get; set; } = new();

    /// <summary>首选输入设备 id；为空表示跟随系统默认。</summary>
    [JsonPropertyName("inputDeviceId")]
    public string? InputDeviceId { get; set; }

    /// <summary>
    /// 首选输入设备名（与 id 一起存）。
    ///
    /// 为什么要同时存名字：设备 id 里带的是**枚举序号**，
    /// 插拔一个 USB 麦克风就会让后面所有设备的序号漂移，
    /// 只按序号找会选错设备。名字用于「序号变了但设备还在」时兜底重定位。
    /// </summary>
    [JsonPropertyName("inputDeviceName")]
    public string? InputDeviceName { get; set; }

    /// <summary>首选输出设备 id；为空表示跟随系统默认。</summary>
    [JsonPropertyName("outputDeviceId")]
    public string? OutputDeviceId { get; set; }

    /// <summary>首选输出设备名（理由同 <see cref="InputDeviceName"/>）。</summary>
    [JsonPropertyName("outputDeviceName")]
    public string? OutputDeviceName { get; set; }

    // ---- 在线状态 ----

    /// <summary>展示给别人的在线状态（不含 offline）。</summary>
    [JsonPropertyName("presenceStatus")]
    public PresenceStatus PresenceStatus { get; set; } = PresenceStatus.Online;

    /// <summary>是否允许别人邀请我进房间。</summary>
    [JsonPropertyName("invitable")]
    public bool Invitable { get; set; } = true;

    // ---- 界面 ----

    [JsonPropertyName("theme")]
    public AppTheme Theme { get; set; } = AppTheme.System;

    /// <summary>界面音效（进出房、被邀请），默认开。</summary>
    [JsonPropertyName("soundEffects")]
    public bool SoundEffects { get; set; } = true;

    /// <summary>窗口宽度（像素）。0 = 用默认值。</summary>
    [JsonPropertyName("windowWidth")]
    public double WindowWidth { get; set; }

    [JsonPropertyName("windowHeight")]
    public double WindowHeight { get; set; }

    /// <summary>成员栏是否展开（用户可能想收起多留点舞台空间）。</summary>
    [JsonPropertyName("memberRailVisible")]
    public bool MemberRailVisible { get; set; } = true;
}

/// <summary>
/// 设置的持久化服务。
///
/// 与 ServerStore 同一套路：单实例内存缓存 + SemaphoreSlim + 原子写。
/// 差异在于设置是「低频写、随时读」，所以额外提供同步的 <see cref="Current"/> 快照。
/// </summary>
public sealed class SettingsService
{
    private const string FileName = "settings.json";

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        // 枚举写成字符串，方便用户手工改配置文件，也避免将来枚举顺序变化破坏存档
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _filePath;
    private AppSettings? _cache;

    public SettingsService()
        : this(AppPaths.Combine(FileName))
    {
    }

    public SettingsService(string filePath)
    {
        _filePath = filePath;
    }

    public string FilePath => _filePath;

    /// <summary>
    /// 当前设置的可变引用。
    ///
    /// 首次访问会同步加载（构造后立刻要用，没什么好等的）。
    /// 改完记得调 <see cref="SaveAsync"/> —— 这里不做自动保存，
    /// 因为高频滑杆（音量）如果每次都落盘会把磁盘写爆。
    /// </summary>
    public AppSettings Current
    {
        get
        {
            if (_cache is not null) return _cache;

            // 同步等待一次异步加载：仅在首次访问时发生，不会造成死锁（无同步上下文依赖）
            _cache = LoadSync();
            return _cache;
        }
    }

    /// <summary>显式加载（应用启动时调一次，把加载失败的情况早早暴露出来）。</summary>
    public async Task<AppSettings> LoadAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _cache ??= await AppPaths.ReadJsonOrNullAsync<AppSettings>(_filePath, SerializerOptions, ct)
                .ConfigureAwait(false) ?? new AppSettings();
            Normalize(_cache);
            return _cache;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>把当前设置写盘（原子写）。</summary>
    public async Task SaveAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _cache ??= new AppSettings();
            Normalize(_cache);
            await AppPaths.WriteJsonAtomicAsync(_filePath, _cache, SerializerOptions, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>改一组字段并立刻落盘（低频调用场景用起来最省心）。</summary>
    public async Task UpdateAsync(Action<AppSettings> mutate, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(mutate);

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _cache ??= new AppSettings();
            mutate(_cache);
            Normalize(_cache);
            await AppPaths.WriteJsonAtomicAsync(_filePath, _cache, SerializerOptions, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    private AppSettings LoadSync()
    {
        try
        {
            if (!File.Exists(_filePath)) return new AppSettings();

            var json = File.ReadAllText(_filePath);
            if (string.IsNullOrWhiteSpace(json)) return new AppSettings();

            var parsed = JsonSerializer.Deserialize<AppSettings>(json, SerializerOptions) ?? new AppSettings();
            Normalize(parsed);
            return parsed;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            AppPaths.BackupCorruptFile(_filePath);
            return new AppSettings();
        }
    }

    /// <summary>
    /// 修正越界 / 缺失的值。
    ///
    /// 配置文件是可以被手工编辑的（也可被旧版本写坏），
    /// 界面层不该为「音量 = 50」这种输入做防御，统一在这里夹紧。
    /// </summary>
    private static void Normalize(AppSettings settings)
    {
        settings.Volumes ??= new VolumeSettings();
        settings.Volumes.Users ??= new Dictionary<string, double>(StringComparer.Ordinal);
        settings.Volumes.MutedUsers ??= new List<string>();
        settings.Denoise ??= new DenoiseSettings();
        settings.Input ??= new MicInputSettings();
        settings.Input.Gate ??= new VoiceGateSettings();

        settings.Volumes.Mic = Clamp(settings.Volumes.Mic, 0, 2, 1.0);
        settings.Volumes.Master = Clamp(settings.Volumes.Master, 0, 2, 1.0);

        foreach (var key in settings.Volumes.Users.Keys.ToList())
        {
            settings.Volumes.Users[key] = Clamp(settings.Volumes.Users[key], 0, 2, 1.0);
        }

        settings.Input.Gate.ThresholdDb = Clamp(settings.Input.Gate.ThresholdDb, -100, 0, -45);

        if (settings.WindowWidth < 0) settings.WindowWidth = 0;
        if (settings.WindowHeight < 0) settings.WindowHeight = 0;

        // 在线状态不该是 offline（那是「未连接」的意思，不能自己选）
        if (settings.PresenceStatus == PresenceStatus.Offline)
        {
            settings.PresenceStatus = PresenceStatus.Online;
        }
    }

    private static double Clamp(double value, double min, double max, double fallback)
    {
        if (double.IsNaN(value) || double.IsInfinity(value)) return fallback;
        return Math.Min(max, Math.Max(min, value));
    }
}
