import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 管理后台 API 客户端 —— 与客户端 api.ts 完全独立。
 *
 * 隔离点：
 *   - 登录端点 /api/admin/auth/login，key 用 ADMIN_KEY，签发后台专用 JWT
 *   - 会话 cookie 是 ct_admin_session（后台专用），与客户端 ct_session 互不干扰
 *   - 后台 token 只发给 /api/admin/*；客户端 token 进不了后台 API
 *
 * token 存 sessionStorage：关闭标签页即失效，后台失守窗口更小。
 */

const TOKEN_KEY = 'cf-teamspeed.adminToken';

let baseUrl = '';

export function setAdminBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, '');
}

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function isAdminSignedIn(): boolean {
  return getToken() !== null;
}

export function signOutAdminLocally(): void {
  if (typeof window !== 'undefined') window.sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'include', // cookie（ct_admin_session）自动带上
    headers,
  });

  let body: { ok?: boolean; data?: T; error?: string; code?: string } | null = null;
  try {
    body = (await res.json()) as { ok?: boolean; data?: T; error?: string; code?: string } | null;
  } catch {
    /* 非 JSON 响应 */
  }

  if (!res.ok || !body || body.ok !== true) {
    const message =
      body && body.ok === false ? (body.error ?? `请求失败（${res.status}）`) : `请求失败（${res.status}）`;
    const code = body && body.ok === false ? body.code : undefined;
    throw new AdminApiError(message, code, res.status);
  }

  return body.data as T;
}

export const adminAuthApi = {
  login: (key: string) =>
    request<{ token: string; nickname: string }>('/api/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),
  me: () => request<{ nickname: string; role: string }>('/api/admin/auth/me'),
  logout: () => request<{ loggedOut: boolean }>('/api/admin/auth/logout', { method: 'POST' }),
};

export const adminApi = {
  overview: () =>
    request<{
      stats: { roomCount: number; totalMembers: number; registeredUsers: number };
      rooms: Array<{
        id: string;
        name: string;
        memberCount: number;
        maxMembers: number;
        members: Array<{
          uid: string;
          nickname: string;
          role: import('@shared/types').Role;
          muted: boolean;
          avatarId: string | null;
          avatarUrl: string | null;
          joinedAt: number;
          lastSeen: number;
        }>;
        trackCount: number;
        createdAt: number;
      }>;
      auditBacklog: number;
      usageNow: Record<string, number>;
      serverTime: number;
    }>('/api/admin/overview'),
  usage: (days = 7) =>
    request<{
      series: Record<string, Record<string, number>>;
      live: Record<string, number>;
      freeTier: Record<string, number>;
      days: number;
    }>(`/api/admin/usage?days=${days}`),
  audit: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    return request<{ rows: Record<string, unknown>[]; total: number; page: number; pageSize: number }>(
      `/api/admin/audit?${qs}`,
    );
  },
  auditExportUrl: () => `${baseUrl}/api/admin/audit/export`,
  kick: (body: { roomId: string; uid: string; reason?: string }) =>
    request<{ ok: boolean }>('/api/admin/kick', { method: 'POST', body: JSON.stringify(body) }),
  closeRoom: (id: string) =>
    request<{ closed: boolean }>(`/api/admin/rooms/${id}/close`, { method: 'POST' }),
  deleteRoom: (id: string) =>
    request<{ deleted: boolean; id: string }>(`/api/admin/rooms/${id}`, { method: 'DELETE' }),
  rotateKey: (id: string) =>
    request<{ keyId: string }>(`/api/admin/rooms/${id}/rotate-key`, { method: 'POST' }),
  setLimit: (id: string, maxMembers: number) =>
    request<unknown>(`/api/admin/rooms/${id}/limit`, {
      method: 'PATCH',
      body: JSON.stringify({ maxMembers }),
    }),
  renameRoom: (id: string, name: string) =>
    request<unknown>(`/api/admin/rooms/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  bans: () =>
    request<{
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
    request<{ id: string }>('/api/admin/bans', { method: 'POST', body: JSON.stringify(body) }),
  removeBan: (id: string) => request<{ removed: boolean }>(`/api/admin/bans/${id}`, { method: 'DELETE' }),
  users: () =>
    request<{ users: Array<{ uid: string; nickname: string; role: string; avatarId: string | null; avatarUrl: string | null }> }>(
      '/api/admin/users',
    ),
  releaseNickname: (nickname: string) =>
    request<{ released: boolean }>(`/api/admin/users/${encodeURIComponent(nickname)}`, { method: 'DELETE' }),
  flush: () =>
    request<{ audit: number; usage: Record<string, number>; pruned: number }>('/api/admin/flush', {
      method: 'POST',
    }),
};

/** 401 时清 token 并回登录态的小钩子（各 tab 调用后自行处理 UI） */
export function useAdminAuthGuard(onUnauthorized: () => void) {
  const handler = useRef(onUnauthorized);
  handler.current = onUnauthorized;

  const wrap = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof AdminApiError && err.status === 401) {
          signOutAdminLocally();
          handler.current();
          return null;
        }
        throw err;
      }
    },
    [],
  );

  return wrap;
}
