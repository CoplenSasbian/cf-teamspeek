import type { ApiResult } from '@shared/types';

/**
 * 后端 API 客户端。
 * baseUrl 由设置决定；会话靠 HttpOnly Cookie 自动携带。
 */
let baseUrl = '';

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, '');
}

export function getBaseUrl(): string {
  return baseUrl;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'include', // 带上 HttpOnly Cookie
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  let body: ApiResult<T> | null = null;
  try {
    body = (await res.json()) as ApiResult<T>;
  } catch {
    /* 非 JSON 响应 */
  }

  if (!res.ok || !body || body.ok !== true) {
    const message = body && body.ok === false ? body.error : `请求失败（${res.status}）`;
    const code = body && body.ok === false ? body.code : undefined;
    throw new ApiError(message, code, res.status);
  }

  return body.data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ------------------------------------------------------------
//  具体接口
// ------------------------------------------------------------

export interface ClientConfig {
  appName: string;
  turnstileSiteKey: string;
  adminPath: string;
  maxRoomMembers: number;
  e2eeEnabled: boolean;
  e2eeFallback: boolean;
  audioBitrateKbps: number;
}

export interface LoginResult {
  token: string;
  role: 'guest' | 'admin';
  profile: {
    uid: string;
    nickname: string;
    role: 'guest' | 'admin';
    avatarId: string | null;
    avatarUrl: string | null;
  };
}

export const authApi = {
  config: () => api.get<ClientConfig>('/api/auth/config'),
  login: (body: {
    key: string;
    nickname: string;
    avatarId?: string | null;
    turnstileToken?: string | null;
  }) => api.post<LoginResult>('/api/auth/login', body),
  me: () => api.get<{ profile: LoginResult['profile'] }>('/api/auth/me'),
  updateMe: (body: {
    nickname?: string;
    avatarId?: string | null;
    avatarDataUrl?: string | null;
  }) => api.patch<{ profile: LoginResult['profile']; token: string }>('/api/auth/me', body),
  logout: () => api.post<{ loggedOut: boolean }>('/api/auth/logout'),
};

export const roomsApi = {
  list: () =>
    api.get<{ rooms: import('@shared/types').RoomWithMembers[] }>('/api/rooms'),
  create: (body: { name: string; maxMembers?: number }) =>
    api.post<{ room: import('@shared/types').RoomSummary }>('/api/rooms', body),
  update: (id: string, body: { name?: string; maxMembers?: number }) =>
    api.patch<{ room: import('@shared/types').RoomSummary }>(`/api/rooms/${id}`, body),
  remove: (id: string) => api.delete<{ deleted: boolean; id: string }>(`/api/rooms/${id}`),
  ensureDefault: () =>
    api.get<{ room: import('@shared/types').RoomSummary }>('/api/rooms/default'),
  snapshot: (id: string) =>
    api.get<import('@shared/types').RoomSnapshot>(`/api/rooms/${id}/snapshot`),
  tracks: (id: string) =>
    api.get<{
      tracks: Array<{ trackName: string; uid: string; sessionId: string; mid: string | null }>;
    }>(`/api/rooms/${id}/tracks`),
  join: (id: string) =>
    api.post<{ snapshot: import('@shared/types').RoomSnapshot; keyId: string }>(
      `/api/rooms/${id}/join`,
    ),
  leave: (id: string) => api.post<{ left: boolean }>(`/api/rooms/${id}/leave`),
  heartbeat: (id: string) =>
    api.post<{ version: number; reaped: number }>(`/api/rooms/${id}/heartbeat`, { roomId: id }),
  mute: (id: string, muted: boolean) =>
    api.post<{ muted: boolean }>(`/api/rooms/${id}/mute`, { muted }),
};

export const presenceApi = {
  /** 心跳：登记在线状态与当前房间 */
  heartbeat: (body: {
    roomId?: string | null;
    roomName?: string | null;
    status?: import('@shared/types').PresenceStatus;
    invitable?: boolean;
  }) => api.post<{ alive: boolean }>('/api/presence/heartbeat', body),
  /** 轮询：服务器成员快照 + 取走新邀请 */
  poll: () => api.post<import('@shared/types').PresenceSnapshot>('/api/presence/poll', {}),
  /** 主动下线（登出前调用） */
  leave: () => api.post<{ dropped: boolean }>('/api/presence/leave', {}),
  /** 邀请某人加入房间 */
  invite: (body: { toUid: string; roomId: string }) =>
    api.post<{ sent: boolean; reason?: string }>('/api/presence/invite', body),
  /** 管理员：踢出服务器 */
  kick: (body: { uid: string; reason?: string; durationMinutes?: number }) =>
    api.post<{ kicked: boolean; banned: boolean; roomId: string | null }>(
      '/api/presence/kick',
      body,
    ),
};

export const rtcApi = {
  publish: (body: { roomId: string; sdp: string; trackName: string; mid?: string }) =>
    api.post<{
      sessionId: string;
      sessionDescription: RTCSessionDescriptionInit;
      tracks: Array<{ mid?: string; trackName?: string }>;
    }>('/api/rtc/publish', body),
  subscribe: (body: { roomId: string; publisherSessionId: string; trackName: string }) =>
    api.post<{
      sessionId: string;
      sessionDescription: RTCSessionDescriptionInit;
      requiresImmediateRenegotiation: boolean;
    }>('/api/rtc/subscribe', body),
  /** 批量订阅：一次请求在【同一接收会话】上拉取多条远端轨道 */
  subscribeBatch: (body: {
    roomId: string;
    sessionId?: string;
    tracks: Array<{ publisherSessionId: string; trackName: string }>;
  }) =>
    api.post<{
      sessionId: string;
      sessionDescription: RTCSessionDescriptionInit;
      tracks: Array<{ mid?: string; trackName?: string; error?: unknown }>;
    }>('/api/rtc/subscribe-batch', body),
  renegotiate: (body: { roomId: string; sessionId: string; sdp: string }) =>
    api.post<unknown>('/api/rtc/renegotiate', body),
  close: (body: {
    roomId: string;
    sessionId: string;
    trackNames: string[];
    mids?: string[];
    force?: boolean;
  }) => api.post<unknown>('/api/rtc/close', body),
  reportUsage: (bytes: number) => api.post<{ recorded: boolean }>('/api/rtc/usage', { bytes }),
};

export const adminApi = {
  overview: () =>
    api.get<{
      stats: { roomCount: number; totalMembers: number; registeredUsers: number };
      rooms: Array<{
        id: string;
        name: string;
        memberCount: number;
        maxMembers: number;
        members: import('@shared/types').RoomMember[];
        trackCount: number;
        createdAt: number;
      }>;
      auditBacklog: number;
      usageNow: Record<string, number>;
      serverTime: number;
    }>('/api/admin/overview'),
  usage: (days = 7) =>
    api.get<{
      series: Record<string, Record<string, number>>;
      live: Record<string, number>;
      freeTier: Record<string, number>;
      days: number;
    }>(`/api/admin/usage?days=${days}`),
  audit: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();
    return api.get<{ rows: Record<string, unknown>[]; total: number; page: number; pageSize: number }>(
      `/api/admin/audit?${qs}`,
    );
  },
  auditExportUrl: () => `${baseUrl}/api/admin/audit/export`,
  kick: (body: { roomId: string; uid: string; reason?: string }) =>
    api.post<{ ok: boolean }>('/api/admin/kick', body),
  closeRoom: (id: string) => api.post<{ closed: boolean }>(`/api/admin/rooms/${id}/close`),
  deleteRoom: (id: string) => api.delete<{ deleted: boolean; id: string }>(`/api/admin/rooms/${id}`),
  rotateKey: (id: string) => api.post<{ keyId: string }>(`/api/admin/rooms/${id}/rotate-key`),
  setLimit: (id: string, maxMembers: number) =>
    api.patch<import('@shared/types').RoomSummary>(`/api/admin/rooms/${id}/limit`, { maxMembers }),
  renameRoom: (id: string, name: string) =>
    api.patch<import('@shared/types').RoomSummary>(`/api/admin/rooms/${id}`, { name }),
  bans: () =>
    api.get<{
      bans: Array<{
        id: string;
        kind: string;
        value: string;
        reason: string | null;
        createdAt: number;
        expiresAt: number | null;
      }>;
    }>('/api/admin/bans'),
  addBan: (body: { kind: 'ip' | 'nickname'; value: string; reason?: string; durationMinutes?: number }) =>
    api.post<{ id: string }>('/api/admin/bans', body),
  removeBan: (id: string) => api.delete<{ removed: boolean }>(`/api/admin/bans/${id}`),
  users: () =>
    api.get<{ users: import('@shared/types').Profile[] }>('/api/admin/users'),
  releaseNickname: (nickname: string) =>
    api.delete<{ released: boolean }>(`/api/admin/users/${encodeURIComponent(nickname)}`),
  flush: () =>
    api.post<{ audit: number; usage: Record<string, number>; pruned: number }>('/api/admin/flush'),
};
