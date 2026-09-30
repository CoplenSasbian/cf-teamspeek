import type { ApiResult, ClientConfig, SessionResult, WsTicket } from '@shared/types';
import { ErrorCode } from '@shared/types';
import { clearSession, getSessionToken, saveSession } from './settings';

/**
 * 后端 API 客户端。
 *
 * 两套凭据同时使用，服务端 Bearer 优先：
 *   - HttpOnly Cookie：浏览器自动携带，前端无需操心（同源）
 *   - `Authorization: Bearer`：跨客户端通用形态，原生 / 脚本 / 第三方网页都用它
 *
 * 网页端也主动带 Bearer，是为了让「网页能跑」等价于「别的客户端也能跑」——
 * 凡是只有 cookie 才能跑通的路径，都属于需要在服务端修掉的缺陷。
 */
let baseUrl = '';

/** 会话到期时的全局回调（由应用外壳注册，用于跳回登录页） */
let onSessionExpired: (() => void) | null = null;

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, '');
}

export function getBaseUrl(): string {
  return baseUrl;
}

/** 注册会话失效回调（401 + SESSION_EXPIRED / UNAUTHORIZED 时触发） */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
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

  /** 会话不可用（需要重新登录），与「这个请求本身不合法」区分开 */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  /** token 寿命到顶，必须重新用 key 登录（而非重试） */
  get isSessionExpired(): boolean {
    return this.code === ErrorCode.SESSION_EXPIRED;
  }
}

/**
 * 从响应里吸收服务端滚动续期下发的 token。
 *
 * 两条来源：
 *   1. 响应体里的 `token`（登录 / refresh / 改资料）
 *   2. `X-Refreshed-Token` 响应头（任意鉴权请求都可能顺带续期）
 */
function absorbToken(res: Response, body: unknown): void {
  const header = res.headers.get('X-Refreshed-Token');
  const fromBody =
    body && typeof body === 'object' && 'data' in body
      ? ((body as { data?: { token?: unknown; expiresAt?: unknown; sessionExpiresAt?: unknown } })
          .data ?? null)
      : null;

  const bodyToken = typeof fromBody?.token === 'string' ? fromBody.token : null;
  const expiresAt = typeof fromBody?.expiresAt === 'number' ? fromBody.expiresAt : undefined;
  const hardExpiresAt =
    typeof fromBody?.sessionExpiresAt === 'number' ? fromBody.sessionExpiresAt : undefined;

  if (bodyToken && expiresAt !== undefined) {
    saveSession(bodyToken, expiresAt, hardExpiresAt);
    return;
  }

  if (header) {
    // 只有响应头：到期时间按滚动窗口粗估，避免把本地记录写小导致反复续期
    const fallbackExpiry = Math.floor(Date.now() / 1000) + 12 * 3600;
    saveSession(header, fallbackExpiry, hardExpiresAt);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'include', // 同时带上 HttpOnly Cookie（同源场景）
    headers,
  });

  let body: ApiResult<T> | null = null;
  try {
    body = (await res.json()) as ApiResult<T>;
  } catch {
    /* 非 JSON 响应 */
  }

  absorbToken(res, body);

  if (!res.ok || !body || body.ok !== true) {
    const failure = body && body.ok === false ? body : null;
    const code = failure?.code;
    const message =
      failure?.error ??
      (res.status === 0 ? '无法连接服务器' : `请求失败（${res.status}）`);

    // 会话不可用：清掉本地凭据并通知外壳跳登录页。
    // 注意只有 401 才算 —— 403（权限不足）不该把人踢下线。
    if (res.status === 401) {
      clearSession();
      onSessionExpired?.();
    }

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

export type { ClientConfig } from '@shared/types';

export const authApi = {
  config: () => api.get<ClientConfig>('/api/auth/config'),
  login: (body: {
    key: string;
    nickname: string;
    avatarId?: string | null;
    turnstileToken?: string | null;
  }) => api.post<SessionResult>('/api/auth/login', body),
  /** 显式续期（长连接客户端建议定时调用） */
  refresh: () => api.post<SessionResult>('/api/auth/refresh', {}),
  me: () =>
    api.get<{
      profile: SessionResult['profile'];
      authMethod: 'cookie' | 'bearer';
      expiresAt: number | null;
      sessionExpiresAt: number;
    }>('/api/auth/me'),
  updateMe: (body: {
    nickname?: string;
    avatarId?: string | null;
    avatarDataUrl?: string | null;
  }) => api.patch<{ profile: SessionResult['profile']; expiresAt: number; token: string }>(
    '/api/auth/me',
    body,
  ),
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
  /**
   * 领 WebSocket 握手票据。
   *
   * WebSocket API 无法自定义请求头，所以不能直接带 Bearer；
   * 必须先用普通 HTTP 领一张一次性票据再连。
   */
  wsTicket: (id: string) => api.post<WsTicket>(`/api/rooms/${id}/ws-ticket`, {}),
};

export const presenceApi = {
  /**
   * 心跳：登记在线状态与当前房间。
   *
   * `banned: true` = 已被移出服务器（服务端用成功响应 + 标记，
   * 避免高频心跳里的 403 被当成网络问题忽略）。
   */
  heartbeat: (body: {
    roomId?: string | null;
    roomName?: string | null;
    status?: import('@shared/types').PresenceStatus;
    invitable?: boolean;
  }) => api.post<{ alive: boolean; banned?: boolean }>('/api/presence/heartbeat', body),
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
  /**
   * CSV 导出地址。
   *
   * 注意：这个 URL 只适合**浏览器直接下载**（靠 cookie 鉴权）。
   * 其他客户端请改用 `downloadAuditCsv()` 拿文本自己落盘 ——
   * token 不该出现在 URL 里（会进日志与历史记录）。
   */
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
