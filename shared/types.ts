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
