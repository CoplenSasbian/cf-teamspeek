// ============================================================
//  cf-teamspeed — 共享类型定义
//  服务端（workers/）与客户端（app/）共用
// ============================================================

/** 身份角色 */
export type Role = 'guest' | 'admin';

/** 会话 JWT payload */
export interface SessionPayload {
  uid: string;
  nickname: string;
  role: Role;
  iat?: number;
  exp?: number;
}

/** 非敏感前端配置（GET /api/auth/config，无需鉴权） */
export interface ClientConfig {
  appName: string;
  turnstileSiteKey: string;
  adminPath: string;
  maxRoomMembers: number;
  e2eeEnabled: boolean;
  e2eeFallback: boolean;
  audioBitrateKbps: number;
  /**
   * 登录是否需要人机验证。
   *
   * **访客与管理员都需要**（服务端一视同仁）。客户端应据此决定是否渲染
   * Turnstile；原生客户端在需要时必须内嵌浏览器引擎才能登录。
   * 部署方可用 `LOGIN_TURNSTILE=false` 整体关闭。
   */
  loginTurnstile: boolean;
  /**
   * @deprecated 用 `loginTurnstile`。
   * 保留字段仅为兼容尚未升级的旧客户端（它们的类型里只有这个字段）。
   * 注意语义已变：现在**不再**表示「只有管理员需要」。
   */
  adminLoginTurnstile: boolean;
  /** 服务端是否开启了跨域白名单（第三方网页客户端排查用） */
  crossOrigin: boolean;
}

/**
 * 登录 / 续期 / 改资料 返回的会话。
 *
 * `token` 是唯一需要持久化的凭据：任何客户端（网页 / 原生 / CLI）
 * 都可以把它放进 `Authorization: Bearer <token>`。
 * 网页端额外拿到 HttpOnly Cookie，可以完全不碰 token。
 */
export interface SessionResult {
  token: string;
  /** token 绝对过期时间（Unix 秒） */
  expiresAt: number;
  /** 会话绝对上限（Unix 秒）；到此必须重新用 key 登录 */
  sessionExpiresAt: number;
  role: Role;
  profile: Profile;
}

/** WebSocket 握手 ticket（POST /api/rooms/:id/ws-ticket） */
export interface WsTicket {
  ticket: string;
  /** 过期时间（Unix 秒） */
  expiresAt: number;
  /** 直接可用的 WebSocket 地址（含 ticket），客户端无需自己拼 */
  wsUrl: string;
}

/** 用户资料（登录后回传） */
export interface Profile {
  uid: string;
  nickname: string;
  role: Role;
  /** 预设头像 id（12 选 1），为空则用昵称自动生成 */
  avatarId: string | null;
  /** 自定义上传头像的 URL（服务端签发，优先级高于 avatarId） */
  avatarUrl: string | null;
}

/** 房间概要 */
export interface RoomSummary {
  id: string;
  name: string;
  ownerUid: string | null;
  memberCount: number;
  maxMembers: number;
  createdAt: number;
}

/** 房间列表项：概要 + 当前成员（侧栏用来在房间下展示人头） */
export interface RoomWithMembers extends RoomSummary {
  members: RoomMember[];
}

/** 房间内成员 */
export interface RoomMember {
  uid: string;
  nickname: string;
  avatarId: string | null;
  avatarUrl: string | null;
  role: Role;
  /** 是否正在说话（客户端本地计算后广播） */
  speaking?: boolean;
  /** 麦克风是否开启 */
  muted: boolean;
  joinedAt: number;
  lastSeen: number;
}

/** 房间快照（GET /api/rooms/:id/snapshot） */
export interface RoomSnapshot {
  room: RoomSummary;
  members: RoomMember[];
  version: number;
}

/**
 * 服务器在线成员（Presence）
 *
 * 本应用没有独立的「服务器」实体：一个部署即一台服务器。
 * 只要保持 presence 心跳，就算「连上了这台服务器」。
 */
/** 在线状态 */
export type PresenceStatus = 'online' | 'busy' | 'away' | 'invisible' | 'offline';

export interface PresenceUser {
  uid: string;
  nickname: string;
  role: Role;
  avatarId: string | null;
  avatarUrl: string | null;
  /** 是否保持活跃心跳（在线） */
  online: boolean;
  /** 展示状态：online 在线 / busy 忙碌 / away 离开 / invisible 隐身 */
  status: PresenceStatus;
  /** 是否允许被邀请进房间 */
  invitable: boolean;
  /** 当前所在房间（不在任何房间为 null） */
  roomId: string | null;
  roomName: string | null;
  /** 最后一次心跳时间戳 */
  lastSeen: number;
}

/** 邀请入频道（房间） */
export interface PresenceInvite {
  id: string;
  fromUid: string;
  fromNickname: string;
  roomId: string;
  roomName: string;
  createdAt: number;
}

/** 服务器成员快照（POST /api/presence/poll） */
export interface PresenceSnapshot {
  online: PresenceUser[];
  /** 已注册但当前未连接的用户；仅管理员可见 */
  offline: PresenceUser[];
  /** 本次轮询新收到的邀请（服务端已消费） */
  invites: PresenceInvite[];
  serverTime: number;
}

/** WebSocket 下行事件 */
export type RoomEvent =
  | { type: 'room-changed'; version: number }
  | { type: 'member-joined'; member: RoomMember }
  | { type: 'member-left'; uid: string }
  | { type: 'key-rotated'; keyId: string }
  | { type: 'kicked'; reason: string }
  | { type: 'room-closed'; reason: string };

/** 统一 API 响应包装 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

/**
 * 错误码 —— **跨客户端契约的一部分**。
 *
 * 客户端应当按 `code` 分支处理（而不是解析中文 error 文案），
 * 文案只用于展示，可能随版本变化。
 */
export const ErrorCode = {
  /** key 无效 */
  INVALID_KEY: 'INVALID_KEY',
  /** 请求体/查询参数不合法（含 Zod 校验失败） */
  INVALID_BODY: 'INVALID_BODY',
  /** 昵称已被占用 */
  NICKNAME_TAKEN: 'NICKNAME_TAKEN',
  /** 昵称为保留字（admin / 官方 …） */
  NICKNAME_RESERVED: 'NICKNAME_RESERVED',
  /** 昵称格式不合法 */
  NICKNAME_INVALID: 'NICKNAME_INVALID',
  /** 未登录 / token 无效 */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /**
   * 会话超出绝对寿命，必须重新登录。
   * 与 UNAUTHORIZED 的区别：这不是「token 写错了」，而是「该重新登录了」，
   * 客户端应清理本地会话并跳登录页，而不是重试。
   */
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  /** 权限不足 */
  FORBIDDEN: 'FORBIDDEN',
  /** 房间不存在 */
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  /** 房间已满 */
  ROOM_FULL: 'ROOM_FULL',
  /** 请求过于频繁 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 已被移出服务器（封禁） */
  BANNED: 'BANNED',
  /** 人机验证未通过 */
  TURNSTILE_FAILED: 'TURNSTILE_FAILED',
  /** WebSocket ticket 无效/过期/已被使用 */
  BAD_TICKET: 'BAD_TICKET',
  /** 服务端内部错误（含 SFU 调用失败） */
  INTERNAL: 'INTERNAL',
} as const;

/** 需要重新登录的错误码集合（客户端统一处理） */
export const AUTH_ERROR_CODES: readonly string[] = [
  ErrorCode.UNAUTHORIZED,
  ErrorCode.SESSION_EXPIRED,
];

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 管理员后台概览数据 */
export interface OverviewResponse {
  stats: { roomCount: number; totalMembers: number; registeredUsers: number };
  rooms: Array<{
    id: string;
    name: string;
    memberCount: number;
    maxMembers: number;
    members: RoomMember[];
    trackCount: number;
    createdAt: number;
  }>;
  auditBacklog: number;
  usageNow: Record<string, number>;
  serverTime: number;
}

/** 用量看板数据 */
export interface UsageResponse {
  series: Record<string, Record<string, number>>;
  live: Record<string, number>;
  freeTier: Record<string, number>;
  days: number;
}
