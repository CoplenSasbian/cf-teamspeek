using CfTeamspeed.Desktop.Models;

namespace CfTeamspeed.Desktop.Services;

// ============================================================
//  单台服务器的会话
//
//  一台服务器 = 一个 ApiClient + 一组后台循环（心跳 / 轮询）+ 一份房间状态。
//
//  ★ 与 Web 端最大的不同：这里的一切都是【按实例】的。
//    Web 端可以写模块级单例（一个部署只有一台服务器），桌面端不行 ——
//    同时挂 3 台服务器就是 3 个 ServerSession 并行跑各自的定时器。
//    任何 static 的可变状态都会让三台服务器互相串数据。
// ============================================================

/// <summary>该服务器当前的连接与登录状态（供服务器栏画角标）。</summary>
public enum ServerConnectionState
{
    /// <summary>还没添加地址 / 从未连接</summary>
    Idle,

    /// <summary>正在连接或正在登录</summary>
    Connecting,

    /// <summary>已登录且心跳正常</summary>
    Online,

    /// <summary>暂时连不上（网络问题 / 服务端挂了），会自动重试</summary>
    Degraded,

    /// <summary>需要一个有效的 key 重新登录（无 token，或 token 已彻底失效）</summary>
    SignedOut,

    /// <summary>被移出服务器（封禁）</summary>
    Banned,
}

/// <summary>会话状态变化的通知载荷。</summary>
public sealed class ServerStateChangedEventArgs : EventArgs
{
    public ServerStateChangedEventArgs(
        string serverId,
        ServerConnectionState state,
        string? message = null)
    {
        ServerId = serverId;
        State = state;
        Message = message;
    }

    public string ServerId { get; }

    public ServerConnectionState State { get; }

    /// <summary>可选的补充说明（失败原因等），供 Tooltip 展示。</summary>
    public string? Message { get; }
}

/// <summary>
/// 一台服务器的完整会话。
///
/// 职责边界：
///   - 持有该服务器的 <see cref="ApiClient"/>（凭据、HTTP）
///   - 跑该服务器的后台循环：在线心跳、成员轮询、房间列表刷新、token 续期
///   - 暴露该服务器的房间列表 / 在线名册 / 当前房间给界面
///
/// <b>不</b>负责：SFU 媒体协商（那是 RoomController 的事，只在真正进房时才建立）。
/// 这样「挂着一堆服务器但没进任何房间」时，只有轻量的心跳与轮询在跑。
/// </summary>
public sealed class ServerSession : IAsyncDisposable
{
    /// <summary>房间列表刷新间隔（与 Web 端一致）。</summary>
    private static readonly TimeSpan RoomRefreshInterval = TimeSpan.FromSeconds(8);

    /// <summary>presence 心跳间隔。</summary>
    private static readonly TimeSpan PresenceHeartbeatInterval = TimeSpan.FromSeconds(15);

    /// <summary>presence 轮询间隔（同时取走新邀请）。</summary>
    private static readonly TimeSpan PresencePollInterval = TimeSpan.FromSeconds(6);

    /// <summary>token 续期检查间隔。</summary>
    private static readonly TimeSpan TokenCheckInterval = TimeSpan.FromMinutes(2);

    /// <summary>出错后的退避下限 / 上限（指数退避）。</summary>
    private static readonly TimeSpan BackoffMin = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan BackoffMax = TimeSpan.FromSeconds(60);

    private readonly ServerStore _store;
    private readonly object _gate = new();

    private readonly CancellationTokenSource _lifetime = new();
    private readonly List<Task> _loops = new();

    private ServerProfile _profile;
    private ApiClient? _api;
    private bool _disposed;

    /// <summary>连续失败次数，用于指数退避（任何一次成功都清零）。</summary>
    private int _consecutiveFailures;

    /// <summary>当前连接状态（只有本对象会写，读的时候加锁）。</summary>
    private ServerConnectionState _state = ServerConnectionState.Idle;

    public ServerSession(ServerProfile profile, ServerStore store)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(store);

        _profile = profile.Clone();
        _store = store;
    }

    // --------------------------------------------------------
    //  只读状态（界面绑定）
    // --------------------------------------------------------

    public string Id => _profile.Id;

    public ServerProfile Profile
    {
        get { lock (_gate) return _profile.Clone(); }
    }

    public ServerConnectionState State
    {
        get { lock (_gate) return _state; }
    }

    /// <summary>该服务器的房间列表（最近一次拉取的结果）。</summary>
    public IReadOnlyList<RoomWithMembers> Rooms { get; private set; } = Array.Empty<RoomWithMembers>();

    /// <summary>该服务器的在线名册（最近一次轮询的结果）。</summary>
    public PresenceSnapshot? Presence { get; private set; }

    /// <summary>当前所在房间 id（未进任何房间为 null）。</summary>
    public string? CurrentRoomId { get; private set; }

    /// <summary>该服务器的显示名（用户命名 → 昵称 → 主机名）。</summary>
    public string DisplayName => _profile.ResolveDisplayName();

    /// <summary>
    /// 服务端返回的用户资料（uid / role / avatarUrl）。
    ///
    /// 为什么要单独存一份：<see cref="ServerProfile"/> 只记本地需要持久化的东西
    /// （token、key、昵称），而 uid 与 role 是服务端权威字段，不该由本地编造。
    /// 登录成功后写入；重启后若只有 token，则由 <c>/api/auth/me</c> 补回。
    /// </summary>
    public Profile? UserProfile { get; private set; }

    /// <summary>当前用户的 uid（未登录为 null）。</summary>
    public string? SelfUid => UserProfile?.Uid;

    /// <summary>当前用户是否管理员。</summary>
    public bool IsAdmin => UserProfile?.Role == Role.Admin;

    /// <summary>下拉/提示里用的地址。</summary>
    public string HostDisplay => _profile.HostDisplay;

    public ApiClient Api =>
        _api ?? throw new InvalidOperationException("会话尚未启动，请先调用 StartAsync()");

    /// <summary>状态变化通知（连接状态、房间列表、名册都会走这里）。</summary>
    public event EventHandler<ServerStateChangedEventArgs>? StateChanged;

    /// <summary>房间列表 / 名册等数据变化（界面据此重新渲染）。</summary>
    public event EventHandler? DataChanged;

    /// <summary>收到新的房间邀请。</summary>
    public event EventHandler<PresenceInvite>? Invited;

    // --------------------------------------------------------
    //  生命周期
    // --------------------------------------------------------

    /// <summary>
    /// 建立 HTTP 通道并启动后台循环。
    ///
    /// 注意：<b>不会</b>自动登录 —— 登录需要 key 与昵称，属于用户动作。
    /// 已有有效 token 时会直接进入在线循环。
    /// </summary>
    public Task StartAsync(CancellationToken ct = default)
    {
        ThrowIfDisposed();
        EnsureApi();

        // 已有 token 就直接跑在线循环；否则只是待登录状态，不发任何鉴权请求
        if (_profile.HasToken && !_profile.IsSessionHardExpired)
        {
            SetState(ServerConnectionState.Connecting);
            StartLoops();

            // 重启后内存里没有 Profile（uid / role），补拉一次。
            // 放在后台做：它不该拖慢窗口显示，失败了循环也会自然纠正状态。
            _ = FetchProfileAsync();
        }
        else
        {
            SetState(ServerConnectionState.SignedOut);
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// 拉取当前用户资料（重启后只有 token、没有 uid / role 时用）。
    /// 失败静默：401 会由 ApiClient 的事件统一处理。
    /// </summary>
    private async Task FetchProfileAsync()
    {
        try
        {
            var me = await Api.GetMeAsync(_lifetime.Token).ConfigureAwait(false);
            if (me.Profile is not null)
            {
                UserProfile = me.Profile;
                SetState(ServerConnectionState.Online);
                DataChanged?.Invoke(this, EventArgs.Empty);
            }
        }
        catch (ApiException)
        {
            // 交给 401 事件与后台循环处理
        }
        catch (OperationCanceledException)
        {
            // 会话已释放
        }
    }

    /// <summary>
    /// 用 key + 昵称登录本服务器。
    ///
    /// 成功后把凭据写进档案（<b>只写这一台</b>）并启动后台循环。
    /// </summary>
    public async Task<SessionResult> LoginAsync(
        string key,
        string nickname,
        string? avatarId = null,
        string? turnstileToken = null,
        CancellationToken ct = default)
    {
        ThrowIfDisposed();
        var api = EnsureApi();

        SetState(ServerConnectionState.Connecting, "正在登录…");

        try
        {
            // 先确保地址可达：登录失败的常见原因是地址写错，
            // 提前探测能给出一条比「401」清晰得多的提示
            await ProbeAsync(api, ct).ConfigureAwait(false);

            var result = await api
                .LoginAsync(key, nickname, avatarId, turnstileToken, ct)
                .ConfigureAwait(false);

            // 服务端权威资料（uid / role / avatarUrl）。
            // 理论上必然存在；真缺了也不能崩，用本地已知值兜底。
            UserProfile = result.Profile;

            // ★ 只更新本服务器的档案
            await _store.UpdateAsync(Id, s =>
            {
                s.Key = key;
                s.SessionToken = result.Token;
                s.TokenExpiresAt = result.ExpiresAt;
                s.SessionHardExpiresAt = result.SessionExpiresAt;
                s.Nickname = result.Profile?.Nickname ?? nickname;
                s.AvatarId = result.Profile?.AvatarId ?? avatarId;
                s.LastUsedAt = UnixTime.Now;
            }, ct).ConfigureAwait(false);

            // 内存档案同步成刚写入的那一套（不再从磁盘读回，避免 sync-over-async）
            ApplyCredentialPatch(s =>
            {
                s.Key = key;
                s.SessionToken = result.Token;
                s.TokenExpiresAt = result.ExpiresAt;
                s.SessionHardExpiresAt = result.SessionExpiresAt;
                s.Nickname = result.Profile?.Nickname ?? nickname;
                s.AvatarId = result.Profile?.AvatarId ?? avatarId;
                s.LastUsedAt = UnixTime.Now;
            });

            SetState(ServerConnectionState.Online);
            StartLoops();

            return result;
        }
        catch (ApiException ex)
        {
            SetState(
                ex.IsBanned ? ServerConnectionState.Banned : ServerConnectionState.SignedOut,
                ex.Message);
            throw;
        }
    }

    /// <summary>
    /// 登录前/添加服务器时的可达性探测。
    ///
    /// 用公开的 <c>/api/auth/config</c>：既能确认「这是一台 cf-teamspeed」，
    /// 又能顺便把 <c>appName</c> 当作显示名（免登录）。
    /// </summary>
    public static async Task<ClientConfig> ProbeAsync(ApiClient api, CancellationToken ct = default)
    {
        try
        {
            return await api.GetConfigAsync(ct).ConfigureAwait(false);
        }
        catch (ApiException ex) when (ex.IsTransportFailure)
        {
            throw ApiException.Transport($"无法连接服务器（{api.BaseUrl}），请检查地址与网络");
        }
    }

    /// <summary>登出：先尽力通知服务端下线，再清本地凭据。</summary>
    public async Task LogoutAsync(CancellationToken ct = default)
    {
        ThrowIfDisposed();
        StopLoops();

        var api = _api;
        if (api is not null && api.HasToken)
        {
            // 先下线，让在线名册立刻更新（失败也无所谓，token 马上就作废了）
            try
            {
                await api.PresenceLeaveAsync(ct).ConfigureAwait(false);
            }
            catch (ApiException)
            {
                // 忽略
            }

            try
            {
                await api.LogoutAsync(ct).ConfigureAwait(false);
            }
            catch (ApiException)
            {
                // 忽略
            }
        }

        await _store.ClearSessionAsync(Id, ct).ConfigureAwait(false);
        ApplyCredentialPatch(s =>
        {
            s.SessionToken = null;
            s.TokenExpiresAt = 0;
            s.SessionHardExpiresAt = 0;
        });
        SetState(ServerConnectionState.SignedOut);
    }

    /// <summary>进入某房间（只登记当前房间，不建立媒体链路）。</summary>
    public void SetCurrentRoom(string? roomId)
    {
        CurrentRoomId = roomId;
        DataChanged?.Invoke(this, EventArgs.Empty);
    }

    // --------------------------------------------------------
    //  后台循环
    //
    //  全部挂在一个 CancellationTokenSource 上：登出 / 移除服务器 /
    //  窗口关闭时一次性停掉，绝不留下野定时器。
    // --------------------------------------------------------

    private void StartLoops()
    {
        lock (_gate)
        {
            if (_loops.Count > 0) return; // 已在跑

            _loops.Add(Task.Run(() => PresenceHeartbeatLoopAsync(_lifetime.Token)));
            _loops.Add(Task.Run(() => PresencePollLoopAsync(_lifetime.Token)));
            _loops.Add(Task.Run(() => RoomRefreshLoopAsync(_lifetime.Token)));
            _loops.Add(Task.Run(() => TokenMaintenanceLoopAsync(_lifetime.Token)));
        }
    }

    private void StopLoops()
    {
        lock (_gate)
        {
            _loops.Clear();
        }
    }

    /// <summary>
    /// presence 心跳：15 秒一次，登记「我还活着 + 我在哪个房间」。
    ///
    /// 返回 <c>banned: true</c> 时必须处理 —— 服务端刻意用成功响应 + 标记，
    /// 因为高频心跳里的 403 很容易被当成网络抖动忽略掉。
    /// </summary>
    private async Task PresenceHeartbeatLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var profile = Profile;
                var snapshot = CurrentRoomId is null ? null : Rooms.FirstOrDefault(r => r.Id == CurrentRoomId);

                var result = await Api.PresenceHeartbeatAsync(
                    roomId: CurrentRoomId,
                    roomName: snapshot?.Name,
                    status: null, // 状态由界面在设置里改，这里不改写
                    invitable: null,
                    ct).ConfigureAwait(false);

                if (result.Banned)
                {
                    await HandleBannedAsync().ConfigureAwait(false);
                    return; // 循环终止：被踢的人不该继续打服务端
                }

                ResetBackoff();
                if (State != ServerConnectionState.Online) SetState(ServerConnectionState.Online);
            }
            catch (ApiException ex) when (ex.IsAuthFailure)
            {
                // 401：会话没了，心跳再打也是白打，交给续期循环去判断是否还能救
                SetState(ServerConnectionState.SignedOut, ex.Message);
                return;
            }
            catch (ApiException ex)
            {
                RegisterFailure(ex);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (!await DelayWithBackoffAsync(PresenceHeartbeatInterval, ct).ConfigureAwait(false)) return;
        }
    }

    /// <summary>presence 轮询：6 秒一次，拉成员名册并取走新邀请。</summary>
    private async Task PresencePollLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var snapshot = await Api.PresencePollAsync(ct).ConfigureAwait(false);
                Presence = snapshot;

                if (snapshot.Invites.Count > 0)
                {
                    foreach (var invite in snapshot.Invites)
                    {
                        Invited?.Invoke(this, invite);
                    }
                }

                ResetBackoff();
                DataChanged?.Invoke(this, EventArgs.Empty);
            }
            catch (ApiException ex) when (ex.IsAuthFailure)
            {
                return;
            }
            catch (ApiException)
            {
                // 轮询失败静默重试：名册晚一拍没有实质影响
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (!await DelayWithBackoffAsync(PresencePollInterval, ct).ConfigureAwait(false)) return;
        }
    }

    /// <summary>房间列表刷新：8 秒一次。</summary>
    private async Task RoomRefreshLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var result = await Api.GetRoomsAsync(ct).ConfigureAwait(false);
                Rooms = result.Rooms;
                ResetBackoff();
                DataChanged?.Invoke(this, EventArgs.Empty);
            }
            catch (ApiException ex) when (ex.IsAuthFailure)
            {
                return;
            }
            catch (ApiException)
            {
                // 保留上一次结果（与 Web 端一致）
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (!await DelayWithBackoffAsync(RoomRefreshInterval, ct).ConfigureAwait(false)) return;
        }
    }

    /// <summary>
    /// token 维护：临期就主动续期。
    ///
    /// 服务端本来就会在任意鉴权请求上滚动续期，但「整晚挂着、几乎不发请求」
    /// 的场景需要这条兜底，否则会在某次心跳时突然 401。
    /// </summary>
    private async Task TokenMaintenanceLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var profile = Profile;

                // 已触绝对上限：refresh 也救不回来，只能让用户重新登录
                if (profile.IsSessionHardExpired)
                {
                    await ClearLocalSessionAsync(ct).ConfigureAwait(false);
                    SetState(ServerConnectionState.SignedOut, "会话已到期，请重新登录");
                    return;
                }

                if (profile.NeedsRefresh)
                {
                    // RefreshAsync 会把新 token 通过 persistToken 回调落盘，
                    // 这里把同一个结果同步进内存档案
                    var refreshed = await Api.RefreshAsync(ct).ConfigureAwait(false);
                    ApplyCredentialPatch(s =>
                    {
                        s.SessionToken = refreshed.Token;
                        s.TokenExpiresAt = refreshed.ExpiresAt;
                        s.SessionHardExpiresAt = refreshed.SessionExpiresAt;
                    });
                    DataChanged?.Invoke(this, EventArgs.Empty);
                }
            }
            catch (ApiException ex) when (ex.IsAuthFailure)
            {
                await ClearLocalSessionAsync(ct).ConfigureAwait(false);
                SetState(ServerConnectionState.SignedOut, ex.Message);
                return;
            }
            catch (ApiException)
            {
                // 续期失败就先放着，下一轮再试
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (!await DelayWithBackoffAsync(TokenCheckInterval, ct).ConfigureAwait(false)) return;
        }
    }

    // --------------------------------------------------------
    //  失败处理 / 退避
    // --------------------------------------------------------

    private async Task HandleBannedAsync()
    {
        await ClearLocalSessionAsync().ConfigureAwait(false);
        SetState(ServerConnectionState.Banned, "你已被移出这台服务器");
    }

    private void RegisterFailure(ApiException ex)
    {
        _consecutiveFailures++;
        SetState(ServerConnectionState.Degraded, ex.Message);
    }

    private void ResetBackoff() => _consecutiveFailures = 0;

    /// <summary>
    /// 按退避倍数等待。返回 false 表示已取消，循环应当退出。
    ///
    /// 退避只影响「失败后重试的节奏」，正常周期不变 —— 这样偶发抖动
    /// 不会让轮询整体变慢，而持续故障时也不会疯狂打服务端。
    /// </summary>
    private async Task<bool> DelayWithBackoffAsync(TimeSpan baseInterval, CancellationToken ct)
    {
        var failures = _consecutiveFailures;
        TimeSpan delay;

        if (failures <= 0)
        {
            delay = baseInterval;
        }
        else
        {
            // 2^n 增长，封顶 BackoffMax
            var seconds = BackoffMin.TotalSeconds * Math.Pow(2, Math.Min(failures - 1, 6));
            delay = TimeSpan.FromSeconds(Math.Min(seconds, BackoffMax.TotalSeconds));
        }

        try
        {
            await Task.Delay(delay, ct).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    // --------------------------------------------------------
    //  内部工具
    // --------------------------------------------------------

    private ApiClient EnsureApi()
    {
        if (_api is not null) return _api;

        _api = new ApiClient(_profile, PersistTokenAsync);

        // 401 / SESSION_EXPIRED：只清这一台的会话
        _api.SessionExpired += async (_, e) =>
        {
            await ClearLocalSessionAsync().ConfigureAwait(false);
            SetState(ServerConnectionState.SignedOut, e.Message);
            StopLoops();
        };

        _api.Banned += async (_, e) =>
        {
            await ClearLocalSessionAsync().ConfigureAwait(false);
            SetState(ServerConnectionState.Banned, e.Message);
            StopLoops();
        };

        // 滚动续期：ApiClient 已经把新 token 交给 persistToken 回调，
        // 这里只需通知界面刷新（内存档案由 PersistTokenAsync 一并更新）
        _api.TokenRefreshed += (_, _) => DataChanged?.Invoke(this, EventArgs.Empty);

        return _api;
    }

    /// <summary>ApiClient 的 token 落盘回调（由 ApiClient 在滚动续期时调用）。</summary>
    private async Task PersistTokenAsync(
        string serverId,
        string token,
        long expiresAt,
        long sessionExpiresAt,
        CancellationToken ct)
    {
        await _store.UpdateAsync(serverId, s =>
        {
            if (string.IsNullOrEmpty(token))
            {
                // 空 token = 清会话
                s.SessionToken = null;
                s.TokenExpiresAt = 0;
                s.SessionHardExpiresAt = 0;
                return;
            }

            s.SessionToken = token;
            if (expiresAt > 0) s.TokenExpiresAt = expiresAt;
            if (sessionExpiresAt > 0) s.SessionHardExpiresAt = sessionExpiresAt;
        }, ct).ConfigureAwait(false);

        // 磁盘写完，把同一份结果同步进内存档案 —— 否则界面上的
        // 「登录有效期」会一直停留在旧值，而请求用的却是新 token。
        ApplyCredentialPatch(s =>
        {
            if (string.IsNullOrEmpty(token))
            {
                s.SessionToken = null;
                s.TokenExpiresAt = 0;
                s.SessionHardExpiresAt = 0;
                return;
            }

            s.SessionToken = token;
            if (expiresAt > 0) s.TokenExpiresAt = expiresAt;
            if (sessionExpiresAt > 0) s.SessionHardExpiresAt = sessionExpiresAt;
        });
    }

    /// <summary>
    /// 清掉本地会话：磁盘与内存一起清。
    ///
    /// 抽成一个方法是因为「清会话」出现在四条路径上
    /// （登出 / 绝对到期 / 401 / 封禁），漏掉任何一处都会让界面
    /// 显示成「已登录」但却处处 401。
    /// </summary>
    private async Task ClearLocalSessionAsync(CancellationToken ct = default)
    {
        await _store.ClearSessionAsync(Id, ct).ConfigureAwait(false);
        ApplyCredentialPatch(s =>
        {
            s.SessionToken = null;
            s.TokenExpiresAt = 0;
            s.SessionHardExpiresAt = 0;
        });
    }

    /// <summary>
    /// 把凭据写进本会话的内存档案。
    ///
    /// ★ 这里刻意【不】从 ServerStore 读回来。
    /// 原先的写法是 <c>_store.GetAsync(Id).GetAwaiter().GetResult()</c>，
    /// 那是 sync-over-async：ServerStore 内部用 SemaphoreSlim 且延续点可能回到
    /// UI 线程，在 UI 线程上阻塞等待就会死锁 —— 表现为启动时弹「初始化失败」。
    ///
    /// 改为「谁改谁负责同步」：调用方本来就知道新值（token、昵称…），
    /// 直接就地更新内存档案即可，不产生任何异步等待。
    /// </summary>
    private void ApplyCredentialPatch(Action<ServerProfile> mutate)
    {
        ServerProfile updated;
        lock (_gate)
        {
            mutate(_profile);
            updated = _profile;
        }

        _api?.ReplaceProfile(updated);
    }

    private void SetState(ServerConnectionState state, string? message = null)
    {
        bool changed;
        lock (_gate)
        {
            changed = _state != state;
            _state = state;
        }

        // 状态没变也要发：message（失败原因）可能更新了，Tooltip 需要刷新
        StateChanged?.Invoke(this, new ServerStateChangedEventArgs(Id, state, message));
        _ = changed;
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        try
        {
            _lifetime.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // 忽略
        }

        // 等循环退出，避免它们还在用已释放的 ApiClient
        Task[] pending;
        lock (_gate)
        {
            pending = _loops.ToArray();
            _loops.Clear();
        }

        if (pending.Length > 0)
        {
            try
            {
                await Task.WhenAll(pending).WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is OperationCanceledException or TimeoutException or AggregateException)
            {
                // 超时就算了：这些循环只做 HTTP，不会卡住进程退出
            }
        }

        _api?.Dispose();
        _api = null;
        _lifetime.Dispose();
    }
}
