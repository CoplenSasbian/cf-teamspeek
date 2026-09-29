import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  publishSchema,
  subscribeSchema,
  subscribeBatchSchema,
  renegotiateSchema,
  closeTracksSchema,
} from '@shared/schema';
import { requireAuth } from '../middleware/auth';
import {
  createSession,
  addTracks,
  renegotiateSession,
  closeTracks,
  SfuError,
} from '../lib/sfu';
import type { AppEnv } from '../env';

const rtc = new Hono<AppEnv>();

rtc.use('*', requireAuth);

/** SFU 上下文（App ID + Secret） */
function sfuCtx(env: AppEnv['Bindings']) {
  return { appId: env.REALTIME_SFU_APP_ID, bearerToken: env.REALTIME_SFU_BEARER_TOKEN };
}

/** 统计 SFU 出站流量估算（用位率 × 时长，在客户端上报，这里只累加） */
async function addSfuUsage(env: AppEnv['Bindings'], bytes: number) {
  const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName('global'));
  await registry.addUsage('sfu_egress_bytes', bytes);
}

/** 统一的 SFU 错误响应 */
function sfuErrorResponse(
  c: { json: (body: unknown, status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502) => Response },
  err: unknown,
): Response {
  if (err instanceof SfuError) {
    return c.json(
      { ok: false, error: `SFU 调用失败：${err.message}`, code: 'INTERNAL', detail: err.detail },
      502,
    );
  }
  return c.json(
    { ok: false, error: err instanceof Error ? err.message : '未知错误', code: 'INTERNAL' },
    500,
  );
}

/**
 * 发布音频。
 * 客户端已经 setLocalDescription(offer)，这里把 offer 交给 SFU，拿回 answer。
 */
rtc.post('/publish', zValidator('json', publishSchema), async (c) => {
  const user = c.get('user');
  const { sdp, trackName, mid, roomId } = c.req.valid('json');

  try {
    const session = await createSession(sfuCtx(c.env));

    const result = await addTracks(sfuCtx(c.env), session.sessionId, {
      sessionDescription: { type: 'offer', sdp },
      tracks: [{ location: 'local', mid: mid ?? '0', trackName }],
    });

    // 记录 track 归属，供订阅方查询 + 越权校验
    const roomStub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));
    await roomStub.registerTrack({
      trackName,
      uid: user.uid,
      sessionId: session.sessionId,
      mid: result.tracks?.[0]?.mid ?? '0',
    });

    const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
    await registry.addUsage('publish_count', 1);

    return c.json({
      ok: true,
      data: {
        sessionId: session.sessionId,
        sessionDescription: result.sessionDescription,
        tracks: result.tracks,
      },
    });
  } catch (err) {
    return sfuErrorResponse(c, err);
  }
});

/**
 * 订阅他人音频。
 * 这一步 SFU 会返回 offer，客户端需要 answer 后再调 /renegotiate。
 */
rtc.post('/subscribe', zValidator('json', subscribeSchema), async (c) => {
  const { roomId, publisherSessionId, trackName } = c.req.valid('json');

  try {
    // 校验该 track 确实存在（防乱猜）
    const roomStub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));
    const tracks = await roomStub.listTracks();
    const target = tracks.find((t) => t.trackName === trackName);
    if (!target) {
      return c.json({ ok: false, error: '轨道不存在', code: 'ROOM_NOT_FOUND' }, 404);
    }

    const session = await createSession(sfuCtx(c.env));

    const result = await addTracks(sfuCtx(c.env), session.sessionId, {
      tracks: [
        {
          location: 'remote',
          sessionId: publisherSessionId,
          trackName,
        },
      ],
    });

    const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
    await registry.addUsage('subscribe_count', 1);

    return c.json({
      ok: true,
      data: {
        sessionId: session.sessionId,
        sessionDescription: result.sessionDescription,
        requiresImmediateRenegotiation: result.requiresImmediateRenegotiation ?? false,
      },
    });
  } catch (err) {
    return sfuErrorResponse(c, err);
  }
});

/**
 * 批量订阅：在【同一个接收会话】上一次拉取多条远端轨道。
 * 官方推荐一个接收会话承载所有订阅（见 negotiation 文档）。
 *
 * - 不传 sessionId：新建接收会话（SFU 会返回 offer）。
 * - 传 sessionId：复用已有接收会话，增量追加订阅。
 */
rtc.post('/subscribe-batch', zValidator('json', subscribeBatchSchema), async (c) => {
  const user = c.get('user');
  const { roomId, sessionId, tracks: requested } = c.req.valid('json');

  try {
    // 校验每条轨道确实在本房间登记（防乱猜）
    const roomStub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));
    const registered = await roomStub.listTracks();
    const valid = requested.filter((r) =>
      registered.some((t) => t.trackName === r.trackName && t.sessionId === r.publisherSessionId),
    );
    if (valid.length === 0) {
      return c.json({ ok: false, error: '轨道不存在', code: 'ROOM_NOT_FOUND' }, 404);
    }

    // 复用已有接收会话，否则新建一个
    const session = sessionId ? { sessionId } : await createSession(sfuCtx(c.env));

    const result = await addTracks(sfuCtx(c.env), session.sessionId, {
      tracks: valid.map((r) => ({
        location: 'remote' as const,
        sessionId: r.publisherSessionId,
        trackName: r.trackName,
        kind: 'audio' as const,
      })),
    });

    const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
    await registry.addUsage('subscribe_count', valid.length);

    void user;

    return c.json({
      ok: true,
      data: {
        sessionId: session.sessionId,
        sessionDescription: result.sessionDescription,
        tracks: result.tracks ?? [],
        requiresImmediateRenegotiation: result.requiresImmediateRenegotiation ?? false,
      },
    });
  } catch (err) {
    return sfuErrorResponse(c, err);
  }
});

/** 订阅方向重协商（提交 answer） */
rtc.post('/renegotiate', zValidator('json', renegotiateSchema), async (c) => {
  const { sessionId, sdp } = c.req.valid('json');
  try {
    const result = await renegotiateSession(sfuCtx(c.env), sessionId, {
      type: 'answer',
      sdp,
    });
    return c.json({ ok: true, data: result });
  } catch (err) {
    return sfuErrorResponse(c, err);
  }
});

/**
 * 关闭 tracks。
 *
 * 客户端传的是 trackName（它自己知道的标识），但 SFU 的 tracks/close
 * 必须给 **mid**（OpenAPI: "identified by mids"）。这里做一次解析。
 *
 * 自己发布的轨道：mid 从本房间的 tracks 表查。
 * 接收会话上订阅的轨道：mid 由客户端提供（它在 SDP 里看到过）。
 */
rtc.post('/close', zValidator('json', closeTracksSchema), async (c) => {
  const user = c.get('user');
  const { roomId, sessionId, trackNames, mids: clientMids, force } = c.req.valid('json');

  try {
    const roomStub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));

    // 判断这些 trackName 是否属于当前用户发布的
    const ownedFlags = await Promise.all(trackNames.map((n) => roomStub.ownsTrack(user.uid, n)));
    const allOwned = ownedFlags.every(Boolean);

    // 解析出要关闭的 mid 列表
    const resolvedMids: string[] = [];
    for (let i = 0; i < trackNames.length; i++) {
      const name = trackNames[i]!;
      if (ownedFlags[i]) {
        const mid = await roomStub.getTrackMid(name);
        if (mid) resolvedMids.push(mid);
      } else if (clientMids?.[i]) {
        // 订阅侧：用客户端提供的接收 mid
        resolvedMids.push(clientMids[i]!);
      }
    }

    if (resolvedMids.length === 0) {
      // 没有可关闭的 mid，视为已完成（幂等）
      return c.json({ ok: true, data: { tracks: [] } });
    }

    if (!allOwned && !force) {
      return c.json({ ok: false, error: '无权关闭该轨道', code: 'FORBIDDEN' }, 403);
    }

    const result = await closeTracks(sfuCtx(c.env), sessionId, resolvedMids, force !== false);

    // 只有自己发布的轨道才从注册表移除
    if (allOwned) {
      for (const name of trackNames) {
        await roomStub.unregisterTrack(name);
      }
    }

    return c.json({ ok: true, data: result });
  } catch (err) {
    return sfuErrorResponse(c, err);
  }
});

/** 上报用量（客户端在通话结束时把估算值送上来） */
rtc.post('/usage', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { bytes?: number };
  if (typeof body.bytes === 'number' && body.bytes > 0) {
    await addSfuUsage(c.env, body.bytes);
  }
  return c.json({ ok: true, data: { recorded: true } });
});

export default rtc;
