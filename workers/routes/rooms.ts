import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createRoomSchema, heartbeatSchema } from '@shared/schema';
import { requireAuth } from '../middleware/auth';
import { apiRateLimit } from '../middleware/ratelimit';
import { upsertRoomToD1, touchRoomPeak } from '../lib/db';
import type { AppEnv } from '../env';

const rooms = new Hono<AppEnv>();

rooms.use('*', requireAuth);

/** 房间列表 */
rooms.get('/', async (c) => {
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const list = await registry.listRooms();

  // 用 RoomDO 的真实成员数覆盖（目录里的可能滞后）
  const enriched = await Promise.all(
    list.map(async (room) => {
      const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(room.id));
      const snapshot = await stub.getSnapshot();
      return { ...room, memberCount: snapshot.members.length };
    }),
  );

  return c.json({ ok: true, data: { rooms: enriched } });
});

/** 创建房间 */
rooms.post('/', apiRateLimit, zValidator('json', createRoomSchema), async (c) => {
  const user = c.get('user');
  const { name, maxMembers } = c.req.valid('json');

  const id = crypto.randomUUID().slice(0, 8);
  const limit = maxMembers ?? Number(c.env.MAX_ROOM_MEMBERS);

  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  await stub.init({ id, name, ownerUid: user.uid, maxMembers: limit });

  const summary = await stub.getSummary();

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  await registry.upsertRoom(summary);
  await upsertRoomToD1(c.env, summary);

  return c.json({ ok: true, data: { room: summary } }, 201);
});

/** 默认房间（无需创建，直接用 home） */
rooms.get('/default', async (c) => {
  const id = 'home';
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  await stub.init({
    id,
    name: '默认房间',
    ownerUid: null,
    maxMembers: Number(c.env.MAX_ROOM_MEMBERS),
  });
  return c.json({ ok: true, data: { room: await stub.getSummary() } });
});

/** 房间快照 */
rooms.get('/:id/snapshot', async (c) => {
  const id = c.req.param('id') ?? '';
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  const snapshot = await stub.getSnapshot();

  if (!snapshot.room.id) {
    return c.json({ ok: false, error: '房间不存在', code: 'ROOM_NOT_FOUND' }, 404);
  }
  return c.json({ ok: true, data: snapshot });
});

/** 房间内可订阅的轨道列表（订阅方定位用） */
rooms.get('/:id/tracks', async (c) => {
  const id = c.req.param('id') ?? '';
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  const tracks = await stub.listTracks();
  return c.json({ ok: true, data: { tracks } });
});

/** 进入房间 */
rooms.post('/:id/join', apiRateLimit, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') ?? '';

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const profile = await registry.lookupByUid(user.uid);
  if (!profile) {
    return c.json({ ok: false, error: '用户不存在', code: 'UNAUTHORIZED' }, 401);
  }

  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  await stub.init({
    id,
    name: id === 'home' ? '默认房间' : `房间 ${id}`,
    ownerUid: null,
    maxMembers: Number(c.env.MAX_ROOM_MEMBERS),
  });

  const res = await stub.join({
    uid: profile.uid,
    nickname: profile.nickname,
    avatarId: profile.avatarId,
    avatarUrl: profile.avatarUrl,
    role: profile.role,
  });

  if (!res.ok) {
    return c.json({ ok: false, error: '房间已满', code: 'ROOM_FULL' }, 409);
  }

  const snapshot = await stub.getSnapshot();
  const summary = await stub.getSummary();

  await registry.upsertRoom(summary);
  await touchRoomPeak(c.env, id, snapshot.members.length);

  const adminStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  await adminStub.pushAudit({
    uid: profile.uid,
    nickname: profile.nickname,
    role: profile.role,
    roomId: id,
    event: 'join',
    ipHash: c.get('ipHash'),
    ipPrefix: c.get('ipPrefix'),
    userAgent: c.req.header('User-Agent') ?? null,
  });

  return c.json({
    ok: true,
    data: {
      snapshot,
      keyId: await stub.getKeyId(),
    },
  });
});

/** 离开房间 */
rooms.post('/:id/leave', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') ?? '';

  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  await stub.leave(user.uid);

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  await registry.upsertRoom(await stub.getSummary());

  const adminStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  await adminStub.pushAudit({
    uid: user.uid,
    nickname: user.nickname,
    role: user.role,
    roomId: id,
    event: 'leave',
    ipHash: c.get('ipHash'),
    ipPrefix: c.get('ipPrefix'),
    userAgent: c.req.header('User-Agent') ?? null,
  });

  return c.json({ ok: true, data: { left: true } });
});

/** 心跳 */
rooms.post('/:id/heartbeat', zValidator('json', heartbeatSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') ?? '';
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  const res = await stub.heartbeat(user.uid);
  return c.json({ ok: true, data: res });
});

/** 切换麦克风状态 */
rooms.post('/:id/mute', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as { muted?: boolean };
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  await stub.setMuted(user.uid, body.muted === true);
  return c.json({ ok: true, data: { muted: body.muted === true } });
});

/** WebSocket 升级（转发到 RoomDO） */
rooms.get('/:id/ws', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') ?? '';

  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(id));
  const url = new URL(c.req.url);
  url.pathname = `/room/${id}/ws`;
  url.searchParams.set('uid', user.uid);

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

export default rooms;
