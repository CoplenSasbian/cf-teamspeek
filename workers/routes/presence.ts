import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { inviteSchema, presenceHeartbeatSchema, serverKickSchema } from '@shared/schema';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { apiRateLimit } from '../middleware/ratelimit';
import type { AppEnv } from '../env';

/**
 * 服务器在线状态 / 邀请 / 踢出
 *
 * 「服务器」= 当前这个部署。所有接口都要求登录。
 * 客户端在应用外壳里以固定间隔心跳（在线判定）并轮询（拉成员 + 收邀请）。
 */
const presence = new Hono<AppEnv>();

presence.use('*', requireAuth);

/** 心跳：登记在线状态与当前房间（周期性请求，不额外限流，仅需登录） */
presence.post('/heartbeat', zValidator('json', presenceHeartbeatSchema), async (c) => {
  const user = c.get('user');
  const { roomId, roomName, status, invitable } = c.req.valid('json');

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const profile = await registry.lookupByUid(user.uid);
  if (!profile) {
    return c.json({ ok: false, error: '用户不存在', code: 'UNAUTHORIZED' }, 401);
  }

  // 被踢出服务器的用户不再登记在线。客户端据此清理本地会话并登出。
  //
  // 这里返回**成功响应 + banned 标记**，而不是只抛 403：
  // 心跳是高频请求，若统一抛错，客户端很容易把它当成「网络抖动」忽略掉，
  // 于是被踢的人会一直卡在界面里。显式标记让任何客户端都能可靠处理。
  const adminStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  if (await adminStub.isBanned({ nickname: profile.nickname, ipHash: c.get('ipHash') })) {
    return c.json({ ok: true, data: { alive: false, banned: true } });
  }

  const stub = c.env.PRESENCE_DO.get(c.env.PRESENCE_DO.idFromName('global'));
  await stub.heartbeat({
    uid: profile.uid,
    nickname: profile.nickname,
    role: profile.role,
    avatarId: profile.avatarId,
    avatarUrl: profile.avatarUrl,
    roomId: roomId ?? null,
    roomName: roomName ?? null,
    status,
    invitable,
  });

  return c.json({ ok: true, data: { alive: true, banned: false } });
});

/** 轮询：服务器成员快照 + 取走新邀请 */
presence.post('/poll', async (c) => {
  const user = c.get('user');
  const stub = c.env.PRESENCE_DO.get(c.env.PRESENCE_DO.idFromName('global'));
  const snapshot = await stub.getSnapshot({
    uid: user.uid,
    isAdmin: user.role === 'admin',
  });
  return c.json({ ok: true, data: snapshot });
});

/** 主动下线（登出时调用，让在线名册立刻更新） */
presence.post('/leave', async (c) => {
  const stub = c.env.PRESENCE_DO.get(c.env.PRESENCE_DO.idFromName('global'));
  await stub.drop(c.get('user').uid);
  return c.json({ ok: true, data: { dropped: true } });
});

/** 邀请某人加入某个房间 */
presence.post('/invite', apiRateLimit, zValidator('json', inviteSchema), async (c) => {
  const user = c.get('user');
  const { toUid, roomId } = c.req.valid('json');

  if (toUid === user.uid) {
    return c.json({ ok: false, error: '不能邀请自己', code: 'INVALID_BODY' }, 400);
  }

  const roomStub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));
  const snapshot = await roomStub.getSnapshot();
  if (!snapshot.room.id) {
    return c.json({ ok: false, error: '房间不存在', code: 'ROOM_NOT_FOUND' }, 404);
  }
  // 只有房间内的人才能发邀请，避免任意拉人
  if (!snapshot.members.some((m) => m.uid === user.uid)) {
    return c.json({ ok: false, error: '你不在这个房间里', code: 'FORBIDDEN' }, 403);
  }
  if (snapshot.members.some((m) => m.uid === toUid)) {
    return c.json({ ok: true, data: { sent: false, reason: '对方已在房间内' } });
  }

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const target = await registry.lookupByUid(toUid);
  if (!target) {
    return c.json({ ok: false, error: '对方不存在', code: 'INVALID_BODY' }, 404);
  }

  // 对方的状态与可邀请性（服务端把关，前端提示只是 UX）
  const presenceStub = c.env.PRESENCE_DO.get(c.env.PRESENCE_DO.idFromName('global'));
  const targetPresence = (await presenceStub.listOnline()).find((u) => u.uid === toUid);
  if (targetPresence && !targetPresence.invitable) {
    return c.json({ ok: true, data: { sent: false, reason: '对方当前不接受邀请' } });
  }
  if (targetPresence && targetPresence.status === 'busy') {
    return c.json({ ok: true, data: { sent: false, reason: '对方正在忙碌' } });
  }

  await presenceStub.sendInvite({
    toUid,
    fromUid: user.uid,
    fromNickname: user.nickname,
    roomId,
    roomName: snapshot.room.name,
  });

  return c.json({ ok: true, data: { sent: true } });
});

/** 管理员：踢出服务器（断开在线状态 + 封禁昵称 + 移出所在房间） */
presence.post('/kick', requireAdmin, zValidator('json', serverKickSchema), async (c) => {
  const admin = c.get('user');
  const { uid, reason, durationMinutes } = c.req.valid('json');

  if (uid === admin.uid) {
    return c.json({ ok: false, error: '不能踢出自己', code: 'INVALID_BODY' }, 400);
  }

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const target = await registry.lookupByUid(uid);
  if (!target) {
    return c.json({ ok: false, error: '用户不存在', code: 'INVALID_BODY' }, 404);
  }

  const presenceStub = c.env.PRESENCE_DO.get(c.env.PRESENCE_DO.idFromName('global'));
  const roomId = await presenceStub.getRoomOf(uid);
  if (roomId) {
    const roomStub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));
    await roomStub.kick(uid, reason ?? '被管理员踢出服务器');
  }
  await presenceStub.drop(uid);

  const adminStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  await adminStub.addBan({
    kind: 'nickname',
    value: target.nickname,
    reason: reason ?? '被踢出服务器',
    durationMinutes,
  });
  await adminStub.pushAudit({
    uid,
    nickname: target.nickname,
    role: admin.role,
    roomId,
    event: 'server-kick',
    ipHash: c.get('ipHash'),
    ipPrefix: c.get('ipPrefix'),
    userAgent: c.req.header('User-Agent') ?? null,
  });

  return c.json({ ok: true, data: { kicked: true, banned: true, roomId } });
});

export default presence;
