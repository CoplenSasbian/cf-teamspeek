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

/** 错误码 */
export const ErrorCode = {
  INVALID_KEY: 'INVALID_KEY',
  INVALID_BODY: 'INVALID_BODY',
  NICKNAME_TAKEN: 'NICKNAME_TAKEN',
  NICKNAME_RESERVED: 'NICKNAME_RESERVED',
  NICKNAME_INVALID: 'NICKNAME_INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  RATE_LIMITED: 'RATE_LIMITED',
  BANNED: 'BANNED',
  TURNSTILE_FAILED: 'TURNSTILE_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

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
