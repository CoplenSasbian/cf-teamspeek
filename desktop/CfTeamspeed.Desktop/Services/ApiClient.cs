using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CfTeamspeed.Desktop.Models;

namespace CfTeamspeed.Desktop.Services;

// ============================================================
//  后端 API 客户端
//
//  ★ 实例级，不是单例。桌面端同时连着多台服务器，每台各有自己的
//    baseUrl / key / token；任何「静态 currentToken」都会造成串号。
//
//  两件必须做对的事：
//    1. 滚动续期：任何鉴权响应都可能带 X-Refreshed-Token 响应头，
//       必须捕获并通过回调落盘，替换当前 token（网页端同样逻辑，见 app/lib/api.ts）。
//    2. 401 分诊：只有 401 才算「该服务器会话没了」→ 清该服务器的会话 +
//       通知界面让「这一台」重新登录，绝不能牵连其它服务器。
// ============================================================

/// <summary>
/// 会话失效（401 / SESSION_EXPIRED）时的通知参数。
///
/// 带上 ServerId 是刻意的：界面必须知道「是哪一台」掉线了，
/// 只弹一个全局「登录已过期」在多服务器场景下毫无用处。
/// </summary>
public sealed class SessionExpiredEventArgs : EventArgs
{
    public SessionExpiredEventArgs(string serverId, string? code, string message)
    {
        ServerId = serverId;
        Code = code;
        Message = message;
    }

    public string ServerId { get; }

    public string? Code { get; }

    public string Message { get; }
}

/// <summary>被移出服务器（BANNED）时的通知参数。</summary>
public sealed class BannedEventArgs : EventArgs
{
    public BannedEventArgs(string serverId, string message)
    {
        ServerId = serverId;
        Message = message;
    }

    public string ServerId { get; }

    public string Message { get; }
}

/// <summary>
/// 单台服务器的 HTTP 客户端。
///
/// 生命周期：一台服务器一个实例，由上层的「服务器会话管理器」持有。
/// 注意实例内部会缓存 token，移除服务器时应当调用 <see cref="Dispose"/>。
/// </summary>
public sealed class ApiClient : IDisposable
{
    /// <summary>
    /// 全局共享的 HttpClient。
    ///
    /// 每台服务器各 new 一个 HttpClient 会耗尽 socket（TIME_WAIT），
    /// 而 HttpClient 本身是线程安全、且不持有 per-server 状态的，
    /// 所以共享一个实例、把 baseUrl 拼在请求 URL 里才是正解。
    /// </summary>
    private static readonly HttpClient SharedHttp = CreateHttpClient();

    /// <summary>默认请求超时；心跳/轮询这类短请求会各自传更短的超时。</summary>
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(20);

    /// <summary>滚动续期拿不到 expiresAt 时的兜底寿命：12 小时。宁可写大，避免反复续期。</summary>
    private const long RefreshedTokenFallbackLifetimeSeconds = 12 * 60 * 60;

    private readonly object _stateLock = new();

    /// <summary>token 落盘回调（签名：serverId, token, expiresAt, sessionHardExpiresAt）。</summary>
    private readonly Func<string, string, long, long, CancellationToken, Task>? _persistToken;

    private ServerProfile _profile;
    private bool _disposed;

    /// <summary>
    /// 构造。
    /// </summary>
    /// <param name="profile">该服务器的档案（含 baseUrl 与初始 token）。</param>
    /// <param name="persistToken">
    /// 把滚动续期拿到的新 token 落盘的回调。传 null 则只在内存里更新。
    /// 之所以用回调而不是直接依赖 ServerStore：让 ApiClient 保持可单测、不绑死持久化实现。
    /// </param>
    /// <param name="httpMessageHandler">可选的测试用 handler；为 null 时用进程内共享的 HttpClient。</param>
    public ApiClient(
        ServerProfile profile,
        Func<string, string, long, long, CancellationToken, Task>? persistToken = null,
        HttpMessageHandler? httpMessageHandler = null)
    {
        ArgumentNullException.ThrowIfNull(profile);

        _profile = profile.Clone();
        _persistToken = persistToken;

        if (!string.IsNullOrWhiteSpace(_profile.BaseUrl))
        {
            var normalized = ServerProfile.NormalizeBaseUrl(_profile.BaseUrl);
            if (normalized is not null) _profile.BaseUrl = normalized;
        }

        Http = httpMessageHandler is null ? SharedHttp : new HttpClient(httpMessageHandler, disposeHandler: true);
        OwnsHttpClient = httpMessageHandler is not null;
    }

    /// <summary>本实例使用的 HttpClient（测试时可注入 handler）。</summary>
    public HttpClient Http { get; }

    private bool OwnsHttpClient { get; }

    /// <summary>本客户端对应的服务器 Id。</summary>
    public string ServerId
    {
        get { lock (_stateLock) return _profile.Id; }
    }

    /// <summary>服务基址（已规范化，末尾无斜杠）。</summary>
    public string BaseUrl
    {
        get { lock (_stateLock) return _profile.BaseUrl; }
    }

    /// <summary>该服务器针对「会话失效」的通知（401 / SESSION_EXPIRED）。</summary>
    public event EventHandler<SessionExpiredEventArgs>? SessionExpired;

    /// <summary>该服务器针对「被移出服务器」的通知（BANNED）。</summary>
    public event EventHandler<BannedEventArgs>? Banned;

    /// <summary>
    /// 服务端滚动续期了 token（响应头或响应体）。
    /// 界面可据此刷新「登录有效期」显示，非必需。
    /// </summary>
    public event EventHandler<long>? TokenRefreshed;

    // --------------------------------------------------------
    //  凭据
    // --------------------------------------------------------

    /// <summary>
    /// 整体替换档案（例如用户在设置里改了显示名或地址后重建客户端）。
    /// 一般用不上 —— 客户端与服务器档案是一对一长期持有的。
    /// </summary>
    public void ReplaceProfile(ServerProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        lock (_stateLock)
        {
            _profile = profile.Clone();
            if (!string.IsNullOrWhiteSpace(_profile.BaseUrl))
            {
                _profile.BaseUrl = ServerProfile.NormalizeBaseUrl(_profile.BaseUrl) ?? _profile.BaseUrl;
            }
        }
    }

    /// <summary>当前档案的快照。</summary>
    public ServerProfile ProfileSnapshot()
    {
        lock (_stateLock) return _profile.Clone();
    }

    /// <summary>当前 token（没有则 null）。</summary>
    public string? CurrentToken
    {
        get { lock (_stateLock) return _profile.SessionToken; }
    }

    /// <summary>是否持有 token（不代表未过期）。</summary>
    public bool HasToken
    {
        get { lock (_stateLock) return !string.IsNullOrEmpty(_profile.SessionToken); }
    }

    /// <summary>
    /// 直接写入一套会话凭据（登录成功后调用），并落盘。
    /// </summary>
    public async Task ApplySessionAsync(
        string token,
        long expiresAt,
        long sessionExpiresAt,
        string? nickname = null,
        string? avatarId = null,
        CancellationToken ct = default)
    {
        lock (_stateLock)
        {
            _profile.SessionToken = token;
            _profile.TokenExpiresAt = expiresAt;
            _profile.SessionHardExpiresAt = sessionExpiresAt;
            if (nickname is not null) _profile.Nickname = nickname;
            if (avatarId is not null) _profile.AvatarId = avatarId;
        }

        await PersistTokenAsync(token, expiresAt, sessionExpiresAt, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// 清掉本服务器的会话凭据（登出 / 401 / 封禁）。
    /// 刻意保留 key 与昵称，方便用户原地重新登录。
    /// </summary>
    public async Task ClearSessionAsync(CancellationToken ct = default)
    {
        lock (_stateLock)
        {
            _profile.SessionToken = null;
            _profile.TokenExpiresAt = 0;
            _profile.SessionHardExpiresAt = 0;
        }

        // 空 token + 0 到期时间 = 「清空」的信号
        await PersistTokenAsync(string.Empty, 0, 0, ct).ConfigureAwait(false);
    }

    // ========================================================
    //  传输层
    // ========================================================

    /// <summary>
    /// 发送请求并把信封拆开。
    ///
    /// 处理顺序很重要：
    ///   1. 拿到响应后<b>先</b>吸收 X-Refreshed-Token —— 即使本次业务失败（比如 409），
    ///      服务端也可能已经续期了，丢掉这次续期会导致后面所有请求都带着快过期的 token；
    ///   2. 再判断 ok / 状态码，抛 <see cref="ApiException"/>；
    ///   3. 401 与 BANNED 额外触发事件，让界面处理。
    /// </summary>
    private async Task<T> SendAsync<T>(
        HttpMethod method,
        string path,
        object? body,
        bool authenticated,
        TimeSpan? timeout,
        CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        var uri = BuildUri(path);
        using var request = new HttpRequestMessage(method, uri);

        if (body is not null)
        {
            var json = JsonSerializer.Serialize(body, ApiJson.Options);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }
        else if (method == HttpMethod.Post || method == HttpMethod.Patch || method == HttpMethod.Put)
        {
            // 后端多数 POST 要求有请求体；给个空对象比给 null 更安全（避免某些网关 411）
            request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        }

        if (authenticated)
        {
            var token = CurrentToken;
            if (!string.IsNullOrEmpty(token))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            }
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout ?? DefaultTimeout);

        HttpResponseMessage response;
        try
        {
            response = await Http
                .SendAsync(request, HttpCompletionOption.ResponseContentRead, timeoutCts.Token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw ApiException.Transport("请求超时，请检查网络或服务器状态");
        }
        catch (OperationCanceledException)
        {
            throw; // 调用方主动取消：原样抛出，由上层静默处理
        }
        catch (HttpRequestException ex)
        {
            throw ApiException.Transport("无法连接服务器，请检查地址与网络", ex);
        }

        using (response)
        {
            var status = (int)response.StatusCode;

            // ★ 滚动续期：任何鉴权响应都可能顺带下发新 token
            var refreshedHeader = ReadRefreshedTokenHeader(response);
            if (refreshedHeader is not null)
            {
                await AbsorbHeaderTokenAsync(refreshedHeader, ct).ConfigureAwait(false);
            }

            string raw;
            try
            {
                raw = await response.Content.ReadAsStringAsync(timeoutCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw ApiException.Transport("读取响应超时");
            }
            catch (HttpRequestException ex)
            {
                throw ApiException.Transport("读取响应失败", ex);
            }

            ApiResult<T>? envelope = null;
            if (!string.IsNullOrWhiteSpace(raw))
            {
                try
                {
                    envelope = JsonSerializer.Deserialize<ApiResult<T>>(raw, ApiJson.Options);
                }
                catch (JsonException)
                {
                    envelope = null; // 交给下面统一按「响应格式异常」处理
                }
            }

            // 即便信封没解析出来，也可能成功（例如 204 或纯文本健康检查）
            if (envelope is null)
            {
                if (response.IsSuccessStatusCode && typeof(T) == typeof(Unit))
                {
                    return (T)(object)Unit.Value;
                }

                var malformed = ApiException.Malformed(status);
                HandleAuthSideEffects(malformed, status, null);
                throw malformed;
            }

            // 业务成功分支
            if (envelope.Ok)
            {
                // 响应体里带 token 的接口（login / refresh / me）顺带把会话记下来
                await AbsorbBodyTokenAsync(envelope.Data, ct).ConfigureAwait(false);

                if (envelope.Data is not null) return envelope.Data;

                // data 缺失：Unit 视为正常，其它类型说明服务端实现有问题
                if (typeof(T) == typeof(Unit)) return (T)(object)Unit.Value;
                var missing = ApiException.Malformed(status);
                throw missing;
            }

            var error = ApiException.FromEnvelope(
                envelope.Error,
                envelope.Code,
                status,
                envelope.Detail?.ToString());
            HandleAuthSideEffects(error, status, envelope.Code);
            throw error;
        }
    }

    /// <summary>
    /// 401 与 BANNED 的副作用：清会话 + 通知界面。
    ///
    /// 只影响<b>本服务器</b>：多服务器场景下，A 掉线不该动 B。
    /// </summary>
    private void HandleAuthSideEffects(ApiException ex, int status, string? code)
    {
        if (status == 401)
        {
            // 清内存会话；落盘交给 ServerStore（事件订阅方会做），这里只保证本实例不再带旧 token
            lock (_stateLock)
            {
                _profile.SessionToken = null;
                _profile.TokenExpiresAt = 0;
            }

            SessionExpired?.Invoke(
                this,
                new SessionExpiredEventArgs(
                    ServerId,
                    code ?? ErrorCodes.Unauthorized,
                    ex.Message));
            return;
        }

        if (string.Equals(code, ErrorCodes.Banned, StringComparison.Ordinal))
        {
            lock (_stateLock)
            {
                _profile.SessionToken = null;
                _profile.TokenExpiresAt = 0;
                _profile.SessionHardExpiresAt = 0;
            }

            Banned?.Invoke(this, new BannedEventArgs(ServerId, ex.Message));
        }
    }

    /// <summary>读 X-Refreshed-Token 响应头。</summary>
    private static string? ReadRefreshedTokenHeader(HttpResponseMessage response)
    {
        if (!response.Headers.TryGetValues("X-Refreshed-Token", out var values)) return null;

        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        }
        return null;
    }

    /// <summary>
    /// 吸收响应头里的新 token。
    ///
    /// 只有响应头、没有 expiresAt，所以按滚动窗口粗估 12 小时 ——
    /// 宁可估大：估小了会导致每次请求都判定「快过期」而反复续期。
    /// </summary>
    private async Task AbsorbHeaderTokenAsync(string token, CancellationToken ct)
    {
        var expiresAt = UnixTime.Now + RefreshedTokenFallbackLifetimeSeconds;
        long hardExpiresAt;

        lock (_stateLock)
        {
            // 服务端可能同时下发头与体；体里的到期时间更准，别被头覆盖掉
            if (_profile.SessionHardExpiresAt > 0) hardExpiresAt = _profile.SessionHardExpiresAt;
            else if (_profile.TokenExpiresAt > 0) hardExpiresAt = _profile.TokenExpiresAt;
            else hardExpiresAt = expiresAt;

            _profile.SessionToken = token;
            _profile.TokenExpiresAt = expiresAt;
        }

        await PersistTokenAsync(token, expiresAt, hardExpiresAt, ct).ConfigureAwait(false);
        TokenRefreshed?.Invoke(this, expiresAt);
    }

    /// <summary>
    /// 吸收响应体里的 token（login / refresh / PATCH me 会带）。
    ///
    /// 用 JsonDocument 而不是泛型反射：这几个接口的返回类型各不相同，
    /// 而这里只关心 token / expiresAt / sessionExpiresAt 三个字段。
    /// </summary>
    private async Task AbsorbBodyTokenAsync(object? data, CancellationToken ct)
    {
        if (data is null) return;

        string? token = null;
        long expiresAt = 0;
        long sessionExpiresAt = 0;

        switch (data)
        {
            case SessionResult session:
                token = session.Token;
                expiresAt = session.ExpiresAt;
                sessionExpiresAt = session.SessionExpiresAt;
                break;

            case UpdateMeResult updated:
                token = updated.Token;
                expiresAt = updated.ExpiresAt;
                break;

            default:
                // 其余接口不含 token，无需处理
                return;
        }

        if (string.IsNullOrEmpty(token)) return;

        // 改资料接口不带 sessionExpiresAt：沿用当前已知的绝对上限，避免把 0 写进去后
        // 让「会话已到硬上限」的判断失效
        if (sessionExpiresAt <= 0)
        {
            lock (_stateLock) sessionExpiresAt = _profile.SessionHardExpiresAt;
        }

        // 服务端没给 expiresAt 时按兜底寿命估
        if (expiresAt <= 0) expiresAt = UnixTime.Now + RefreshedTokenFallbackLifetimeSeconds;

        bool changed;
        lock (_stateLock)
        {
            changed = !string.Equals(_profile.SessionToken, token, StringComparison.Ordinal);
            _profile.SessionToken = token;
            _profile.TokenExpiresAt = expiresAt;
            if (sessionExpiresAt > 0) _profile.SessionHardExpiresAt = sessionExpiresAt;
        }

        if (changed)
        {
            await PersistTokenAsync(token, expiresAt, sessionExpiresAt, ct).ConfigureAwait(false);
            TokenRefreshed?.Invoke(this, expiresAt);
        }
    }

    private Task PersistTokenAsync(string token, long expiresAt, long sessionExpiresAt, CancellationToken ct)
    {
        if (_persistToken is null) return Task.CompletedTask;

        var serverId = ServerId;

        // 落盘失败（磁盘满 / 权限）不该让业务请求失败：内存里已经有正确 token，
        // 最坏情况是下次启动要重新登录一次
        return SafePersistAsync();

        async Task SafePersistAsync()
        {
            try
            {
                await _persistToken(serverId, token, expiresAt, sessionExpiresAt, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 有意吞掉：见上
            }
        }
    }

    /// <summary>把相对路径拼成绝对 URL，并处理路径参数转义。</summary>
    private Uri BuildUri(string path)
    {
        var baseUrl = BaseUrl;
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            throw new ApiException("服务器地址为空，请先配置服务器", code: null, httpStatus: 0);
        }

        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri))
        {
            throw new ApiException($"服务器地址无法解析：{baseUrl}", code: null, httpStatus: 0);
        }

        var relative = path.StartsWith('/') ? path[1..] : path;
        return new Uri(baseUri, relative);
    }

    /// <summary>URL 路径段转义（房间 id / uid 可能含特殊字符）。</summary>
    private static string Escape(string segment) => Uri.EscapeDataString(segment);

    // ========================================================
    //  Auth
    // ========================================================

    #region Auth

    /// <summary>GET /api/auth/config（公开）—— 客户端配置。</summary>
    public Task<ClientConfig> GetConfigAsync(CancellationToken ct = default)
        => SendAsync<ClientConfig>(HttpMethod.Get, "/api/auth/config", null, authenticated: false, timeout: null, ct);

    /// <summary>GET /api/health（公开）。</summary>
    public Task<HealthResult> GetHealthAsync(CancellationToken ct = default)
        => SendAsync<HealthResult>(HttpMethod.Get, "/api/health", null, authenticated: false, timeout: TimeSpan.FromSeconds(8), ct);

    /// <summary>POST /api/auth/login —— 用 key + 昵称换 token。</summary>
    public Task<SessionResult> LoginAsync(
        string key,
        string nickname,
        string? avatarId = null,
        string? turnstileToken = null,
        CancellationToken ct = default)
    {
        var request = new LoginRequest
        {
            Key = key,
            Nickname = nickname,
            AvatarId = avatarId,
            TurnstileToken = turnstileToken,
        };

        return SendAsync<SessionResult>(HttpMethod.Post, "/api/auth/login", request, authenticated: false, timeout: null, ct);
    }

    /// <summary>POST /api/auth/refresh —— 显式续期（长连接客户端建议定时调用）。</summary>
    public Task<SessionResult> RefreshAsync(CancellationToken ct = default)
        => SendAsync<SessionResult>(HttpMethod.Post, "/api/auth/refresh", new { }, authenticated: true, timeout: null, ct);

    /// <summary>GET /api/auth/me。</summary>
    public Task<MeResult> GetMeAsync(CancellationToken ct = default)
        => SendAsync<MeResult>(HttpMethod.Get, "/api/auth/me", null, authenticated: true, timeout: null, ct);

    /// <summary>PATCH /api/auth/me —— 改昵称 / 头像（会顺带签发新 token）。</summary>
    public Task<UpdateMeResult> UpdateMeAsync(UpdateProfileRequest request, CancellationToken ct = default)
        => SendAsync<UpdateMeResult>(HttpMethod.Patch, "/api/auth/me", request, authenticated: true, timeout: null, ct);

    /// <summary>POST /api/auth/logout。</summary>
    public Task<LogoutResult> LogoutAsync(CancellationToken ct = default)
        => SendAsync<LogoutResult>(HttpMethod.Post, "/api/auth/logout", new { }, authenticated: true, timeout: null, ct);

    /// <summary>
    /// 确保 token 新鲜：临期（5 分钟内）就主动续期。
    ///
    /// 由心跳循环周期性调用。已过绝对上限时不尝试续期 —— 那必然是 401，
    /// 只会白刷一次错误日志，且会让界面闪一下「会话失效」。
    /// </summary>
    public async Task EnsureFreshTokenAsync(CancellationToken ct = default)
    {
        if (!HasToken) return;
        if (_profile.IsSessionHardExpired) return;
        if (!_profile.NeedsRefresh) return;

        await RefreshAsync(ct).ConfigureAwait(false);
    }

    #endregion

    // ========================================================
    //  Rooms
    // ========================================================

    #region Rooms

    /// <summary>GET /api/rooms。</summary>
    public Task<RoomListResult> GetRoomsAsync(CancellationToken ct = default)
        => SendAsync<RoomListResult>(HttpMethod.Get, "/api/rooms", null, authenticated: true, timeout: null, ct);

    /// <summary>POST /api/rooms。</summary>
    public Task<RoomResult> CreateRoomAsync(string name, int? maxMembers = null, CancellationToken ct = default)
        => SendAsync<RoomResult>(
            HttpMethod.Post,
            "/api/rooms",
            new CreateRoomRequest { Name = name, MaxMembers = maxMembers },
            authenticated: true,
            timeout: null,
            ct);

    /// <summary>PATCH /api/rooms/{id}。</summary>
    public Task<RoomResult> UpdateRoomAsync(
        string roomId,
        string? name = null,
        int? maxMembers = null,
        CancellationToken ct = default)
        => SendAsync<RoomResult>(
            HttpMethod.Patch,
            $"/api/rooms/{Escape(roomId)}",
            new UpdateRoomRequest { Name = name, MaxMembers = maxMembers },
            authenticated: true,
            timeout: null,
            ct);

    /// <summary>DELETE /api/rooms/{id}。</summary>
    public Task<RoomDeletedResult> DeleteRoomAsync(string roomId, CancellationToken ct = default)
        => SendAsync<RoomDeletedResult>(HttpMethod.Delete, $"/api/rooms/{Escape(roomId)}", null, authenticated: true, timeout: null, ct);

    /// <summary>GET /api/rooms/default —— 拿（必要时创建）默认房间。</summary>
    public Task<RoomResult> GetDefaultRoomAsync(CancellationToken ct = default)
        => SendAsync<RoomResult>(HttpMethod.Get, "/api/rooms/default", null, authenticated: true, timeout: null, ct);

    /// <summary>GET /api/rooms/{id}/snapshot。</summary>
    public Task<RoomSnapshot> GetSnapshotAsync(string roomId, CancellationToken ct = default)
        => SendAsync<RoomSnapshot>(HttpMethod.Get, $"/api/rooms/{Escape(roomId)}/snapshot", null, authenticated: true, timeout: null, ct);

    /// <summary>GET /api/rooms/{id}/tracks —— 该房间当前已发布的轨道。</summary>
    public Task<RoomTracksResult> GetTracksAsync(string roomId, CancellationToken ct = default)
        => SendAsync<RoomTracksResult>(HttpMethod.Get, $"/api/rooms/{Escape(roomId)}/tracks", null, authenticated: true, timeout: null, ct);

    /// <summary>POST /api/rooms/{id}/join。</summary>
    public Task<RoomJoinResult> JoinRoomAsync(string roomId, CancellationToken ct = default)
        => SendAsync<RoomJoinResult>(HttpMethod.Post, $"/api/rooms/{Escape(roomId)}/join", new { }, authenticated: true, timeout: null, ct);

    /// <summary>POST /api/rooms/{id}/leave。</summary>
    public Task<RoomLeaveResult> LeaveRoomAsync(string roomId, CancellationToken ct = default)
        => SendAsync<RoomLeaveResult>(HttpMethod.Post, $"/api/rooms/{Escape(roomId)}/leave", new { }, authenticated: true, timeout: null, ct);

    /// <summary>
    /// POST /api/rooms/{id}/heartbeat —— 15 秒一次，维持房间内在线并推进版本号。
    /// 超时给得比默认短：心跳掉一拍无所谓，卡住主循环才是问题。
    /// </summary>
    public Task<RoomHeartbeatResult> RoomHeartbeatAsync(string roomId, CancellationToken ct = default)
        => SendAsync<RoomHeartbeatResult>(
            HttpMethod.Post,
            $"/api/rooms/{Escape(roomId)}/heartbeat",
            new { roomId },
            authenticated: true,
            timeout: TimeSpan.FromSeconds(10),
            ct);

    /// <summary>POST /api/rooms/{id}/mute —— 同步自己的麦克风开关给其他人看。</summary>
    public Task<RoomMuteResult> SetMutedAsync(string roomId, bool muted, CancellationToken ct = default)
        => SendAsync<RoomMuteResult>(
            HttpMethod.Post,
            $"/api/rooms/{Escape(roomId)}/mute",
            new MuteRequest { Muted = muted },
            authenticated: true,
            timeout: null,
            ct);

    /// <summary>
    /// POST /api/rooms/{id}/ws-ticket —— 领一次性握手票据。
    ///
    /// WebSocket API 无法自定义请求头，带不了 Bearer；
    /// 所以必须先走普通 HTTP 领票，再用返回的 wsUrl 连接。
    /// 票据是一次性的：每次（重）连都要重新领，不能缓存复用。
    /// </summary>
    public Task<WsTicket> GetWsTicketAsync(string roomId, CancellationToken ct = default)
        => SendAsync<WsTicket>(HttpMethod.Post, $"/api/rooms/{Escape(roomId)}/ws-ticket", new { }, authenticated: true, timeout: TimeSpan.FromSeconds(10), ct);

    #endregion

    // ========================================================
    //  RTC（SFU）
    //
    //  注意：这里只负责 HTTP 往返。<b>同一 sessionId 上的 SDP 变更必须串行</b>，
    //  串行化由上层 RtcSession 用每会话队列保证，不要在这一层并发调用 publish/renegotiate。
    // ========================================================

    #region Rtc

    /// <summary>POST /api/rtc/publish —— 发布自己的音轨。</summary>
    public Task<RtcPublishResult> PublishAsync(
        string roomId,
        string sdp,
        string trackName,
        string? mid = null,
        CancellationToken ct = default)
        => SendAsync<RtcPublishResult>(
            HttpMethod.Post,
            "/api/rtc/publish",
            new RtcPublishRequest { RoomId = roomId, Sdp = sdp, TrackName = trackName, Mid = mid },
            authenticated: true,
            timeout: TimeSpan.FromSeconds(30),
            ct);

    /// <summary>POST /api/rtc/subscribe-batch —— 一次请求在同一接收会话上拉多条远端轨道。</summary>
    public Task<RtcSubscribeBatchResult> SubscribeBatchAsync(
        string roomId,
        IReadOnlyList<RtcSubscribeTarget> tracks,
        string? sessionId = null,
        CancellationToken ct = default)
        => SendAsync<RtcSubscribeBatchResult>(
            HttpMethod.Post,
            "/api/rtc/subscribe-batch",
            new RtcSubscribeBatchRequest { RoomId = roomId, SessionId = sessionId, Tracks = tracks },
            authenticated: true,
            timeout: TimeSpan.FromSeconds(30),
            ct);

    /// <summary>POST /api/rtc/renegotiate —— 同一会话上的 SDP 变更（必须串行）。</summary>
    public Task<Unit> RenegotiateAsync(string roomId, string sessionId, string sdp, CancellationToken ct = default)
        => SendAsync<Unit>(
            HttpMethod.Post,
            "/api/rtc/renegotiate",
            new RtcRenegotiateRequest { RoomId = roomId, SessionId = sessionId, Sdp = sdp },
            authenticated: true,
            timeout: TimeSpan.FromSeconds(30),
            ct);

    /// <summary>POST /api/rtc/close —— 关闭轨道；force=true 表示直接关掉整个会话（离开房间时用）。</summary>
    public Task<Unit> CloseRtcAsync(
        string roomId,
        string sessionId,
        IReadOnlyList<string> trackNames,
        IReadOnlyList<string>? mids = null,
        bool? force = null,
        CancellationToken ct = default)
        => SendAsync<Unit>(
            HttpMethod.Post,
            "/api/rtc/close",
            new RtcCloseRequest
            {
                RoomId = roomId,
                SessionId = sessionId,
                TrackNames = trackNames,
                Mids = mids,
                Force = force,
            },
            authenticated: true,
            timeout: TimeSpan.FromSeconds(15),
            ct);

    #endregion

    // ========================================================
    //  Presence（服务器成员在线状态）
    // ========================================================

    #region Presence

    /// <summary>
    /// POST /api/presence/heartbeat —— 6 秒 / 15 秒一次，维持「连上了这台服务器」。
    ///
    /// 返回 <c>Banned=true</c> 表示已被移出服务器：服务端刻意用成功响应 + 标记，
    /// 避免高频心跳里的 403 被当成网络抖动忽略掉。调用方必须检查它。
    /// </summary>
    public Task<PresenceHeartbeatResult> PresenceHeartbeatAsync(
        string? roomId = null,
        string? roomName = null,
        PresenceStatus? status = null,
        bool? invitable = null,
        CancellationToken ct = default)
        => SendAsync<PresenceHeartbeatResult>(
            HttpMethod.Post,
            "/api/presence/heartbeat",
            new PresenceHeartbeatRequest
            {
                RoomId = roomId,
                RoomName = roomName,
                Status = status,
                Invitable = invitable,
            },
            authenticated: true,
            timeout: TimeSpan.FromSeconds(10),
            ct);

    /// <summary>POST /api/presence/poll —— 服务器成员快照 + 取走新邀请（服务端已消费）。</summary>
    public Task<PresenceSnapshot> PresencePollAsync(CancellationToken ct = default)
        => SendAsync<PresenceSnapshot>(
            HttpMethod.Post,
            "/api/presence/poll",
            new { },
            authenticated: true,
            timeout: TimeSpan.FromSeconds(10),
            ct);

    /// <summary>POST /api/presence/leave —— 主动下线（登出前调用）。</summary>
    public Task<PresenceLeaveResult> PresenceLeaveAsync(CancellationToken ct = default)
        => SendAsync<PresenceLeaveResult>(
            HttpMethod.Post,
            "/api/presence/leave",
            new { },
            authenticated: true,
            timeout: TimeSpan.FromSeconds(8),
            ct);

    /// <summary>POST /api/presence/invite —— 邀请某人进房间。</summary>
    public Task<PresenceInviteResult> PresenceInviteAsync(string toUid, string roomId, CancellationToken ct = default)
        => SendAsync<PresenceInviteResult>(
            HttpMethod.Post,
            "/api/presence/invite",
            new PresenceInviteRequest { ToUid = toUid, RoomId = roomId },
            authenticated: true,
            timeout: null,
            ct);

    /// <summary>POST /api/presence/kick —— 管理员踢人；durationMinutes 有值则同时封禁。</summary>
    public Task<PresenceKickResult> PresenceKickAsync(
        string uid,
        string? reason = null,
        int? durationMinutes = null,
        CancellationToken ct = default)
        => SendAsync<PresenceKickResult>(
            HttpMethod.Post,
            "/api/presence/kick",
            new PresenceKickRequest { Uid = uid, Reason = reason, DurationMinutes = durationMinutes },
            authenticated: true,
            timeout: null,
            ct);

    #endregion

    // --------------------------------------------------------
    //  杂项
    // --------------------------------------------------------

    /// <summary>服务端返回 中文错误文案 时，界面上常常需要一个「这是哪台服务器」的前缀。</summary>
    public string Describe() => $"{_profile.ResolveDisplayName()}（{BaseUrl}）";

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        if (OwnsHttpClient) Http.Dispose();
    }

    private static HttpClient CreateHttpClient()
    {
        var handler = new SocketsHttpHandler
        {
            // 原生端用 Bearer，不需要 cookie 容器 —— 省掉一份跨服务器串 cookie 的风险
            UseCookies = false,

            // 连接池：多服务器 + 心跳/轮询/WS 票据，8 条起步够用
            MaxConnectionsPerServer = 8,

            // 服务器可能重启换 IP，别把连接粘死太久
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            AutomaticDecompression = DecompressionMethods.All,
        };

        var client = new HttpClient(handler)
        {
            // 各请求自己设超时（心跳 10s、RTC 30s），这里给一个宽松的上限
            Timeout = Timeout.InfiniteTimeSpan,
        };

        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        client.DefaultRequestHeaders.UserAgent.ParseAdd("CfTeamspeed-Desktop/1.0");
        return client;
    }
}

/// <summary>
/// 「无返回值」的占位类型。
///
/// 后端有些接口只回 <c>{"ok":true}</c>（不带 data），用 Unit 让
/// <see cref="ApiClient"/> 的泛型通道保持一致，不必为它们另写一套非泛型方法。
///
/// 必须配 <see cref="UnitJsonConverter"/>：System.Text.Json 默认无法把一个
/// JSON 对象/null 映射到自定义 struct（会抛 JsonException），
/// 而 <c>{"ok":true}</c> 的 data 正是缺失/null。
/// </summary>
public readonly struct Unit : IEquatable<Unit>
{
    public static Unit Value => default;

    public bool Equals(Unit other) => true;

    public override bool Equals(object? obj) => obj is Unit;

    public override int GetHashCode() => 0;

    public override string ToString() => "()";
}

/// <summary>
/// Unit 的 JSON 转换：读写都当它是 null。
///
/// 关键是 <see cref="Read"/> 里主动 <c>reader.Skip()</c>：
/// 这样无论 data 是 null、对象还是别的东西，都能安全吞掉，
/// 不会因为服务端将来给这些接口加了返回体就把老客户端打挂。
/// </summary>
public sealed class UnitJsonConverter : JsonConverter<Unit>
{
    public override Unit Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        reader.Skip();
        return Unit.Value;
    }

    public override void Write(Utf8JsonWriter writer, Unit value, JsonSerializerOptions options)
        => writer.WriteNullValue();

    // 让 null 也能映射到 Unit（否则 data:null 仍会被默认逻辑拦下）
    public override Unit ReadAsPropertyName(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        reader.Skip();
        return Unit.Value;
    }
}
