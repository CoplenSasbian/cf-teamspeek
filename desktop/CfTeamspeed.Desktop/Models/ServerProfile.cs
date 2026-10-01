using System.Text.Json;
using System.Text.Json.Serialization;
using CfTeamspeed.Desktop.Services;

namespace CfTeamspeed.Desktop.Models;

// ============================================================
//  多服务器模型
//
//  这是桌面端与网页端唯一的结构性差异：网页端「一个部署 = 一台服务器」，
//  桌面端可以同时挂多台。因此每台服务器各自持有一份独立的：
//    baseUrl / key / token / 到期时间 / 昵称 / 头像。
//
//  ★ 铁律：token 与 key 都是【按服务器隔离】的，任何跨服务器的复用
//    都会造成串号（A 的 token 打到 B 上）。ApiClient 必须是实例级，
//    不允许出现静态的 currentToken。
// ============================================================

/// <summary>
/// 一台已添加的服务器及其会话凭据。
///
/// 该类是<b>可变</b>的（token 会被滚动续期频繁改写），
/// 但所有写操作都必须经由 <see cref="ServerStore"/>，以保证落盘与加锁。
/// </summary>
public sealed class ServerProfile
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>展示名（服务器图标下方的名字 / 提示）。用户可改，不影响连接。</summary>
    [JsonPropertyName("displayName")]
    public string DisplayName { get; set; } = "";

    /// <summary>服务基址，形如 https://xxx.workers.dev，末尾不带斜杠。</summary>
    [JsonPropertyName("baseUrl")]
    public string BaseUrl { get; set; } = "";

    /// <summary>访问 key（访客 key 或管理员 key）。与 token 一样按服务器隔离。</summary>
    [JsonPropertyName("key")]
    public string Key { get; set; } = "";

    /// <summary>当前 Bearer token。为空 = 未登录（或已被清掉）。</summary>
    [JsonPropertyName("sessionToken")]
    public string? SessionToken { get; set; }

    /// <summary>token 的滚动过期时间（Unix 秒）。</summary>
    [JsonPropertyName("tokenExpiresAt")]
    public long TokenExpiresAt { get; set; }

    /// <summary>会话绝对上限（Unix 秒）；到点只能用 key 重新登录。</summary>
    [JsonPropertyName("sessionHardExpiresAt")]
    public long SessionHardExpiresAt { get; set; }

    [JsonPropertyName("nickname")]
    public string Nickname { get; set; } = "";

    [JsonPropertyName("avatarId")]
    public string? AvatarId { get; set; }

    /// <summary>服务器栏里的排序位（越小越靠前），允许重复，稳定排序兜底用 Id。</summary>
    [JsonPropertyName("sortOrder")]
    public int SortOrder { get; set; }

    /// <summary>最后使用时间（Unix 秒），用于启动时自动选中上次那台。</summary>
    [JsonPropertyName("lastUsedAt")]
    public long LastUsedAt { get; set; }

    // --------------------------------------------------------
    //  计算属性（不参与序列化）
    // --------------------------------------------------------

    /// <summary>解析后的 BaseUri；BaseUrl 非法时返回 null。</summary>
    [JsonIgnore]
    public Uri? BaseUri =>
        Uri.TryCreate(BaseUrl, UriKind.Absolute, out var uri) ? uri : null;

    /// <summary>
    /// 提示用的主机名（服务器图标 tooltip / 同主机多服务器时的区分）。
    /// 解析失败时退回原始字符串，绝不返回空 —— 界面上空 tooltip 比错 tooltip 更糟。
    /// </summary>
    [JsonIgnore]
    public string HostDisplay
    {
        get
        {
            var uri = BaseUri;
            if (uri is null) return string.IsNullOrWhiteSpace(BaseUrl) ? "(未设置地址)" : BaseUrl;
            // 非默认端口要带上，否则同一主机的两个不同端口无法区分
            return uri.IsDefaultPort ? uri.Host : $"{uri.Host}:{uri.Port}";
        }
    }

    /// <summary>是否持有凭据（不代表还没过期）。</summary>
    [JsonIgnore]
    public bool HasToken => !string.IsNullOrEmpty(SessionToken);

    /// <summary>
    /// token 是否仍然有效。
    ///
    /// 注意 <c>TokenExpiresAt == 0</c> 的语义：老版本存档或服务端只给
    /// <c>X-Refreshed-Token</c> 头时可能拿不到到期时间。此时不能武断判成失效
    /// （会让用户每次启动都被踢去重新登录），因此按「有 token 就算有效」，
    /// 靠服务端 401 与到期后的续期来纠正。
    /// </summary>
    [JsonIgnore]
    public bool IsTokenValid =>
        HasToken && (TokenExpiresAt <= 0 || UnixTime.Now < TokenExpiresAt);

    /// <summary>
    /// 是否需要在 5 分钟内续期（滚动续期窗口）。
    ///
    /// 之所以在本地提前判断、而不是等 401：token 一旦过期，
    /// 那些高频请求（心跳 / 轮询）会整批失败，界面会闪一下「掉线」。
    ///
    /// 到期时间未知（&lt;= 0）时<b>不</b>主动续期：那种情况下每次调用都会判定为
    /// 「临期」，会导致每个请求前都白发一次 refresh。交给服务端
    /// <c>X-Refreshed-Token</c> 滚动续期即可，它必然会带上新的到期时间。
    /// </summary>
    [JsonIgnore]
    public bool NeedsRefresh
    {
        get
        {
            if (!HasToken) return false;
            if (TokenExpiresAt <= 0) return false;
            return TokenExpiresAt - UnixTime.Now <= RefreshWindowSeconds;
        }
    }

    /// <summary>
    /// 会话是否已经触到绝对上限（此时 refresh 也救不回来，必须重新用 key 登录）。
    /// </summary>
    [JsonIgnore]
    public bool IsSessionHardExpired =>
        SessionHardExpiresAt > 0 && UnixTime.Now >= SessionHardExpiresAt;

    /// <summary>续期窗口：5 分钟。</summary>
    public const long RefreshWindowSeconds = 5 * 60;

    /// <summary>复制一份（用于在锁外安全读取，避免边改边读）。</summary>
    public ServerProfile Clone() => new()
    {
        Id = Id,
        DisplayName = DisplayName,
        BaseUrl = BaseUrl,
        Key = Key,
        SessionToken = SessionToken,
        TokenExpiresAt = TokenExpiresAt,
        SessionHardExpiresAt = SessionHardExpiresAt,
        Nickname = Nickname,
        AvatarId = AvatarId,
        SortOrder = SortOrder,
        LastUsedAt = LastUsedAt,
    };

    /// <summary>界面展示名：优先用户命名，其次昵称，最后退回主机名。</summary>
    public string ResolveDisplayName()
    {
        if (!string.IsNullOrWhiteSpace(DisplayName)) return DisplayName;
        if (!string.IsNullOrWhiteSpace(Nickname)) return Nickname;
        return HostDisplay;
    }

    /// <summary>规范化 BaseUrl：补 scheme、去尾斜杠。返回 null 表示无法解析。</summary>
    public static string? NormalizeBaseUrl(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var text = raw.Trim();

        // 用户常只敲 "example.workers.dev"，补一个 https 更符合直觉
        if (!text.Contains("://", StringComparison.Ordinal))
        {
            text = "https://" + text;
        }

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;

        // 只保留 scheme://host[:port]，丢掉路径/query/fragment —— API 路径是固化的
        var builder = new UriBuilder(uri) { Path = "", Query = "", Fragment = "" };
        return builder.Uri.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped);
    }
}

/// <summary>Unix 秒工具。集中一处，避免各处 DateTimeOffset 换算写法不一致。</summary>
public static class UnixTime
{
    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    public static DateTimeOffset FromUnixSeconds(long seconds) =>
        DateTimeOffset.FromUnixTimeSeconds(seconds);

    /// <summary>可空版本：null / 0 都视为「未知」，返回 null 便于界面显示「—」。</summary>
    public static DateTimeOffset? FromUnixSecondsOrNull(long seconds) =>
        seconds > 0 ? DateTimeOffset.FromUnixTimeSeconds(seconds) : null;
}

/// <summary>
/// 多服务器档案的持久化。
///
/// 存到 <c>%LOCALAPPDATA%\CfTeamspeed\servers.json</c>。
/// 设计要点：
///   1. 原子写：先写 .tmp 再 File.Replace/Move —— 断电或崩溃时不至于把档案截断成半个文件；
///   2. 坏档案不抛异常：备份成 servers.json.corrupt-<时间戳> 后从空档案重建，
///      宁可让用户重新添加服务器，也不能让程序起不来；
///   3. 线程安全：所有读写走同一个 SemaphoreSlim；
///   4. 内存里持有唯一的一份 List，读接口返回副本，避免调用方拿到会被后台改写的对象。
/// </summary>
public sealed class ServerStore
{
    private const string FileName = "servers.json";

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _filePath;
    private List<ServerProfile>? _cache;

    /// <summary>默认路径：%LOCALAPPDATA%\CfTeamspeed\servers.json。</summary>
    public ServerStore()
        : this(Path.Combine(AppPaths.DataDirectory, FileName))
    {
    }

    /// <summary>指定路径（测试 / 多实例隔离用）。</summary>
    public ServerStore(string filePath)
    {
        _filePath = filePath;
    }

    /// <summary>档案文件路径（诊断 / 界面「打开所在文件夹」用）。</summary>
    public string FilePath => _filePath;

    /// <summary>读取全部服务器（按 SortOrder 排序的副本）。</summary>
    public async Task<IReadOnlyList<ServerProfile>> LoadAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var list = await EnsureLoadedLockedAsync(ct).ConfigureAwait(false);
            return Snapshot(list);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>按 Id 取一台（不存在返回 null）。</summary>
    public async Task<ServerProfile?> GetAsync(string id, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(id)) return null;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var list = await EnsureLoadedLockedAsync(ct).ConfigureAwait(false);
            var found = list.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.Ordinal));
            return found?.Clone();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// 新增一台服务器。返回落盘后的对象（已分配 Id / SortOrder）。
    /// 若同 baseUrl 已存在，则直接返回既有项而不重复添加 ——
    /// 桌面端同一台服务器只应该出现一个图标。
    /// </summary>
    public async Task<ServerProfile> AddAsync(ServerProfile profile, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(profile);

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var list = await EnsureLoadedLockedAsync(ct).ConfigureAwait(false);

            if (string.IsNullOrEmpty(profile.Id)) profile.Id = Guid.NewGuid().ToString("N");

            var normalized = ServerProfile.NormalizeBaseUrl(profile.BaseUrl);
            if (normalized is not null)
            {
                var existing = list.FirstOrDefault(s =>
                    string.Equals(
                        ServerProfile.NormalizeBaseUrl(s.BaseUrl),
                        normalized,
                        StringComparison.OrdinalIgnoreCase));

                if (existing is not null)
                {
                    // 已存在：不新建图标，但把这次带进来的凭据并进去（相等语义按服务器算）
                    if (!string.IsNullOrEmpty(profile.SessionToken)) existing.SessionToken = profile.SessionToken;
                    if (profile.TokenExpiresAt > 0) existing.TokenExpiresAt = profile.TokenExpiresAt;
                    if (profile.SessionHardExpiresAt > 0) existing.SessionHardExpiresAt = profile.SessionHardExpiresAt;
                    if (!string.IsNullOrWhiteSpace(profile.Nickname)) existing.Nickname = profile.Nickname;
                    if (!string.IsNullOrWhiteSpace(profile.Key)) existing.Key = profile.Key;
                    if (!string.IsNullOrWhiteSpace(profile.DisplayName)) existing.DisplayName = profile.DisplayName;
                    if (profile.LastUsedAt > 0) existing.LastUsedAt = profile.LastUsedAt;

                    await SaveLockedAsync(list, ct).ConfigureAwait(false);
                    return existing.Clone();
                }

                profile.BaseUrl = normalized;
            }

            if (profile.SortOrder == 0 && list.Count > 0)
            {
                profile.SortOrder = list.Max(s => s.SortOrder) + 1;
            }
            if (profile.LastUsedAt <= 0) profile.LastUsedAt = UnixTime.Now;

            list.Add(profile);
            await SaveLockedAsync(list, ct).ConfigureAwait(false);
            return profile.Clone();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// 局部更新一台服务器。
    ///
    /// 用「传入一个改字段的委托」而不是「传入一个完整对象」：
    /// token 续期是高频写，若用整对象覆盖，很容易把并发写入的其它字段冲掉。
    /// </summary>
    public async Task<bool> UpdateAsync(
        string id,
        Action<ServerProfile> mutate,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(mutate);
        if (string.IsNullOrEmpty(id)) return false;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var list = await EnsureLoadedLockedAsync(ct).ConfigureAwait(false);
            var target = list.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.Ordinal));
            if (target is null) return false;

            mutate(target);
            await SaveLockedAsync(list, ct).ConfigureAwait(false);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>删除一台服务器。返回是否真的删掉了。</summary>
    public async Task<bool> RemoveAsync(string id, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(id)) return false;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var list = await EnsureLoadedLockedAsync(ct).ConfigureAwait(false);
            var removed = list.RemoveAll(s => string.Equals(s.Id, id, StringComparison.Ordinal));
            if (removed == 0) return false;

            await SaveLockedAsync(list, ct).ConfigureAwait(false);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// 只清掉某台服务器的会话凭据，保留 key / 昵称 / 显示名 —— 方便用户直接重新登录。
    /// 会话失效（401）与封禁（BANNED）走的都是这里。
    /// </summary>
    public Task<bool> ClearSessionAsync(string id, CancellationToken ct = default)
        => UpdateAsync(id, s =>
        {
            s.SessionToken = null;
            s.TokenExpiresAt = 0;
            s.SessionHardExpiresAt = 0;
        }, ct);

    /// <summary>按给定顺序重排（列表里没出现的服务器保持原有相对次序，排在后面）。</summary>
    public async Task ReorderAsync(IReadOnlyList<string> orderedIds, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(orderedIds);

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var list = await EnsureLoadedLockedAsync(ct).ConfigureAwait(false);
            var index = 0;
            foreach (var id in orderedIds)
            {
                var target = list.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.Ordinal));
                if (target is not null) target.SortOrder = index++;
            }
            foreach (var rest in list.Where(s => !orderedIds.Contains(s.Id, StringComparer.Ordinal)))
            {
                rest.SortOrder = index++;
            }

            await SaveLockedAsync(list, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>标记「最后使用」，影响下次启动自动选中的服务器。</summary>
    public Task TouchAsync(string id, CancellationToken ct = default)
        => UpdateAsync(id, s => s.LastUsedAt = UnixTime.Now, ct);

    /// <summary>把内存里的当前状态强制写盘（退出前调用；正常写路径已经落盘，这里只是兜底）。</summary>
    public async Task FlushAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_cache is null) return;
            await SaveLockedAsync(_cache, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    // --------------------------------------------------------
    //  内部实现（全部要求已持有 _gate）
    // --------------------------------------------------------

    private async Task<List<ServerProfile>> EnsureLoadedLockedAsync(CancellationToken ct)
    {
        if (_cache is not null) return _cache;

        _cache = await ReadFromDiskAsync(ct).ConfigureAwait(false);
        return _cache;
    }

    private async Task<List<ServerProfile>> ReadFromDiskAsync(CancellationToken ct)
    {
        try
        {
            if (!File.Exists(_filePath)) return new List<ServerProfile>();

            var json = await File.ReadAllTextAsync(_filePath, ct).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(json)) return new List<ServerProfile>();

            var list = JsonSerializer.Deserialize<List<ServerProfile>>(json, SerializerOptions);
            if (list is null) return new List<ServerProfile>();

            // 丢掉明显损坏的条目（缺 Id / 缺地址），剩下的仍然可用
            list.RemoveAll(s => s is null || string.IsNullOrEmpty(s.Id));
            foreach (var item in list)
            {
                if (string.IsNullOrWhiteSpace(item.DisplayName))
                {
                    item.DisplayName = item.ResolveDisplayName();
                }
            }

            return list;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            // ★ 关键：坏档案绝不能让程序起不来。备份后从空档案继续。
            BackupCorruptFile();
            return new List<ServerProfile>();
        }
    }

    private void BackupCorruptFile()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var backup = $"{_filePath}.corrupt-{stamp}";
            File.Copy(_filePath, backup, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 备份都失败就只能放弃，绝不能因此抛出
        }
    }

    private Task SaveLockedAsync(List<ServerProfile> list, CancellationToken ct)
    {
        var snapshot = Snapshot(list);
        return AppPaths.WriteJsonAtomicAsync(_filePath, snapshot, SerializerOptions, ct);
    }

    /// <summary>排序 + 深拷贝：调用方永远拿不到会被后台改写的对象。</summary>
    private static List<ServerProfile> Snapshot(List<ServerProfile> list)
        => list
            .OrderBy(s => s.SortOrder)
            .ThenBy(s => s.LastUsedAt)
            .ThenBy(s => s.Id, StringComparer.Ordinal)
            .Select(s => s.Clone())
            .ToList();
}
