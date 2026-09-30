import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { deleteCookie, getCookie } from 'hono/cookie';
import { z } from 'zod';
import { kickSchema, banSchema, auditQuerySchema } from '@shared/schema';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_HOURS,
  ADMIN_SESSION_ABSOLUTE_TTL_HOURS,
} from '@shared/constants';
import { ErrorCode } from '@shared/types';
import { requireAdminSession, writeSessionCookie } from '../middleware/auth';
import { signAdminSession, signRenewedAdminSession, verifyAdminSession } from '../lib/jwt';
import { timingSafeEqual, sha256Hex } from '../lib/crypto';
import { flushAuditToD1, flushUsageToD1, readUsageDaily, queryAudit, pruneAudit, deleteRoomFromD1 } from '../lib/db';
import type { AppEnv } from '../env';

const admin = new Hono<AppEnv>();

/** 后台登录用的 IP 哈希（与客户端登录同一套派生方式，但混入的是 admin secret） */
async function adminIpHash(c: { env: AppEnv['Bindings']; req: { header: (n: string) => string | undefined } }) {
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  return sha256Hex(`${ip}:${c.env.ADMIN_SESSION_SECRET}`);
}

// ------------------------------------------------------------
//  后台登录 / 登出 —— 独立于客户端会话（不同 secret + 不同 cookie）
// ------------------------------------------------------------
const adminLoginSchema = z.object({ key: z.string().min(1, 'key 不能为空') });

admin.post('/auth/login', zValidator('json', adminLoginSchema), async (c) => {
  const { key } = c.req.valid('json');

  // 登录失败限流沿用 AdminDO 的计数器（按 IP 哈希，独立 scope 不影响客户端登录计数）
  const adminStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  const ipHash = await adminIpHash(c);
  const scope = `admin-login:${ipHash}`;

  // 先查锁：被锁的 key 即使正确也拒绝
  const lock = await adminStub.checkLock(scope);
  if (lock.locked) {
    return c.json(
      { ok: false, error: `尝试过于频繁，请 ${Math.ceil(lock.retryAfterMs / 60000)} 分钟后再试`, code: 'RATE_LIMITED' },
      429,
    );
  }

  if (!timingSafeEqual(key, c.env.ADMIN_KEY)) {
    await adminStub.recordFailure(scope);
    await adminStub.pushAudit({
      event: 'admin_login_fail',
      role: 'admin',
      ipHash,
    });
    return c.json({ ok: false, error: 'key 无效', code: 'INVALID_KEY' }, 401);
  }

  await adminStub.recordSuccess(scope);
  await adminStub.pushAudit({
    event: 'admin_login_ok',
    role: 'admin',
    ipHash,
  });

  const token = await signAdminSession('admin', c.env.ADMIN_SESSION_SECRET);
  // 浏览器用这个 Cookie；脚本 / 原生 App 用响应体里的 token 走 Bearer。
  // 两条路都通 —— 这正是后台 API 能脱离网页客户端的前提。
  writeSessionCookie(c, ADMIN_SESSION_COOKIE, token, ADMIN_SESSION_TTL_HOURS * 3600);

  return c.json({
    ok: true,
    data: {
      token,
      nickname: 'admin',
      role: 'admin' as const,
      expiresAt: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_HOURS * 3600,
      sessionExpiresAt:
        Math.floor(Date.now() / 1000) + ADMIN_SESSION_ABSOLUTE_TTL_HOURS * 3600,
    },
  });
});

/**
 * 后台会话续期（跨客户端必需）。
 *
 * 客户端可以定时调用它保持后台登录态；超过绝对寿命返回 401 SESSION_EXPIRED。
 */
admin.post('/auth/refresh', async (c) => {
  const header = c.req.header('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const token = bearer || getCookie(c, ADMIN_SESSION_COOKIE);

  if (!token) {
    return c.json({ ok: false, error: '未登录', code: ErrorCode.UNAUTHORIZED }, 401);
  }

  const session = await verifyAdminSession(token, c.env.ADMIN_SESSION_SECRET);
  if (!session) {
    return c.json(
      { ok: false, error: '后台会话已过期，请重新登录', code: ErrorCode.UNAUTHORIZED },
      401,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const absoluteLeft = session.issuedAt + ADMIN_SESSION_ABSOLUTE_TTL_HOURS * 3600 - now;
  if (absoluteLeft <= 60) {
    return c.json(
      { ok: false, error: '后台登录状态已到期，请重新登录', code: ErrorCode.SESSION_EXPIRED },
      401,
    );
  }

  const ttl = Math.min(ADMIN_SESSION_TTL_HOURS * 3600, absoluteLeft);
  const fresh = await signRenewedAdminSession(
    session.nickname,
    c.env.ADMIN_SESSION_SECRET,
    session.issuedAt,
    ttl,
  );
  writeSessionCookie(c, ADMIN_SESSION_COOKIE, fresh, ttl);

  return c.json({
    ok: true,
    data: { token: fresh, nickname: session.nickname, expiresAt: now + ttl },
  });
});

admin.post('/auth/logout', (c) => {
  deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true, data: { loggedOut: true } });
});

admin.get('/auth/me', requireAdminSession, (c) => {
  const user = c.get('user');
  return c.json({ ok: true, data: { nickname: user.nickname, role: user.role } });
});

// 以下全部走后台专用会话
admin.use('*', requireAdminSession);

/** 实时概览 */
admin.get('/overview', async (c) => {
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const stats = await registry.getStats();
  const rooms = await registry.listRooms();

  const detailed = await Promise.all(
    rooms.map(async (room) => {
      const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(room.id));
      const snap = await stub.getSnapshot();
      const tracks = await stub.listTracks();
      return {
        id: room.id,
        name: room.name,
        memberCount: snap.members.length,
        maxMembers: room.maxMembers,
        members: snap.members,
        trackCount: tracks.length,
        createdAt: room.createdAt,
      };
    }),
  );

  const adminStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  const auditBacklog = await adminStub.getAuditBacklog();

  // 实时用量快照（内存 + 缓冲）
  const usageNow = await registry.getUsageSnapshot();

  return c.json({
    ok: true,
    data: {
      stats,
      rooms: detailed,
      auditBacklog,
      usageNow,
      serverTime: Date.now(),
    },
  });
});

/** 用量看板 */
admin.get('/usage', async (c) => {
  const days = Number(c.req.query('days') ?? '7');

  // 先把缓冲落库，保证数据新鲜
  await flushUsageToD1(c.env);
  await flushAuditToD1(c.env, 500);

  const daily = await readUsageDaily(c.env, days);

  // 转成 { day: { metric: value } } 便于前端画图
  const series: Record<string, Record<string, number>> = {};
  for (const row of daily) {
    series[row.day] ??= {};
    series[row.day]![row.metric] = row.value;
  }

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const live = await registry.getUsageSnapshot();

  // 免费额度基线（用于进度条）
  const freeTier = {
    sfu_egress_bytes_month: 1000 * 1024 ** 3, // 1000 GB/月
    worker_requests_day: 100_000,
    do_requests_day: 100_000,
    d1_reads_day: 5_000_000,
    d1_writes_day: 100_000,
  };

  return c.json({ ok: true, data: { series, live, freeTier, days } });
});

/** 会话审计（分页 + 筛选） */
admin.get('/audit', zValidator('query', auditQuerySchema), async (c) => {
  // 查询前先落库，保证看到最新记录
  await flushAuditToD1(c.env, 1000);

  const q = c.req.valid('query');
  const { rows, total } = await queryAudit(c.env, q);

  return c.json({
    ok: true,
    data: { rows, total, page: q.page, pageSize: q.pageSize },
  });
});

/** 导出 CSV */
admin.get('/audit/export', async (c) => {
  await flushAuditToD1(c.env, 5000);

  const { rows } = await queryAudit(c.env, { page: 1, pageSize: 5000 });
  const header =
    'time,uid,nickname,role,room,event,ip_prefix,country,city,user_agent\n';
  const body = rows
    .map((r) => {
      const row = r as Record<string, unknown>;
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return [
        new Date(Number(row.created_at ?? 0)).toISOString(),
        row.uid,
        row.nickname,
        row.role,
        row.room_id,
        row.event,
        row.ip_prefix,
        row.country,
        row.city,
        row.user_agent,
      ]
        .map(esc)
        .join(',');
    })
    .join('\n');

  return new Response('\uFEFF' + header + body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${Date.now()}.csv"`,
    },
  });
});

/** 踢人 */
admin.post('/kick', zValidator('json', kickSchema), async (c) => {
  const { roomId, uid, reason } = c.req.valid('json');
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));
  const res = await stub.kick(uid, reason ?? '被管理员移出');

  const adminStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  await adminStub.pushAudit({
    uid,
    roomId,
    event: 'kick',
    role: 'admin',
    nickname: c.get('user').nickname,
    ipHash: c.get('ipHash'),
    ipPrefix: c.get('ipPrefix'),
  });

  return c.json({ ok: res.ok, data: res });
});

/** 关闭房间 */
admin.post('/rooms/:id/close', async (c) => {
  const id = c.req.param('id') ?? '';
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  await stub.close('管理员关闭了房间');

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  await registry.removeRoom(id);

  return c.json({ ok: true, data: { closed: true } });
});

/** 彻底删除房间（管理员可删任意房间，含默认房间） */
admin.delete('/rooms/:id', async (c) => {
  const id = c.req.param('id') ?? '';

  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  if (!(await stub.getSummary()).id) {
    return c.json({ ok: false, error: '房间不存在', code: 'ROOM_NOT_FOUND' }, 404);
  }

  await stub.destroy('房间已被管理员删除');

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  await registry.removeRoom(id);
  await deleteRoomFromD1(c.env, id);

  return c.json({ ok: true, data: { deleted: true, id } });
});

/** 轮换房间密钥 */
admin.post('/rooms/:id/rotate-key', async (c) => {
  const id = c.req.param('id') ?? '';
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  const res = await stub.rotateKey();
  return c.json({ ok: true, data: res });
});

/** 调整房间人数上限 */
admin.patch('/rooms/:id/limit', async (c) => {
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as { maxMembers?: number };
  if (typeof body.maxMembers !== 'number') {
    return c.json({ ok: false, error: '缺少 maxMembers', code: 'INVALID_BODY' }, 400);
  }
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  const res = await stub.update({ maxMembers: body.maxMembers });
  if (!res.ok) {
    return c.json({ ok: false, error: '房间不存在', code: 'ROOM_NOT_FOUND' }, 404);
  }
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  await registry.upsertRoom(res.summary);
  return c.json({ ok: true, data: res.summary });
});

/** 管理员：给任意房间改名（含默认房间，不受房主限制） */
admin.patch('/rooms/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ ok: false, error: '缺少 name', code: 'INVALID_BODY' }, 400);
  }
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  const res = await stub.update({ name: body.name.trim() });
  if (!res.ok) {
    return c.json({ ok: false, error: '房间不存在', code: 'ROOM_NOT_FOUND' }, 404);
  }
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  await registry.upsertRoom(res.summary);
  return c.json({ ok: true, data: res.summary });
});

/** 封禁列表 */
admin.get('/bans', async (c) => {
  const stub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  await stub.pruneExpired();
  const bans = await stub.listBans();
  return c.json({ ok: true, data: { bans } });
});

/** 新增封禁 */
admin.post('/bans', zValidator('json', banSchema), async (c) => {
  const body = c.req.valid('json');
  const stub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  const res = await stub.addBan(body);

  await stub.pushAudit({
    event: 'ban',
    nickname: c.get('user').nickname,
    role: 'admin',
    ipHash: c.get('ipHash'),
    ipPrefix: c.get('ipPrefix'),
  });

  return c.json({ ok: true, data: res }, 201);
});

/** 解除封禁 */
admin.delete('/bans/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  const stub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  const ok = await stub.removeBan(id);
  return c.json({ ok, data: { removed: ok } });
});

/** 已注册用户列表 */
admin.get('/users', async (c) => {
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const users = await registry.listUsers(500);
  return c.json({ ok: true, data: { users } });
});

/** 释放昵称 */
admin.delete('/users/:nickname', async (c) => {
  const nickname = decodeURIComponent(c.req.param('nickname') ?? '');
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const ok = await registry.releaseNickname(nickname);
  return c.json({ ok, data: { released: ok } });
});

/** 手动落库（把缓冲写进 D1，并清理过期审计） */
admin.post('/flush', async (c) => {
  const audit = await flushAuditToD1(c.env, 5000);
  const usage = await flushUsageToD1(c.env);
  const pruned = await pruneAudit(c.env, Number(c.env.AUDIT_RETENTION_DAYS));
  return c.json({ ok: true, data: { audit, usage, pruned } });
});

export default admin;
