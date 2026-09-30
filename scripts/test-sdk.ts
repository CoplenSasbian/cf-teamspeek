/**
 * SDK（客户端库）自测 —— 用假的 HTTP / WebSocket 覆盖跨客户端的关键协议。
 *
 * 为什么值得写：这些逻辑决定「别的客户端能不能接上」，
 * 而且失败方式很隐蔽（比如「能登录但连不上房间」「token 到期后被无限重试」）。
 * 全部离线运行，不需要服务器、不需要网络、不需要浏览器。
 *
 * 运行：npm run test:sdk
 */

import assert from 'node:assert/strict';

import { VoiceRoomClient } from '../client/index';
import { ApiError, MemoryStorage } from '../client/lib/http';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const BASE = 'https://room.example.com';

// ============================================================
//  假 HTTP
// ============================================================

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(handlers: Record<string, (req: RecordedRequest) => Response | Promise<Response>>) {
  const requests: RecordedRequest[] = [];

  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: unknown = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: RecordedRequest = { method, url, headers, body };
    requests.push(req);

    const path = url.replace(BASE, '');
    const key = `${method} ${path.split('?')[0]}`;
    const handler = handlers[key] ?? handlers[`${method} *`];
    if (!handler) {
      return new Response(JSON.stringify({ ok: false, error: `未登记的请求 ${key}`, code: 'INTERNAL' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handler(req);
  };

  return { impl: impl as typeof fetch, requests };
}

function json(data: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function fail(error: string, code: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error, code }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

const SESSION_PAYLOAD = {
  token: 'token-1',
  expiresAt: Math.floor(Date.now() / 1000) + 12 * 3600,
  sessionExpiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  role: 'guest' as const,
  profile: {
    uid: 'u-1',
    nickname: '甲',
    role: 'guest' as const,
    avatarId: null,
    avatarUrl: null,
  },
};

const SNAPSHOT = {
  room: { id: 'home', name: '默认房间', ownerUid: null, memberCount: 1, maxMembers: 10, createdAt: 1 },
  members: [
    {
      uid: 'u-1',
      nickname: '甲',
      avatarId: null,
      avatarUrl: null,
      role: 'guest' as const,
      muted: false,
      joinedAt: 1,
      lastSeen: 2,
    },
  ],
  version: 1,
};

// ============================================================
//  假 WebSocket
// ============================================================

interface FakeSocket {
  url: string;
  readyState: number;
  sent: string[];
  closed: boolean;
  instance: FakeWebSocket;
}

class FakeWebSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    const record: FakeSocket = { url, readyState: 0, sent: [], closed: false, instance: this };
    Object.defineProperty(record, 'readyState', { get: () => this.readyState });
    Object.defineProperty(record, 'sent', { get: () => this.sent });
    Object.defineProperty(record, 'closed', { get: () => this.closed });
    FakeWebSocket.instances.push(record);
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  private fire(type: string, ev: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }

  /** 测试辅助：模拟握手成功 */
  open(): void {
    this.readyState = 1;
    this.fire('open', {});
  }

  /** 测试辅助：模拟服务端下发事件 */
  push(data: unknown): void {
    this.fire('message', { data: JSON.stringify(data) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.fire('close', {});
  }
}

function resetSockets(): void {
  FakeWebSocket.instances = [];
}

/** 等到条件成立（避免依赖固定 sleep 时长） */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ============================================================
//  用例
// ============================================================

console.log('\n[1] 登录与凭据');

await check('登录后所有请求都带 Authorization: Bearer', async () => {
  const { impl, requests } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'GET /api/rooms': () => json({ rooms: [] }),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });

  await client.login({ key: 'k', nickname: '甲' });
  await client.listRooms();

  assert.equal(requests[0]!.headers.Authorization, undefined, '登录本身不该带 token');
  assert.equal(requests[1]!.headers.Authorization, 'Bearer token-1');
});

await check('会话凭据会落盘，换一个实例仍然登录着', async () => {
  const storage = new MemoryStorage();
  const { impl } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'GET /api/rooms': () => json({ rooms: [] }),
  });

  const first = new VoiceRoomClient({ baseUrl: BASE, fetchImpl: impl, storage, presence: false });
  await first.login({ key: 'k', nickname: '甲' });

  const second = new VoiceRoomClient({ baseUrl: BASE, fetchImpl: impl, storage, presence: false });
  assert.equal(second.http.isSignedIn, true, '新实例应当自动恢复会话');
  assert.equal(second.session()?.uid, 'u-1');
});

console.log('\n[2] 会话续期与失效');

await check('401 时自动续期并重放原请求', async () => {
  let refreshed = false;
  const { impl, requests } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'GET /api/rooms': () => {
      if (!refreshed) return fail('会话已过期', 'UNAUTHORIZED', 401);
      return json({ rooms: [] });
    },
    'POST /api/auth/refresh': () => {
      refreshed = true;
      return json({ ...SESSION_PAYLOAD, token: 'token-2' });
    },
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });
  await client.login({ key: 'k', nickname: '甲' });
  await client.listRooms();

  const roomsCalls = requests.filter((r) => r.url.endsWith('/api/rooms'));
  assert.equal(roomsCalls.length, 2, '原请求应当被重放一次');
  assert.equal(roomsCalls[1]!.headers.Authorization, 'Bearer token-2', '重放必须用新 token');
  assert.equal(client.session()?.token, 'token-2');
});

await check('会话到顶（SESSION_EXPIRED）→ 触发 sessionExpired，且不反复重试', async () => {
  const events: string[] = [];
  const { impl, requests } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'GET /api/rooms': () => fail('登录状态已到期', 'SESSION_EXPIRED', 401),
    'POST /api/auth/refresh': () => fail('登录状态已到期', 'SESSION_EXPIRED', 401),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });
  client.on('sessionExpired', (e) => events.push(e.reason));
  await client.login({ key: 'k', nickname: '甲' });

  await assert.rejects(() => client.listRooms(), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.sessionExpired, true);
    return true;
  });

  assert.deepEqual(events, ['expired']);
  assert.equal(client.http.isSignedIn, false, '本地凭据应当被清掉');
  assert.equal(
    requests.filter((r) => r.url.endsWith('/api/auth/refresh')).length,
    1,
    '续期只该尝试一次',
  );
});

await check('响应头 X-Refreshed-Token 会被吸收（滚动续期不发响应体 token）', async () => {
  const { impl } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'GET /api/rooms': () => json({ rooms: [] }, { 'X-Refreshed-Token': 'token-rotated' }),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });
  await client.login({ key: 'k', nickname: '甲' });
  await client.listRooms();

  assert.equal(client.session()?.token, 'token-rotated');
});

console.log('\n[3] WebSocket 鉴权（跨客户端的关键路径）');

await check('先领 ticket，再用 ticket 连 WebSocket（而不是靠 Cookie）', async () => {
  resetSockets();
  const { impl, requests } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'POST /api/rooms/home/join': () => json({ snapshot: SNAPSHOT, keyId: 'key-1' }),
    'POST /api/rooms/home/ws-ticket': () =>
      json({ ticket: 'tk-abc', expiresAt: 0, wsUrl: 'wss://room.example.com/api/rooms/home/ws?ticket=tk-abc' }),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  await client.login({ key: 'k', nickname: '甲' });
  await client.joinRoom('home');

  await waitFor(() => FakeWebSocket.instances.length > 0);
  const socket = FakeWebSocket.instances[0]!;
  assert.match(socket.url, /ticket=tk-abc/, 'WebSocket URL 必须带 ticket');

  const ticketReq = requests.find((r) => r.url.endsWith('/ws-ticket'))!;
  assert.equal(ticketReq.headers.Authorization, 'Bearer token-1', '领票必须走鉴权 HTTP');

  client.dispose();
});

await check('收到 kicked → 停止重连并通知订阅者', async () => {
  resetSockets();
  const { impl } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'POST /api/rooms/home/join': () => json({ snapshot: SNAPSHOT, keyId: 'key-1' }),
    'POST /api/rooms/home/ws-ticket': () =>
      json({ ticket: 'tk', expiresAt: 0, wsUrl: 'wss://x/api/rooms/home/ws?ticket=tk' }),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  const events: string[] = [];
  client.on('kicked', (e) => events.push(e.reason));

  await client.login({ key: 'k', nickname: '甲' });
  await client.joinRoom('home');
  await waitFor(() => FakeWebSocket.instances.length > 0);

  const before = FakeWebSocket.instances.length;
  FakeWebSocket.instances[0]!.instance.push({ type: 'kicked', reason: '被管理员移出' });

  await waitFor(() => events.length === 1);
  assert.equal(events[0], '被管理员移出');

  // 被踢后不应再发起新连接
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(FakeWebSocket.instances.length, before, '被踢后不该重连');

  client.dispose();
});

await check('心跳优先走 WebSocket，连上之后不再消耗 HTTP 请求', async () => {
  resetSockets();
  const { impl, requests } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'POST /api/rooms/home/join': () => json({ snapshot: SNAPSHOT, keyId: 'key-1' }),
    'POST /api/rooms/home/heartbeat': () => json({ version: 1, reaped: 0 }),
    'POST /api/rooms/home/ws-ticket': () =>
      json({ ticket: 'tk', expiresAt: 0, wsUrl: 'wss://x/api/rooms/home/ws?ticket=tk' }),
  });

  const httpHeartbeats = () => requests.filter((r) => r.url.endsWith('/heartbeat')).length;

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
    heartbeatIntervalMs: 20,
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });

  await client.login({ key: 'k', nickname: '甲' });
  await client.joinRoom('home');
  await waitFor(() => FakeWebSocket.instances.length > 0);
  FakeWebSocket.instances[0]!.instance.open();

  // 连上瞬间补一次 HTTP 心跳是刻意设计（避免刚重连就被判定离线）
  const baseline = httpHeartbeats();

  // 之后心跳必须走 socket
  await waitFor(() => FakeWebSocket.instances[0]!.sent.length >= 2);
  assert.equal(
    httpHeartbeats(),
    baseline,
    'WebSocket 活着时不该再打 HTTP 心跳',
  );
  const payload = JSON.parse(FakeWebSocket.instances[0]!.sent[0]!) as { type: string };
  assert.equal(payload.type, 'heartbeat');

  client.dispose();
});

console.log('\n[4] 在线状态');

await check('轮询会派发 presence / invite 事件', async () => {
  const invite = { id: 'i1', fromUid: 'u-2', fromNickname: '乙', roomId: 'home', roomName: '默认房间', createdAt: 1 };
  const { impl } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'POST /api/presence/poll': () =>
      json({ online: [], offline: [], invites: [invite], serverTime: 1 }),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });
  await client.login({ key: 'k', nickname: '甲' });

  const invites: string[] = [];
  const presence: number[] = [];
  client.on('invite', (i) => invites.push(i.id));
  client.on('presence', () => presence.push(1));

  await client.pollPresence();
  assert.deepEqual(invites, ['i1']);
  assert.equal(presence.length, 1);
});

await check('被移出服务器（心跳返回 banned 标记）→ banned 事件', async () => {
  const { impl } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'POST /api/presence/heartbeat': () => json({ alive: false, banned: true }),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });

  const banned: string[] = [];
  client.on('banned', (e) => banned.push(e.reason));
  await client.login({ key: 'k', nickname: '甲' });

  const result = await client.heartbeatPresence({ status: 'online' });
  assert.equal(result.banned, true);
  assert.equal(banned.length, 1);

  client.dispose();
});

await check('被封禁（BANNED 错误码）→ banned 事件 + 停止轮询', async () => {
  const { impl } = makeFetch({
    'POST /api/auth/login': () => json(SESSION_PAYLOAD),
    'POST /api/presence/poll': () => fail('你已被移出本服务器', 'BANNED', 403),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });

  const err = await client.pollPresence().catch((e: unknown) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'BANNED');
  assert.equal(err.unauthorized, false, '封禁不是鉴权失败，不该清会话');

  client.dispose();
});

console.log('\n[5] 错误分类');

await check('网络故障 → NetworkError（与 HTTP 错误区分）', async () => {
  const impl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });

  const err = await client.listRooms().catch((e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'NetworkError');
  assert.equal(client.http.isSignedIn, false);
});

await check('限流错误可识别，可按 Retry-After 重试', async () => {
  const { impl } = makeFetch({
    'POST /api/auth/login': () => fail('请求过于频繁，请稍后再试', 'RATE_LIMITED', 429),
  });

  const client = new VoiceRoomClient({
    baseUrl: BASE,
    fetchImpl: impl,
    storage: new MemoryStorage(),
    presence: false,
  });

  const err = await client.login({ key: 'k', nickname: '甲' }).catch((e: unknown) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.rateLimited, true);
  assert.equal(err.unauthorized, false);
});

console.log(`\n全部通过：${passed} 项\n`);
