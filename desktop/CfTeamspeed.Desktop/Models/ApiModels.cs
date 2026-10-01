using System.Text.Json;
using System.Text.Json.Serialization;

namespace CfTeamspeed.Desktop.Models;

// ============================================================
//  API 数据模型
//
//  与 shared/types.ts 一一对应，命名保持 camelCase（线上报文即 camelCase）。
//  统一约定：
//    - 服务端返回的「可空字段」在 C# 侧一律用可空引用/可空值类型表达；
//    - Unix 秒时间戳统一用 long（服务端为 number，秒级，不会溢出）；
//    - 反序列化只读，因此用 record + init，避免误改缓存对象。
//
//  序列化选项集中在 ApiJson.Options，全项目共用同一份，不要各自 new。
// ============================================================

/// <summary>身份角色。服务端只发 "guest" / "admin" 两种。</summary>
public enum Role
{
    Guest,
    Admin,
}

/// <summary>展示用在线状态。注意与「是否在线(online 布尔)」是两回事：隐身时 online=true 但 status=Invisible。</summary>
public enum PresenceStatus
{
    Online,
    Busy,
    Away,
    Invisible,
    Offline,
}

// ------------------------------------------------------------
//  枚举 ↔ 线格式字符串
//
//  System.Text.Json 内置的 JsonStringEnumConverter 对未知字符串会直接抛异常，
//  而后端将来新增角色/状态时，老客户端不应该整个请求失败。
//  这里统一走「自定义转换器 + 兜底值」，保证前向兼容。
// ------------------------------------------------------------

/// <summary>Role 的 JSON 转换（"guest"/"admin"，未知值按最小权限落到 Guest）。</summary>
public sealed class RoleJsonConverter : JsonConverter<Role>
{
    public override Role Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var raw = reader.GetString();
        return raw switch
        {
            "admin" => Role.Admin,
            _ => Role.Guest,
        };
    }

    public override void Write(Utf8JsonWriter writer, Role value, JsonSerializerOptions options)
        => writer.WriteStringValue(value == Role.Admin ? "admin" : "guest");
}

/// <summary>PresenceStatus 的 JSON 转换（未知值落到 Offline，最保守）。</summary>
public sealed class PresenceStatusJsonConverter : JsonConverter<PresenceStatus>
{
    public override PresenceStatus Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var raw = reader.GetString();
        return raw switch
        {
            "online" => PresenceStatus.Online,
            "busy" => PresenceStatus.Busy,
            "away" => PresenceStatus.Away,
            "invisible" => PresenceStatus.Invisible,
            _ => PresenceStatus.Offline,
        };
    }

    public override void Write(Utf8JsonWriter writer, PresenceStatus value, JsonSerializerOptions options)
        => writer.WriteStringValue(value switch
        {
            PresenceStatus.Online => "online",
            PresenceStatus.Busy => "busy",
            PresenceStatus.Away => "away",
            PresenceStatus.Invisible => "invisible",
            _ => "offline",
        });
}

/// <summary>全项目共用的 JSON 选项（Web 默认：camelCase + 大小写不敏感）。</summary>
public static class ApiJson
{
    public static JsonSerializerOptions Options { get; } = Create();

    private static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            // 报文里 null 字段很多，保留它们便于调试；写请求体时也不至于丢字段
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };
        options.Converters.Add(new RoleJsonConverter());
        options.Converters.Add(new PresenceStatusJsonConverter());

        // 「无返回值」接口（{"ok":true}）的 data 缺失/null，需要 Unit 转换器兜底，
        // 否则 ApiResult<Unit> 会在反序列化时抛 JsonException
        options.Converters.Add(new Services.UnitJsonConverter());
        return options;
    }
}

// ------------------------------------------------------------
//  响应信封
// ------------------------------------------------------------

/// <summary>
/// 统一响应信封：成功 <c>{"ok":true,"data":{...}}</c>，
/// 失败 <c>{"ok":false,"error":"中文","code":"STABLE_CODE"}</c>。
///
/// 用 <c>required</c> 而不是可空属性，是为了让「ok 缺失」在反序列化时直接抛异常，
/// 由 ApiClient 归一成"响应格式异常"，而不是悄悄当成失败或成功。
/// </summary>
public sealed class ApiResult<T>
{
    [JsonPropertyName("ok")]
    public required bool Ok { get; init; }

    [JsonPropertyName("data")]
    public T? Data { get; init; }

    /// <summary>面向用户的中文文案，可直接展示。不要按它做分支判断。</summary>
    [JsonPropertyName("error")]
    public string? Error { get; init; }

    /// <summary>稳定错误码，见 <see cref="ErrorCodes"/>。分支判断只认它。</summary>
    [JsonPropertyName("code")]
    public string? Code { get; init; }
}

/// <summary>
/// 错误码 —— 跨客户端契约的一部分。
///
/// 客户端按 code 分支，不解析中文文案（文案会随版本变化）。
/// 与 shared/types.ts 的 ErrorCode 保持逐字一致。
/// </summary>
public static class ErrorCodes
{
    /// <summary>key 无效。</summary>
    public const string InvalidKey = "INVALID_KEY";

    /// <summary>请求体 / 查询参数不合法（含校验失败）。</summary>
    public const string InvalidBody = "INVALID_BODY";

    /// <summary>昵称已被占用。</summary>
    public const string NicknameTaken = "NICKNAME_TAKEN";

    /// <summary>昵称为保留字（admin / 官方 …）。</summary>
    public const string NicknameReserved = "NICKNAME_RESERVED";

    /// <summary>昵称格式不合法。</summary>
    public const string NicknameInvalid = "NICKNAME_INVALID";

    /// <summary>未登录 / token 无效。</summary>
    public const string Unauthorized = "UNAUTHORIZED";

    /// <summary>会话超出绝对寿命，必须重新用 key 登录（不是「重试」而是「重新登录」）。</summary>
    public const string SessionExpired = "SESSION_EXPIRED";

    /// <summary>权限不足（不应据此把人踢下线）。</summary>
    public const string Forbidden = "FORBIDDEN";

    public const string RoomNotFound = "ROOM_NOT_FOUND";

    public const string RoomFull = "ROOM_FULL";

    public const string RateLimited = "RATE_LIMITED";

    /// <summary>已被移出服务器（封禁）：必须清理本地会话。</summary>
    public const string Banned = "BANNED";

    public const string TurnstileFailed = "TURNSTILE_FAILED";

    /// <summary>WebSocket ticket 无效 / 过期 / 已被使用（需要重新领票）。</summary>
    public const string BadTicket = "BAD_TICKET";

    public const string Internal = "INTERNAL";

    /// <summary>需要重新登录的错误码集合，客户端统一处理。</summary>
    public static readonly IReadOnlySet<string> AuthFailureCodes =
        new HashSet<string>(StringComparer.Ordinal) { Unauthorized, SessionExpired };
}

// ------------------------------------------------------------
//  配置 / 健康检查（公开接口）
// ------------------------------------------------------------

/// <summary>GET /api/auth/config —— 非敏感客户端配置，无需鉴权。</summary>
public sealed class ClientConfig
{
    [JsonPropertyName("appName")]
    public string AppName { get; init; } = "";

    /// <summary>Cloudflare Turnstile 站点 key；为空表示该服务器不需要人机验证。</summary>
    [JsonPropertyName("turnstileSiteKey")]
    public string TurnstileSiteKey { get; init; } = "";

    [JsonPropertyName("adminPath")]
    public string AdminPath { get; init; } = "/admin";

    [JsonPropertyName("maxRoomMembers")]
    public int MaxRoomMembers { get; init; }

    [JsonPropertyName("e2eeEnabled")]
    public bool E2eeEnabled { get; init; }

    [JsonPropertyName("e2eeFallback")]
    public bool E2eeFallback { get; init; }

    /// <summary>建议的 Opus 码率（kbps），客户端据此设置 SDP 里的 maxaveragebitrate。</summary>
    [JsonPropertyName("audioBitrateKbps")]
    public int AudioBitrateKbps { get; init; }

    /// <summary>
    /// 登录是否需要人机验证（**访客与管理员一视同仁**）。
    ///
    /// 声明为可空：老版本服务端没有这个字段，反序列化后是 null，
    /// 调用方据此回退到 <see cref="AdminLoginTurnstile"/>。
    /// </summary>
    [JsonPropertyName("loginTurnstile")]
    public bool? LoginTurnstile { get; init; }

    /// <summary>
    /// @deprecated 用 <see cref="LoginTurnstile"/>。
    /// 注意语义已变：新服务端下它不再表示「只有管理员需要」。
    /// 同样可空，兼容更老的服务端（那些连这个字段都没有）。
    /// </summary>
    [JsonPropertyName("adminLoginTurnstile")]
    public bool? AdminLoginTurnstile { get; init; }

    /// <summary>服务端是否开启了跨域白名单（排查第三方客户端问题用）。</summary>
    [JsonPropertyName("crossOrigin")]
    public bool CrossOrigin { get; init; }
}

/// <summary>GET /api/health</summary>
public sealed class HealthResult
{
    [JsonPropertyName("status")]
    public string Status { get; init; } = "";

    /// <summary>Unix 秒。</summary>
    [JsonPropertyName("time")]
    public long Time { get; init; }
}

// ------------------------------------------------------------
//  用户 / 会话
// ------------------------------------------------------------

/// <summary>用户资料。</summary>
public sealed class Profile
{
    [JsonPropertyName("uid")]
    public string Uid { get; init; } = "";

    [JsonPropertyName("nickname")]
    public string Nickname { get; init; } = "";

    [JsonPropertyName("role")]
    public Role Role { get; init; }

    /// <summary>预设头像 id（12 选 1），为空则由昵称自动生成。</summary>
    [JsonPropertyName("avatarId")]
    public string? AvatarId { get; init; }

    /// <summary>自定义上传头像的绝对 / 相对 URL，优先级高于 avatarId。</summary>
    [JsonPropertyName("avatarUrl")]
    public string? AvatarUrl { get; init; }
}

/// <summary>登录 / 续期 / 改资料返回的会话。<c>token</c> 是唯一需要持久化的凭据。</summary>
public sealed class SessionResult
{
    [JsonPropertyName("token")]
    public string Token { get; init; } = "";

    /// <summary>token 绝对过期时间（Unix 秒），用于提前续期。</summary>
    [JsonPropertyName("expiresAt")]
    public long ExpiresAt { get; init; }

    /// <summary>会话绝对上限（Unix 秒）；到此必须重新用 key 登录。</summary>
    [JsonPropertyName("sessionExpiresAt")]
    public long SessionExpiresAt { get; init; }

    [JsonPropertyName("role")]
    public Role Role { get; init; }

    [JsonPropertyName("profile")]
    public Profile? Profile { get; init; }
}

/// <summary>GET /api/auth/me。authMethod 服务端只发 "cookie" / "bearer"，原生端永远是 bearer；留成字符串以防将来扩展。</summary>
public sealed class MeResult
{
    [JsonPropertyName("profile")]
    public Profile? Profile { get; init; }

    [JsonPropertyName("authMethod")]
    public string AuthMethod { get; init; } = "bearer";

    [JsonPropertyName("expiresAt")]
    public long? ExpiresAt { get; init; }

    [JsonPropertyName("sessionExpiresAt")]
    public long SessionExpiresAt { get; init; }
}

/// <summary>PATCH /api/auth/me 的返回：改资料会顺带签发新 token。</summary>
public sealed class UpdateMeResult
{
    [JsonPropertyName("profile")]
    public Profile? Profile { get; init; }

    [JsonPropertyName("expiresAt")]
    public long ExpiresAt { get; init; }

    [JsonPropertyName("token")]
    public string Token { get; init; } = "";
}

/// <summary>POST /api/auth/logout</summary>
public sealed class LogoutResult
{
    [JsonPropertyName("loggedOut")]
    public bool LoggedOut { get; init; }
}

// ------------------------------------------------------------
//  房间
// ------------------------------------------------------------

/// <summary>房间概要。</summary>
public sealed class RoomSummary
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("ownerUid")]
    public string? OwnerUid { get; init; }

    [JsonPropertyName("memberCount")]
    public int MemberCount { get; init; }

    [JsonPropertyName("maxMembers")]
    public int MaxMembers { get; init; }

    /// <summary>Unix 秒。</summary>
    [JsonPropertyName("createdAt")]
    public long CreatedAt { get; init; }
}

/// <summary>房间内成员。</summary>
public sealed class RoomMember
{
    [JsonPropertyName("uid")]
    public string Uid { get; init; } = "";

    [JsonPropertyName("nickname")]
    public string Nickname { get; init; } = "";

    [JsonPropertyName("avatarId")]
    public string? AvatarId { get; init; }

    [JsonPropertyName("avatarUrl")]
    public string? AvatarUrl { get; init; }

    [JsonPropertyName("role")]
    public Role Role { get; init; }

    /// <summary>是否正在说话（客户端本地按音量计算后广播）。缺失时视为 false。</summary>
    [JsonPropertyName("speaking")]
    public bool Speaking { get; init; }

    /// <summary>麦克风是否关闭。</summary>
    [JsonPropertyName("muted")]
    public bool Muted { get; init; }

    /// <summary>Unix 秒。</summary>
    [JsonPropertyName("joinedAt")]
    public long JoinedAt { get; init; }

    /// <summary>Unix 秒。</summary>
    [JsonPropertyName("lastSeen")]
    public long LastSeen { get; init; }
}

/// <summary>
/// 房间列表项：概要 + 当前成员（侧栏在房间下展示人头）。
///
/// 刻意用组合而不是继承 <see cref="RoomSummary"/>：JSON 是扁平结构，
/// 继承虽然能少写几个属性，但会带来「基类可空、派生类字段名重复」等一堆别扭之处，
/// 而这里的字段本来就要逐字对齐报文，写全反而更清楚。
/// </summary>
public sealed class RoomWithMembers
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("ownerUid")]
    public string? OwnerUid { get; init; }

    [JsonPropertyName("memberCount")]
    public int MemberCount { get; init; }

    [JsonPropertyName("maxMembers")]
    public int MaxMembers { get; init; }

    [JsonPropertyName("createdAt")]
    public long CreatedAt { get; init; }

    [JsonPropertyName("members")]
    public IReadOnlyList<RoomMember> Members { get; init; } = Array.Empty<RoomMember>();

    /// <summary>把概要部分单独取出来（房间列表里大量逻辑只关心概要）。</summary>
    public RoomSummary ToSummary() => new()
    {
        Id = Id,
        Name = Name,
        OwnerUid = OwnerUid,
        MemberCount = MemberCount,
        MaxMembers = MaxMembers,
        CreatedAt = CreatedAt,
    };
}

/// <summary>GET /api/rooms</summary>
public sealed class RoomListResult
{
    [JsonPropertyName("rooms")]
    public IReadOnlyList<RoomWithMembers> Rooms { get; init; } = Array.Empty<RoomWithMembers>();
}

/// <summary>POST /api/rooms、PATCH /api/rooms/{id}、GET /api/rooms/default</summary>
public sealed class RoomResult
{
    [JsonPropertyName("room")]
    public RoomSummary? Room { get; init; }
}

/// <summary>DELETE /api/rooms/{id}</summary>
public sealed class RoomDeletedResult
{
    [JsonPropertyName("deleted")]
    public bool Deleted { get; init; }

    [JsonPropertyName("id")]
    public string Id { get; init; } = "";
}

/// <summary>房间快照（GET snapshot / join 内嵌）。</summary>
public sealed class RoomSnapshot
{
    [JsonPropertyName("room")]
    public RoomSummary? Room { get; init; }

    [JsonPropertyName("members")]
    public IReadOnlyList<RoomMember> Members { get; init; } = Array.Empty<RoomMember>();

    /// <summary>乐观并发版本号，心跳与 WS 事件都会带着它推进。</summary>
    [JsonPropertyName("version")]
    public long Version { get; init; }
}

/// <summary>房间内的一条已发布轨道。</summary>
public sealed class RoomTrack
{
    [JsonPropertyName("trackName")]
    public string TrackName { get; init; } = "";

    [JsonPropertyName("uid")]
    public string Uid { get; init; } = "";

    /// <summary>发布者所属的 SFU 会话 id。</summary>
    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = "";

    [JsonPropertyName("mid")]
    public string? Mid { get; init; }
}

/// <summary>GET /api/rooms/{id}/tracks</summary>
public sealed class RoomTracksResult
{
    [JsonPropertyName("tracks")]
    public IReadOnlyList<RoomTrack> Tracks { get; init; } = Array.Empty<RoomTrack>();
}

/// <summary>POST /api/rooms/{id}/join</summary>
public sealed class RoomJoinResult
{
    [JsonPropertyName("snapshot")]
    public RoomSnapshot? Snapshot { get; init; }

    /// <summary>当前生效的房间 key 版本，key 轮换后会变。</summary>
    [JsonPropertyName("keyId")]
    public string KeyId { get; init; } = "";
}

/// <summary>POST /api/rooms/{id}/leave</summary>
public sealed class RoomLeaveResult
{
    [JsonPropertyName("left")]
    public bool Left { get; init; }
}

/// <summary>POST /api/rooms/{id}/heartbeat</summary>
public sealed class RoomHeartbeatResult
{
    [JsonPropertyName("version")]
    public long Version { get; init; }

    /// <summary>本轮被服务端清理的僵尸成员数。</summary>
    [JsonPropertyName("reaped")]
    public int Reaped { get; init; }
}

/// <summary>POST /api/rooms/{id}/mute</summary>
public sealed class RoomMuteResult
{
    [JsonPropertyName("muted")]
    public bool Muted { get; init; }
}

/// <summary>POST /api/rooms/{id}/ws-ticket —— 一次性握手票据。</summary>
public sealed class WsTicket
{
    [JsonPropertyName("ticket")]
    public string Ticket { get; init; } = "";

    /// <summary>Unix 秒。票据很短命，过期必须重新领。</summary>
    [JsonPropertyName("expiresAt")]
    public long ExpiresAt { get; init; }

    /// <summary>可直接连接的 WebSocket 地址（ticket 已拼进 query），客户端无需自己拼。</summary>
    [JsonPropertyName("wsUrl")]
    public string WsUrl { get; init; } = "";
}

// ------------------------------------------------------------
//  SFU RTC
//
//  SDP 用不透明字符串透传：服务端只做转发/改写，客户端也不需要解析它，
//  唯一例外是音频码率注入（由 Rtc 层在发出去之前改字符串）。
// ------------------------------------------------------------

/// <summary>SFU 返回的一条轨道结果。</summary>
public sealed class RtcTrackResult
{
    [JsonPropertyName("mid")]
    public string? Mid { get; init; }

    [JsonPropertyName("trackName")]
    public string? TrackName { get; init; }

    /// <summary>该轨道订阅失败时的原因（批量订阅是部分成功语义）。</summary>
    [JsonPropertyName("error")]
    public string? Error { get; init; }
}

/// <summary>POST /api/rtc/publish 的返回。</summary>
public sealed class RtcPublishResult
{
    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = "";

    /// <summary>服务端应答 SDP（JSON 形式的 RTCSessionDescriptionInit，原样透传给 WebRTC 层）。</summary>
    [JsonPropertyName("sessionDescription")]
    public JsonElement SessionDescription { get; init; }

    [JsonPropertyName("tracks")]
    public IReadOnlyList<RtcTrackResult> Tracks { get; init; } = Array.Empty<RtcTrackResult>();
}

/// <summary>POST /api/rtc/subscribe-batch 的返回（一次请求在同一接收会话上拉多条远端轨道）。</summary>
public sealed class RtcSubscribeBatchResult
{
    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = "";

    [JsonPropertyName("sessionDescription")]
    public JsonElement SessionDescription { get; init; }

    [JsonPropertyName("tracks")]
    public IReadOnlyList<RtcTrackResult> Tracks { get; init; } = Array.Empty<RtcTrackResult>();
}

// ------------------------------------------------------------
//  Presence（服务器成员在线状态）
// ------------------------------------------------------------

/// <summary>服务器在线成员。</summary>
public sealed class PresenceUser
{
    [JsonPropertyName("uid")]
    public string Uid { get; init; } = "";

    [JsonPropertyName("nickname")]
    public string Nickname { get; init; } = "";

    [JsonPropertyName("role")]
    public Role Role { get; init; }

    [JsonPropertyName("avatarId")]
    public string? AvatarId { get; init; }

    [JsonPropertyName("avatarUrl")]
    public string? AvatarUrl { get; init; }

    /// <summary>是否保持活跃心跳。隐身时为 true，但 status=Invisible。</summary>
    [JsonPropertyName("online")]
    public bool Online { get; init; }

    [JsonPropertyName("status")]
    public PresenceStatus Status { get; init; }

    /// <summary>是否允许被邀请进房间。</summary>
    [JsonPropertyName("invitable")]
    public bool Invitable { get; init; }

    /// <summary>当前所在房间，不在任何房间为 null。</summary>
    [JsonPropertyName("roomId")]
    public string? RoomId { get; init; }

    [JsonPropertyName("roomName")]
    public string? RoomName { get; init; }

    /// <summary>Unix 秒。</summary>
    [JsonPropertyName("lastSeen")]
    public long LastSeen { get; init; }
}

/// <summary>邀请入频道。</summary>
public sealed class PresenceInvite
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("fromUid")]
    public string FromUid { get; init; } = "";

    [JsonPropertyName("fromNickname")]
    public string FromNickname { get; init; } = "";

    [JsonPropertyName("roomId")]
    public string RoomId { get; init; } = "";

    [JsonPropertyName("roomName")]
    public string RoomName { get; init; } = "";

    /// <summary>Unix 秒。</summary>
    [JsonPropertyName("createdAt")]
    public long CreatedAt { get; init; }
}

/// <summary>POST /api/presence/poll —— 服务器成员快照 + 本次新收到的邀请（服务端已消费）。</summary>
public sealed class PresenceSnapshot
{
    [JsonPropertyName("online")]
    public IReadOnlyList<PresenceUser> Online { get; init; } = Array.Empty<PresenceUser>();

    /// <summary>已注册但当前未连接的用户；仅管理员可见，普通用户拿到空数组。</summary>
    [JsonPropertyName("offline")]
    public IReadOnlyList<PresenceUser> Offline { get; init; } = Array.Empty<PresenceUser>();

    [JsonPropertyName("invites")]
    public IReadOnlyList<PresenceInvite> Invites { get; init; } = Array.Empty<PresenceInvite>();

    /// <summary>服务端当前时间（Unix 秒），用于校正本地时钟偏差。</summary>
    [JsonPropertyName("serverTime")]
    public long ServerTime { get; init; }
}

/// <summary>
/// POST /api/presence/heartbeat 的返回。
///
/// <c>banned: true</c> = 已被移出服务器：服务端用「成功响应 + 标记」而不是 403，
/// 是为了避免高频心跳里的错误被当成网络抖动忽略掉。
/// </summary>
public sealed class PresenceHeartbeatResult
{
    [JsonPropertyName("alive")]
    public bool Alive { get; init; }

    [JsonPropertyName("banned")]
    public bool Banned { get; init; }
}

/// <summary>POST /api/presence/leave</summary>
public sealed class PresenceLeaveResult
{
    [JsonPropertyName("dropped")]
    public bool Dropped { get; init; }
}

/// <summary>POST /api/presence/invite</summary>
public sealed class PresenceInviteResult
{
    [JsonPropertyName("sent")]
    public bool Sent { get; init; }

    /// <summary>未发送成功时的中文原因（对方隐身 / 不可邀请 …）。</summary>
    [JsonPropertyName("reason")]
    public string? Reason { get; init; }
}

/// <summary>POST /api/presence/kick（管理员踢出服务器）。</summary>
public sealed class PresenceKickResult
{
    [JsonPropertyName("kicked")]
    public bool Kicked { get; init; }

    [JsonPropertyName("banned")]
    public bool Banned { get; init; }

    [JsonPropertyName("roomId")]
    public string? RoomId { get; init; }
}

// ------------------------------------------------------------
//  请求体
// ------------------------------------------------------------

/// <summary>POST /api/auth/login 请求体。</summary>
public sealed class LoginRequest
{
    [JsonPropertyName("key")]
    public string Key { get; init; } = "";

    [JsonPropertyName("nickname")]
    public string Nickname { get; init; } = "";

    [JsonPropertyName("avatarId")]
    public string? AvatarId { get; init; }

    /// <summary>人机验证 token；服务器未开启 Turnstile 时传 null。</summary>
    [JsonPropertyName("turnstileToken")]
    public string? TurnstileToken { get; init; }
}

/// <summary>PATCH /api/auth/me 请求体。null 字段会被序列化省略（见 <see cref="JsonIgnoreCondition.WhenWritingNull"/>）。</summary>
public sealed class UpdateProfileRequest
{
    [JsonPropertyName("nickname")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Nickname { get; init; }

    [JsonPropertyName("avatarId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? AvatarId { get; init; }

    /// <summary>data:image/...;base64,... 形式的内联头像；服务端会转存并签出 avatarUrl。</summary>
    [JsonPropertyName("avatarDataUrl")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? AvatarDataUrl { get; init; }
}

/// <summary>POST /api/rooms 请求体。</summary>
public sealed class CreateRoomRequest
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("maxMembers")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MaxMembers { get; init; }
}

/// <summary>PATCH /api/rooms/{id} 请求体（均为可选，只发改动的字段）。</summary>
public sealed class UpdateRoomRequest
{
    [JsonPropertyName("name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Name { get; init; }

    [JsonPropertyName("maxMembers")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MaxMembers { get; init; }
}

/// <summary>POST /api/rooms/{id}/mute 请求体。</summary>
public sealed class MuteRequest
{
    [JsonPropertyName("muted")]
    public bool Muted { get; init; }
}

/// <summary>POST /api/rtc/publish 请求体。</summary>
public sealed class RtcPublishRequest
{
    [JsonPropertyName("roomId")]
    public string RoomId { get; init; } = "";

    [JsonPropertyName("sdp")]
    public string Sdp { get; init; } = "";

    [JsonPropertyName("trackName")]
    public string TrackName { get; init; } = "";

    /// <summary>重协商时复用既有 mid；首次发布为 null。</summary>
    [JsonPropertyName("mid")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mid { get; init; }
}

/// <summary>批量订阅里的一项。</summary>
public sealed class RtcSubscribeTarget
{
    [JsonPropertyName("publisherSessionId")]
    public string PublisherSessionId { get; init; } = "";

    [JsonPropertyName("trackName")]
    public string TrackName { get; init; } = "";
}

/// <summary>POST /api/rtc/subscribe-batch 请求体。</summary>
public sealed class RtcSubscribeBatchRequest
{
    [JsonPropertyName("roomId")]
    public string RoomId { get; init; } = "";

    /// <summary>复用既有接收会话；为 null 时服务端新建一个。</summary>
    [JsonPropertyName("sessionId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SessionId { get; init; }

    [JsonPropertyName("tracks")]
    public IReadOnlyList<RtcSubscribeTarget> Tracks { get; init; } = Array.Empty<RtcSubscribeTarget>();
}

/// <summary>POST /api/rtc/renegotiate 请求体。</summary>
public sealed class RtcRenegotiateRequest
{
    [JsonPropertyName("roomId")]
    public string RoomId { get; init; } = "";

    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = "";

    [JsonPropertyName("sdp")]
    public string Sdp { get; init; } = "";
}

/// <summary>POST /api/rtc/close 请求体。</summary>
public sealed class RtcCloseRequest
{
    [JsonPropertyName("roomId")]
    public string RoomId { get; init; } = "";

    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = "";

    [JsonPropertyName("trackNames")]
    public IReadOnlyList<string> TrackNames { get; init; } = Array.Empty<string>();

    [JsonPropertyName("mids")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? Mids { get; init; }

    /// <summary>true = 直接关掉整个会话（离开房间时用），忽略 trackNames。</summary>
    [JsonPropertyName("force")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Force { get; init; }
}

/// <summary>POST /api/presence/heartbeat 请求体。</summary>
public sealed class PresenceHeartbeatRequest
{
    [JsonPropertyName("roomId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RoomId { get; init; }

    [JsonPropertyName("roomName")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RoomName { get; init; }

    [JsonPropertyName("status")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public PresenceStatus? Status { get; init; }

    [JsonPropertyName("invitable")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Invitable { get; init; }
}

/// <summary>POST /api/presence/invite 请求体。</summary>
public sealed class PresenceInviteRequest
{
    [JsonPropertyName("toUid")]
    public string ToUid { get; init; } = "";

    [JsonPropertyName("roomId")]
    public string RoomId { get; init; } = "";
}

/// <summary>POST /api/presence/kick 请求体。</summary>
public sealed class PresenceKickRequest
{
    [JsonPropertyName("uid")]
    public string Uid { get; init; } = "";

    [JsonPropertyName("reason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; init; }

    /// <summary>封禁时长（分钟）；为 null 表示仅踢出、不封禁。</summary>
    [JsonPropertyName("durationMinutes")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? DurationMinutes { get; init; }
}
