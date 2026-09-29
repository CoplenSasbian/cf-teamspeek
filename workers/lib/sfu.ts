/**
 * Cloudflare Realtime SFU REST 封装。
 * Base: https://rtc.live.cloudflare.com/v1
 * 认证：Authorization: Bearer <App Secret>
 *
 * ⚠️ 同一 session 上的变更必须由调用方串行化（见客户端 sfu-session.ts 的 Promise 队列）。
 */

const SFU_BASE = 'https://rtc.live.cloudflare.com/v1';

export class SfuError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'SfuError';
  }
}

interface SfuContext {
  appId: string;
  bearerToken: string;
}

async function sfuFetch<T>(
  ctx: SfuContext,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${SFU_BASE}/apps/${ctx.appId}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${ctx.bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    throw new SfuError(`SFU ${init.method} ${path} failed`, res.status, parsed);
  }
  return parsed as T;
}

/** 创建新会话 */
export function createSession(ctx: SfuContext): Promise<{ sessionId: string }> {
  return sfuFetch<{ sessionId: string }>(ctx, '/sessions/new', { method: 'POST' });
}

export interface SfuTrack {
  location: 'local' | 'remote';
  mid?: string;
  trackName?: string;
  sessionId?: string;
  error?: { code: string; description: string };
}

export interface TracksNewResult {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: RTCSessionDescriptionInit;
  tracks?: SfuTrack[];
}

/** 新增 tracks（发布或订阅） */
export function addTracks(
  ctx: SfuContext,
  sessionId: string,
  body: {
    sessionDescription?: RTCSessionDescriptionInit;
    tracks: Array<{
      location: 'local' | 'remote';
      mid?: string;
      trackName: string;
      sessionId?: string;
      /** SFU 生成 offer（订阅）时建议带上，帮它确定 transceiver 类型 */
      kind?: 'audio' | 'video';
    }>;
  },
): Promise<TracksNewResult> {
  return sfuFetch<TracksNewResult>(ctx, `/sessions/${sessionId}/tracks/new`, {
    method: 'POST',
    body,
  });
}

/** 重协商（订阅方向必须做） */
export function renegotiateSession(
  ctx: SfuContext,
  sessionId: string,
  sessionDescription: RTCSessionDescriptionInit,
): Promise<{ sessionDescription?: RTCSessionDescriptionInit }> {
  return sfuFetch(ctx, `/sessions/${sessionId}/renegotiate`, {
    method: 'PUT',
    body: { sessionDescription },
  });
}

/**
 * 关闭 tracks。
 *
 * ⚠️ body 里必须给 **mid**（不是 trackName）—— OpenAPI 原文：
 * "Close media tracks identified by mids on the session in the URL."
 *
 * force=true 时无需 SDP 交换；force=false 需要提供 endpoint offer 并应用返回的 answer。
 * 清理场景（退房、成员离开）一律用 force=true。
 */
export function closeTracks(
  ctx: SfuContext,
  sessionId: string,
  mids: string[],
  force = true,
): Promise<{ tracks?: Array<{ mid?: string; error?: { code?: string; description?: string } }> }> {
  return sfuFetch(ctx, `/sessions/${sessionId}/tracks/close`, {
    method: 'PUT',
    body: { tracks: mids.map((mid) => ({ mid })), force },
  });
}

/** 查询会话信息 */
export function getSession(
  ctx: SfuContext,
  sessionId: string,
): Promise<{
  sessionDescription?: RTCSessionDescriptionInit;
  tracks?: SfuTrack[];
}> {
  return sfuFetch(ctx, `/sessions/${sessionId}`, { method: 'GET' });
}
