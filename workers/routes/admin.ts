import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { kickSchema, banSchema, auditQuerySchema } from '@shared/schema';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { flushAuditToD1, flushUsageToD1, readUsageDaily, queryAudit, pruneAudit } from '../lib/db';
import type { AppEnv } from '../env';

const admin = new Hono<AppEnv>();

admin.use('*', requireAuth);
admin.use('*', requireAdmin);

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
  await stub.init({
    id,
    name: (await stub.getSummary()).name,
    ownerUid: null,
    maxMembers: body.maxMembers,
  });
  return c.json({ ok: true, data: await stub.getSummary() });
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
