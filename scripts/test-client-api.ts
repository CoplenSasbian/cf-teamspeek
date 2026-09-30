/**
 * 跨客户端接入的核心逻辑自测（无需服务器 / 无需 wrangler）。
 *
 * 覆盖两块「改错了不容易发现」的逻辑：
 *   1. 会话 token 的签发、校验、滚动续期与绝对寿命
 *   2. CORS 白名单的放行判定
 *
 * 运行：npm run test:client-api
 *
 * 为什么单独写这个脚本：信令与 DO 逻辑靠手动验证（见 DESIGN.md 19.5），
 * 但「鉴权边界」这种东西不能靠手感 —— 它出错的表现是「别人能用」。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  signSession,
  signRenewedSession,
  verifySession,
  decideSessionRefresh,
  signAdminSession,
  verifyAdminSession,
  decideAdminSessionRefresh,
} from '../workers/lib/jwt';
import { resolveCorsOrigin } from '../workers/middleware/cors';
import { SESSION_TTL_HOURS, SESSION_ABSOLUTE_TTL_HOURS } from '../shared/constants';
import { API_ENDPOINTS, CORE_ENDPOINTS, WS_DOWNLINK, WS_UPLINK } from '../shared/api-surface';

const SECRET = 'test-secret-not-a-real-one';
const now = Math.floor(Date.now() / 1000);

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      throw err;
    });
}

console.log('\n[1] 客户端会话 token');

await check('签发 → 校验，字段完整', async () => {
  const token = await signSession({ uid: 'u1', nickname: '甲', role: 'guest' }, SECRET);
  const session = await verifySession(token, SECRET);
  assert.ok(session, '应当校验通过');
  assert.equal(session.uid, 'u1');
  assert.equal(session.nickname, '甲');
  assert.equal(session.role, 'guest');
  assert.equal(session.issuedAt, session.iat);
  assert.ok(session.expiresAt > now);
});

await check('换一个 secret 就校验不过（不能跨部署伪造）', async () => {
  const token = await signSession({ uid: 'u1', nickname: '甲', role: 'guest' }, SECRET);
  assert.equal(await verifySession(token, 'another-secret'), null);
});

await check('乱码 token 不抛异常，返回 null', async () => {
  assert.equal(await verifySession('not.a.jwt', SECRET), null);
});

await check('已过期的 token 校验不过', async () => {
  // 签发时间在 13 小时前、12 小时有效期 → 已经过期
  const expired = await signSession(
    { uid: 'u1', nickname: '甲', role: 'guest' },
    SECRET,
    { issuedAt: now - 13 * 3600, ttlSeconds: SESSION_TTL_HOURS * 3600 },
  );
  assert.equal(await verifySession(expired, SECRET), null);
});

await check('续期保留原始 iat（绝对寿命锚点不能被刷新）', async () => {
  // 4 小时前签发、12 小时有效 → 还有 8 小时，属于「该续期但没到期」
  const original = await signSession(
    { uid: 'u1', nickname: '甲', role: 'guest' },
    SECRET,
    { issuedAt: now - 4 * 3600, ttlSeconds: SESSION_TTL_HOURS * 3600 },
  );
  const session = await verifySession(original, SECRET);
  assert.ok(session);
  assert.equal(session.issuedAt, now - 4 * 3600);

  const decision = decideSessionRefresh(session);
  assert.equal(decision.action, 'renew', '已用掉 1/3 寿命的 token 应当续期');

  const renewed = await signRenewedSession(
    { uid: 'u1', nickname: '甲', role: 'guest' },
    SECRET,
    session.issuedAt,
    decision.ttlSeconds,
  );
  const after = await verifySession(renewed, SECRET);
  assert.ok(after);
  assert.equal(after.issuedAt, now - 4 * 3600, '续期后 iat 必须保持不变');
  assert.ok(after.expiresAt > session.expiresAt, '到期时间应当往后推');
});

await check('新鲜 token 不触发重签（避免每个请求都签名）', async () => {
  const token = await signSession({ uid: 'u1', nickname: '甲', role: 'guest' }, SECRET);
  const session = await verifySession(token, SECRET);
  assert.ok(session);
  assert.equal(decideSessionRefresh(session).action, 'skip');
});

await check('超过绝对寿命 → expired（必须重新用 key 登录）', async () => {
  const tooOld = { issuedAt: now - SESSION_ABSOLUTE_TTL_HOURS * 3600 - 60 };
  assert.equal(decideSessionRefresh(tooOld).action, 'expired');
});

await check('续期后的 TTL 不会越过绝对上限', () => {
  // 距离绝对上限只剩 1 小时
  const almostDone = {
    issuedAt: now - (SESSION_ABSOLUTE_TTL_HOURS * 3600 - 3600),
  };
  const decision = decideSessionRefresh(almostDone);
  assert.equal(decision.action, 'renew');
  assert.ok(
    decision.ttlSeconds <= 3600 + 1,
    `续期 TTL 应当被压到剩余寿命内，实际 ${decision.ttlSeconds}`,
  );
});

await check('剩余寿命只剩几秒 → 直接判定到顶，不发「几乎立刻过期」的 token', () => {
  const nearlyDone = {
    issuedAt: now - (SESSION_ABSOLUTE_TTL_HOURS * 3600 - 30),
  };
  assert.equal(
    decideSessionRefresh(nearlyDone).action,
    'expired',
    '剩余不足 60 秒时应当要求重新登录',
  );
});

await check('续期后的 exp 必须落在未来（防止「原地踏步」的续期）', async () => {
  const original = await signRenewedSession(
    { uid: 'u1', nickname: '甲', role: 'guest' },
    SECRET,
    now - 4 * 3600,
    SESSION_TTL_HOURS * 3600,
  );
  const session = await verifySession(original, SECRET);
  assert.ok(session);
  const decision = decideSessionRefresh(session);
  assert.equal(decision.action, 'renew');

  const renewed = await signRenewedSession(
    { uid: 'u1', nickname: '甲', role: 'guest' },
    SECRET,
    session.issuedAt,
    decision.ttlSeconds,
  );
  const after = await verifySession(renewed, SECRET);
  assert.ok(after);
  assert.ok(
    after.expiresAt > now + 60,
    `续期后的到期时间必须在未来，实际 ${after.expiresAt - now}s`,
  );
});

console.log('\n[2] 管理后台会话 token（与客户端完全隔离）');

await check('后台 token 用后台 secret 校验，且客户端 token 进不来', async () => {
  const adminToken = await signAdminSession('admin', SECRET);
  const admin = await verifyAdminSession(adminToken, SECRET);
  assert.ok(admin);
  assert.equal(admin.nickname, 'admin');

  // 关键隔离点：客户端 token 即使同 secret、同为 admin 角色，也不能当后台 token 用
  const clientToken = await signSession({ uid: 'u1', nickname: '甲', role: 'admin' }, SECRET);
  assert.equal(await verifyAdminSession(clientToken, SECRET), null, 'audience 必须隔离');
});

await check('后台会话绝对寿命比客户端短', async () => {
  const fresh = { issuedAt: now - 8 * 24 * 3600 }; // 8 天前
  assert.equal(
    decideAdminSessionRefresh(fresh).action,
    'expired',
    '后台会话 7 天后必须重新登录',
  );
});

console.log('\n[3] CORS 白名单');

const URL_ = 'https://ts.futurvo.cc/api/auth/login';

await check('白名单为空 → 任何跨域都不放行', () => {
  assert.equal(resolveCorsOrigin('https://evil.com', URL_, []), null);
});

await check('同源请求不写 CORS 头（避免把自己当第三方）', () => {
  assert.equal(resolveCorsOrigin('https://ts.futurvo.cc', URL_, ['https://ts.futurvo.cc']), null);
});

await check('原生客户端（无 Origin）不写 CORS 头，但请求照常放行', () => {
  assert.equal(resolveCorsOrigin(undefined, URL_, ['https://a.com']), null);
});

await check('命中白名单 → 回显来源且允许凭据', () => {
  const r = resolveCorsOrigin('https://app.example.com', URL_, ['https://app.example.com']);
  assert.deepEqual(r, { origin: 'https://app.example.com', credentials: true });
});

await check('大小写与结尾斜杠不影响匹配', () => {
  const r = resolveCorsOrigin('HTTPS://App.Example.com', URL_, ['https://app.example.com']);
  assert.ok(r);
  assert.equal(r.origin, 'HTTPS://App.Example.com', '回显应当保留客户端原始写法');
});

await check('未命中白名单 → 不放行', () => {
  assert.equal(resolveCorsOrigin('https://evil.com', URL_, ['https://app.example.com']), null);
});

await check('通配 * → 放行但不允许凭据（只能用 Bearer）', () => {
  const r = resolveCorsOrigin('https://anything.example', URL_, ['*']);
  assert.ok(r);
  assert.equal(r.credentials, false, '通配时不能带 cookie，否则等于任意站点可冒充用户');
});

console.log('\n[4] API 文档与代码契约一致性');

const openapi = JSON.parse(
  readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };

/** OpenAPI 里的所有 `METHOD /path` */
const documented = new Set<string>();
for (const [path, operations] of Object.entries(openapi.paths)) {
  for (const method of Object.keys(operations)) documented.add(`${method.toUpperCase()} ${path}`);
}

/** API 清册里的所有 `METHOD /path` */
const declared = new Set(API_ENDPOINTS.map((e) => `${e.method} ${e.path}`));

await check('OpenAPI 里每个接口都在 shared/api-surface.ts 里登记过', () => {
  const missing = [...documented].filter((key) => !declared.has(key));
  assert.deepEqual(missing, [], `OpenAPI 里有未登记的接口：${missing.join(', ')}`);
});

await check('核心闭环的每个接口都写进了 OpenAPI', () => {
  const missing = CORE_ENDPOINTS.map((e) => `${e.method} ${e.path}`).filter(
    (key) => !documented.has(key),
  );
  assert.deepEqual(missing, [], `核心接口缺文档：${missing.join(', ')}`);
});

await check('清册没有重复条目', () => {
  assert.equal(declared.size, API_ENDPOINTS.length, '存在重复的 method+path');
});

await check('清册里所有鉴权等级都是合法值', () => {
  const allowed = new Set(['public', 'session', 'admin', 'adminRole']);
  for (const endpoint of API_ENDPOINTS) {
    assert.ok(allowed.has(endpoint.auth), `${endpoint.path} 的 auth 非法：${endpoint.auth}`);
  }
});

await check('清册与 workers/routes 里真实注册的路由完全一致', () => {
  // 直接读源码解析路由声明 —— 这样「加了路由忘了更新文档」会立刻失败，
  // 而不是等到某个客户端接不上才发现。
  const mounts: Record<string, string> = {
    'auth.ts': '/api/auth',
    'rooms.ts': '/api/rooms',
    'rtc.ts': '/api/rtc',
    'presence.ts': '/api/presence',
    'admin.ts': '/api/admin',
  };

  const actual = new Set<string>();
  const routerVar: Record<string, string> = {
    'auth.ts': 'auth',
    'rooms.ts': 'rooms',
    'rtc.ts': 'rtc',
    'presence.ts': 'presence',
    'admin.ts': 'admin',
  };

  for (const [file, mount] of Object.entries(mounts)) {
    const source = readFileSync(new URL(`../workers/routes/${file}`, import.meta.url), 'utf8');
    const router = routerVar[file]!;
    const re = new RegExp(`^${router}\\.(get|post|patch|delete)\\('([^']*)'`, 'gm');
    for (const match of source.matchAll(re)) {
      const method = match[1]!.toUpperCase();
      const sub = match[2]!;
      // 服务端用 :id，文档用 {id}；根路由的尾斜杠统一去掉（'/api/rooms/' → '/api/rooms'）
      const path = `${mount}${sub}`
        .replace(/:([A-Za-z_]+)/g, '{$1}')
        .replace(/\/+$/, '');
      actual.add(`${method} ${path}`);
    }
  }

  // 这两个不在 workers/routes/*.ts 里：
  //   /api/health  注册在 workers/app.ts
  //   /ws          WebSocket 握手端点（单独在 WS_ENDPOINTS 里登记）
  const expected = new Set(declared);
  expected.add('GET /api/rooms/{id}/ws');
  expected.add('GET /api/health');

  const undocumented = [...actual].filter((key) => !expected.has(key));
  const phantom = [...expected].filter((key) => !actual.has(key));

  assert.deepEqual(undocumented, [], `有路由没登记进 shared/api-surface.ts：${undocumented.join(', ')}`);
  // 反向检查：清册里写了但源码里没有的路由（可能是删了路由忘了删文档）。
  // app.ts 里的 /api/health 与 WebSocket 端点不在 routes/*.ts 里，排除掉。
  const notInSource = phantom.filter(
    (key) => key !== 'GET /api/rooms/{id}/ws' && key !== 'GET /api/health',
  );
  assert.deepEqual(notInSource, [], `清册里有不存在的路由：${notInSource.join(', ')}`);
});

await check('WebSocket 上行/下行消息类型覆盖服务端会发的全部事件', () => {
  // 与 workers/durable/RoomDO.ts 的 broadcast 调用保持一致
  const serverEvents = [
    'room-changed',
    'member-joined',
    'member-left',
    'key-rotated',
    'kicked',
    'room-closed',
  ];
  for (const type of serverEvents) {
    assert.ok(
      (WS_DOWNLINK as readonly string[]).includes(type),
      `api-surface 的 WS_DOWNLINK 缺少 ${type}`,
    );
  }
  assert.deepEqual([...WS_UPLINK], ['heartbeat', 'mute']);
});

await check('OpenAPI 顶层结构与关键 schema 齐备', () => {
  assert.equal((openapi as { openapi?: string }).openapi, '3.1.0');
  for (const name of ['Session', 'RoomSnapshot', 'WsTicket', 'ErrorCode', 'ClientConfig']) {
    assert.ok(openapi.components.schemas[name], `缺少 schema：${name}`);
  }
  assert.ok(Array.isArray((openapi as { servers?: unknown[] }).servers));
});

console.log(`\n全部通过：${passed} 项\n`);
