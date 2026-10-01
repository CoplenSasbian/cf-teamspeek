using CfTeamspeed.Desktop.Models;
using Microsoft.UI.Dispatching;

namespace CfTeamspeed.Desktop.Services;

// ============================================================
//  多服务器总控
//
//  这是桌面端相对 Web 端【多出来的那一层】。
//  Web 端一个部署就是一台服务器，所以它只有「当前会话」这一个概念；
//  桌面端要同时管理 N 台，每台各自独立登录、独立心跳、独立房间列表。
//
//  设计取舍：
//    - 所有服务器【并行】跑各自的循环，不做「只激活当前服务器」的懒加载。
//      理由：服务器栏上要显示每台的在线人数/未读邀请，窗口期不连接就拿不到；
//      而这些循环都是 6~15 秒一次的小请求，N 台也就 N 倍，私人使用量级完全够。
//    - 离开的服务器不会被登出：切服务器只是切「界面在看哪一台」，
//      后台心跳继续跑，这样切回来是即时的。
// ============================================================

/// <summary>
/// 所有服务器的编排器。
///
/// 生命周期与主窗口一致：窗口创建时构造，关闭时 <see cref="DisposeAsync"/>。
/// </summary>
public sealed class ServerManager : IAsyncDisposable
{
    private readonly ServerStore _store;
    private readonly SettingsService _settings;

    /// <summary>id → 会话。用字典而不是列表：切换服务器要 O(1) 查找。</summary>
    private readonly Dictionary<string, ServerSession> _sessions = new(StringComparer.Ordinal);

    /// <summary>保护 _sessions 与 _activeId（会话本身内部有自己的锁）。</summary>
    private readonly object _gate = new();

    private string? _activeId;
    private bool _disposed;

    public ServerManager(ServerStore store, SettingsService settings)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _settings = settings ?? throw new ArgumentNullException(nameof(settings));
    }

    /// <summary>档案持久化（设置界面「打开数据目录」等会用到）。</summary>
    public ServerStore Store => _store;

    /// <summary>服务器集合发生变化（增 / 删 / 改名 / 排序）。</summary>
    public event EventHandler? ServersChanged;

    /// <summary>当前激活的服务器发生变化。</summary>
    public event EventHandler<string?>? ActiveServerChanged;

    /// <summary>任意一台服务器的数据或状态发生变化（界面统一刷新）。</summary>
    public event EventHandler<ServerStateChangedEventArgs>? ServerStateChanged;

    /// <summary>任意一台服务器收到房间邀请。</summary>
    public event EventHandler<ServerInviteEventArgs>? Invited;

    // --------------------------------------------------------
    //  启动
    // --------------------------------------------------------

    /// <summary>
    /// 载入全部服务器并为每台启动会话。
    ///
    /// 启动后自动激活「上次使用的那台」；没有历史则激活第一台。
    /// 一台都没有时什么都不做（界面会显示「添加服务器」引导）。
    /// </summary>
    public async Task InitializeAsync(CancellationToken ct = default)
    {
        ThrowIfDisposed();

        var profiles = await _store.LoadAsync(ct).ConfigureAwait(false);

        foreach (var profile in profiles)
        {
            await EnsureSessionAsync(profile, ct).ConfigureAwait(false);
        }

        // 优先用设置里记住的那台；它可能已被删除，那就退回最近使用的
        var settings = await _settings.LoadAsync(ct).ConfigureAwait(false);
        var target = ResolveInitialActive(profiles, settings.SelectedServerId);

        if (target is not null)
        {
            await SetActiveAsync(target, ct).ConfigureAwait(false);
        }

        RaiseServersChanged();
    }

    private static string? ResolveInitialActive(
        IReadOnlyList<ServerProfile> profiles,
        string? remembered)
    {
        if (profiles.Count == 0) return null;

        if (!string.IsNullOrEmpty(remembered) &&
            profiles.Any(p => string.Equals(p.Id, remembered, StringComparison.Ordinal)))
        {
            return remembered;
        }

        return profiles
            .OrderByDescending(p => p.LastUsedAt)
            .FirstOrDefault()?.Id;
    }

    // --------------------------------------------------------
    //  读取
    // --------------------------------------------------------

    /// <summary>当前激活的服务器 id（没有则为 null）。</summary>
    public string? ActiveServerId
    {
        get { lock (_gate) return _activeId; }
    }

    /// <summary>当前激活的会话（没有则为 null）。</summary>
    public ServerSession? Active
    {
        get
        {
            lock (_gate)
            {
                return _activeId is not null && _sessions.TryGetValue(_activeId, out var s) ? s : null;
            }
        }
    }

    /// <summary>服务器栏按 SortOrder 渲染用的快照。</summary>
    public IReadOnlyList<ServerSession> Sessions
    {
        get
        {
            lock (_gate)
            {
                return _sessions.Values
                    .OrderBy(s => s.Profile.SortOrder)
                    .ThenBy(s => s.Profile.LastUsedAt)
                    .ToList();
            }
        }
    }

    public ServerSession? Find(string serverId)
    {
        if (string.IsNullOrEmpty(serverId)) return null;
        lock (_gate)
        {
            return _sessions.TryGetValue(serverId, out var s) ? s : null;
        }
    }

    // --------------------------------------------------------
    //  增 / 删 / 切换
    // --------------------------------------------------------

    /// <summary>
    /// 添加一台服务器：探测地址 → 落盘 → 建会话 → 激活。
    ///
    /// 探测用公开的 <c>/api/auth/config</c>，因此**不需要 key** 就能加入列表，
    /// 并顺手把服务端的 <c>appName</c> 拿来当默认显示名。
    /// 探测失败不阻止添加（但会告知用户），因为用户可能想先存着稍后再连。
    /// </summary>
    public async Task<ServerSession> AddServerAsync(
        string baseUrl,
        string? displayName = null,
        string? key = null,
        CancellationToken ct = default)
    {
        ThrowIfDisposed();

        var normalized = ServerProfile.NormalizeBaseUrl(baseUrl)
            ?? throw new ApiException($"服务器地址无法解析：{baseUrl}");

        var profile = new ServerProfile
        {
            BaseUrl = normalized,
            Key = key?.Trim() ?? string.Empty,
            DisplayName = displayName?.Trim() ?? string.Empty,
            SortOrder = int.MaxValue, // 交给 Store 追加到末尾
            LastUsedAt = UnixTime.Now,
        };

        // 免登录探测：拿 appName 当显示名 + 确认地址可达
        var probeApi = new ApiClient(profile);
        try
        {
            var config = await ServerSession.ProbeAsync(probeApi, ct).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(profile.DisplayName))
            {
                profile.DisplayName = config.AppName;
            }
        }
        finally
        {
            probeApi.Dispose();
        }

        var saved = await _store.AddAsync(profile, ct).ConfigureAwait(false);
        var session = await EnsureSessionAsync(saved, ct).ConfigureAwait(false);

        await SetActiveAsync(session.Id, ct).ConfigureAwait(false);
        RaiseServersChanged();

        return session;
    }

    /// <summary>
    /// 移除一台服务器：先停会话（停止后台循环、释放 HTTP），再删档案。
    ///
    /// 若删掉的正是当前激活的那台，自动切到相邻的一台。
    /// </summary>
    public async Task RemoveServerAsync(string serverId, CancellationToken ct = default)
    {
        ThrowIfDisposed();
        if (string.IsNullOrEmpty(serverId)) return;

        ServerSession? session;
        lock (_gate)
        {
            _sessions.TryGetValue(serverId, out session);
            _sessions.Remove(serverId);
        }

        if (session is not null)
        {
            // 退出前尽力下线，让别人立刻看到你走了
            await session.LogoutAsync(ct).ConfigureAwait(false);
            await session.DisposeAsync().ConfigureAwait(false);
        }

        await _store.RemoveAsync(serverId, ct).ConfigureAwait(false);

        // 删的就是当前这台 → 顺位激活下一台
        string? next = null;
        lock (_gate)
        {
            if (string.Equals(_activeId, serverId, StringComparison.Ordinal))
            {
                _activeId = null;
                next = _sessions.Values
                    .OrderBy(s => s.Profile.SortOrder)
                    .ThenBy(s => s.Profile.LastUsedAt)
                    .FirstOrDefault()?.Id;
            }
        }

        if (next is not null)
        {
            await SetActiveAsync(next, ct).ConfigureAwait(false);
        }
        else
        {
            RaiseActiveServerChanged(null);
        }

        RaiseServersChanged();
    }

    /// <summary>
    /// 切换当前服务器。
    ///
    /// 刻意<b>不</b>登出上一台：它的心跳继续跑，切回来是即时的。
    /// </summary>
    public async Task SetActiveAsync(string serverId, CancellationToken ct = default)
    {
        ThrowIfDisposed();

        ServerSession? session;
        lock (_gate)
        {
            if (!_sessions.TryGetValue(serverId, out session)) return;
            if (string.Equals(_activeId, serverId, StringComparison.Ordinal)) return;
            _activeId = serverId;
        }

        await _settings.UpdateAsync(s => s.SelectedServerId = serverId, ct).ConfigureAwait(false);
        await _store.TouchAsync(serverId, ct).ConfigureAwait(false);

        RaiseActiveServerChanged(serverId);
        RaiseServersChanged();
        _ = session; // 会话本身不在这里启动；它早已在跑
    }

    // --------------------------------------------------------
    //  事件触发
    //
    //  ★ 所有对外事件都在【UI 线程】上触发。
    //
    //  ServerManager 内部到处 ConfigureAwait(false)（库代码的正确写法），
    //  续体因此可能落在**线程池线程**上。订阅方（主窗口与各栏控件）收到事件后
    //  会直接改 XAML 控件 —— 跨线程碰控件会抛 RPC_E_WRONG_THREAD (0x8001010E)，
    //  而这个错误的文案里既没有「跨线程」也没有「UI」，排查代价极高。
    //
    //  把「回到 UI 线程」这件事收敛在这一层，订阅方就不必人人写一遍。
    //  没有 DispatcherQueue 时（单测 / 无界面场景）退化为直接触发。
    // --------------------------------------------------------

    /// <summary>UI 线程调度器（由主窗口在构造时注入）。</summary>
    public DispatcherQueue? Dispatcher { get; set; }

    private void RaiseServersChanged() => RaiseOnUi(() => ServersChanged?.Invoke(this, EventArgs.Empty));

    private void RaiseActiveServerChanged(string? serverId) =>
        RaiseOnUi(() => ActiveServerChanged?.Invoke(this, serverId));

    private void RaiseServerStateChanged(ServerStateChangedEventArgs e) =>
        RaiseOnUi(() => ServerStateChanged?.Invoke(this, e));

    private void RaiseInvited(ServerInviteEventArgs e) => RaiseOnUi(() => Invited?.Invoke(this, e));

    /// <summary>在 UI 线程上触发事件；没有调度器时直接触发。</summary>
    private void RaiseOnUi(Action raise)
    {
        var dispatcher = Dispatcher;
        if (dispatcher is null || dispatcher.HasThreadAccess)
        {
            raise();
            return;
        }

        // 投递到 UI 线程即可，不必等它完成 —— 事件是单向通知
        dispatcher.TryEnqueue(() =>
        {
            try
            {
                raise();
            }
            catch
            {
                // 订阅方的异常不该冒泡成未处理异常把进程带崩
            }
        });
    }

    /// <summary>改名（只影响本地显示，不动服务端）。</summary>
    public async Task RenameServerAsync(string serverId, string displayName, CancellationToken ct = default)
    {
        ThrowIfDisposed();
        await _store.UpdateAsync(serverId, s => s.DisplayName = displayName?.Trim() ?? string.Empty, ct)
            .ConfigureAwait(false);
        RaiseServersChanged();
    }

    /// <summary>按服务器栏的新顺序重排。</summary>
    public async Task ReorderAsync(IReadOnlyList<string> orderedIds, CancellationToken ct = default)
    {
        ThrowIfDisposed();
        await _store.ReorderAsync(orderedIds, ct).ConfigureAwait(false);
        RaiseServersChanged();
    }

    // --------------------------------------------------------
    //  登录（委托给对应会话）
    // --------------------------------------------------------

    /// <summary>登录指定服务器。各服务器的凭据互不影响。</summary>
    public async Task<SessionResult> LoginAsync(
        string serverId,
        string key,
        string nickname,
        string? avatarId = null,
        string? turnstileToken = null,
        CancellationToken ct = default)
    {
        ThrowIfDisposed();

        var session = Find(serverId)
            ?? throw new ApiException("服务器不存在，可能已被删除");

        var result = await session
            .LoginAsync(key, nickname, avatarId, turnstileToken, ct)
            .ConfigureAwait(false);

        await SetActiveAsync(serverId, ct).ConfigureAwait(false);
        return result;
    }

    /// <summary>登出指定服务器（其它服务器不受影响）。</summary>
    public async Task LogoutAsync(string serverId, CancellationToken ct = default)
    {
        ThrowIfDisposed();
        var session = Find(serverId);
        if (session is null) return;

        await session.LogoutAsync(ct).ConfigureAwait(false);
        RaiseServersChanged();
    }

    // --------------------------------------------------------
    //  内部
    // --------------------------------------------------------

    private async Task<ServerSession> EnsureSessionAsync(ServerProfile profile, CancellationToken ct)
    {
        ServerSession? existing;
        lock (_gate)
        {
            _sessions.TryGetValue(profile.Id, out existing);
        }

        if (existing is not null) return existing;

        var session = new ServerSession(profile, _store);
        session.StateChanged += (_, e) => RaiseServerStateChanged(e);
        session.DataChanged += (_, _) => RaiseServersChanged();
        session.Invited += (_, invite) => RaiseInvited(
            new ServerInviteEventArgs(profile.Id, session.DisplayName, invite));

        lock (_gate)
        {
            _sessions[profile.Id] = session;
        }

        await session.StartAsync(ct).ConfigureAwait(false);
        return session;
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        ServerSession[] all;
        lock (_gate)
        {
            all = _sessions.Values.ToArray();
            _sessions.Clear();
        }

        // 并行停：每台的 DisposeAsync 会等自己的循环退出（最多 3 秒）
        await Task.WhenAll(all.Select(s => s.DisposeAsync().AsTask())).ConfigureAwait(false);

        // 退出前把档案刷一遍，避免最后一次续期的 token 没落盘
        try
        {
            await _store.FlushAsync().ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 忽略：退出路径上不该因为落盘失败弹错
        }
    }
}

/// <summary>邀请事件的载荷：带上「是哪台服务器发来的」。</summary>
public sealed class ServerInviteEventArgs : EventArgs
{
    public ServerInviteEventArgs(string serverId, string serverName, PresenceInvite invite)
    {
        ServerId = serverId;
        ServerName = serverName;
        Invite = invite;
    }

    public string ServerId { get; }

    /// <summary>服务器显示名 —— 弹邀请时要说清是哪台服，否则多服务器下会懵。</summary>
    public string ServerName { get; }

    public PresenceInvite Invite { get; }
}

