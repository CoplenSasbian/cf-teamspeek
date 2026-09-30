import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { getCookie, deleteCookie } from 'hono/cookie';
import { loginSchema, updateProfileSchema } from '@shared/schema';
import {
  signSession,
  signRenewedSession,
  verifySession,
  decideSessionRefresh,
} from '../lib/jwt';
import { timingSafeEqual, sha256Hex } from '../lib/crypto';
import { verifyTurnstile } from '../lib/turnstile';
import { loginRateLimit } from '../middleware/ratelimit';
import {
  SESSION_COOKIE,
  requireAuth,
  ipPrefix,
  geoOf,
  writeSessionCookie,
} from '../middleware/auth';
import {
  SESSION_TTL_HOURS,
  SESSION_ABSOLUTE_TTL_HOURS,
} from '@shared/constants';
import { ErrorCode } from '@shared/types';
import type { Profile } from '@shared/types';
import type { AppEnv } from '../env';

const auth = new Hono<AppEnv>();

/** 登录 / 续期 / 改资料都返回这个结构（跨客户端契约见 docs/API.md） */
function sessionResponse(token: string, profile: Profile, expiresInSeconds: number) {
  const now = Math.floor(Date.now() / 1000);
  return {
    token,
    expiresAt: now + expiresInSeconds,
    sessionExpiresAt: now + SESSION_ABSOLUTE_TTL_HOURS * 3600,
    role: profile.role,
    profile,
  };
}

/** 客户端启动时读取的前端配置（非敏感，无需鉴权） */
auth.get('/config', (c) => {
  return c.json({
    ok: true,
    data: {
      appName: c.env.APP_NAME,
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
      adminPath: c.env.ADMIN_PATH,
      maxRoomMembers: Number(c.env.MAX_ROOM_MEMBERS),
      e2eeEnabled: c.env.E2EE_ENABLED === 'true',
      e2eeFallback: c.env.E2EE_FALLBACK === 'true',
      audioBitrateKbps: Number(c.env.AUDIO_BITRATE_KBPS),
      // 原生客户端据此判断管理员登录是否可以脱离 WebView：
      // true = 需要人机验证（原生端要内嵌 WebView 渲染 Turnstile）
      adminLoginTurnstile: c.env.ADMIN_LOGIN_TURNSTILE !== 'false',
      // 是否配置了跨域白名单（排查第三方网页客户端问题时有用）
      crossOrigin: Boolean(c.env.ALLOWED_ORIGINS?.trim()),
    },
  });
});

/**
 * 登录：用 guest/admin key 换取会话 JWT。
 *
 * 凭据发放两种形态，兼顾两类客户端：
 *   - **浏览器**：HttpOnly Cookie（前端永远碰不到 token，XSS 也偷不走）
 *   - **其他客户端**：响应体里的 `token`，之后所有请求带
 *     `Authorization: Bearer <token>`
 *
 * 两者可以同时存在，互不干扰（Bearer 优先，见 middleware/auth.ts）。
 */
auth.post('/login', loginRateLimit, zValidator('json', loginSchema), async (c) => {
  const { key, nickname, avatarId, turnstileToken } = c.req.valid('json');

  const ip = c.req.header('CF-Connecting-IP') ?? '';
  const ipHash = await sha256Hex(`${ip}:${c.env.SESSION_SECRET}`);
  const prefix = ipPrefix(ip);
  const userAgent = c.req.header('User-Agent') ?? null;
  const { country, city } = geoOf(c.req.raw);

  // --- 1. 判断 key 身份（时序安全比较） ---
  const isAdmin = timingSafeEqual(key, c.env.ADMIN_KEY);
  const isGuest = !isAdmin && timingSafeEqual(key, c.env.GUEST_KEY);

  if (!isAdmin && !isGuest) {
    // 失败计数（DO 侧跨 isolate 一致）
    const scope = `login:${ipHash}`;
    const attemptStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
    await attemptStub.recordFailure(scope);
    await attemptStub.pushAudit({
      nickname,
      event: 'login_fail',
      ipHash,
      ipPrefix: prefix,
      country,
      city,
      userAgent,
    });
    return c.json({ ok: false, error: 'key 无效', code: ErrorCode.INVALID_KEY }, 401);
  }

  const role = isAdmin ? 'admin' : 'guest';

  // --- 2. 管理员登录强制 Turnstile（可用 ADMIN_LOGIN_TURNSTILE=false 关闭） ---
  if (role === 'admin' && c.env.ADMIN_LOGIN_TURNSTILE !== 'false') {
    const ts = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
    if (!ts.success) {
      const missing = ts.errors.includes('missing-input-response');
      return c.json(
        {
          ok: false,
          error: missing ? '请先完成人机验证' : '人机验证未通过，请重试',
          code: ErrorCode.TURNSTILE_FAILED,
          detail: ts.errors,
        },
        403,
      );
    }
  }

  // --- 3 封禁校验（被踢出服务器的昵称 / IP 不允许再进入） ---
  const banStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  if (await banStub.isBanned({ ipHash, nickname })) {
    return c.json({ ok: false, error: '你已被移出本服务器', code: ErrorCode.BANNED }, 403);
  }

  // --- 4. 昵称注册 / 复用 ---
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const existing = await registry.lookupByNickname(nickname);

  let uid: string;
  let profile: Profile;

  if (existing) {
    if (existing.role !== role) {
      return c.json(
        {
          ok: false,
          error: '该昵称已被其他身份占用，请换一个昵称',
          code: ErrorCode.NICKNAME_TAKEN,
        },
        409,
      );
    }
    uid = existing.uid;
    profile = {
      uid,
      nickname: existing.nickname,
      role,
      avatarId: avatarId ?? existing.avatarId,
      avatarUrl: existing.avatarUrl,
    };
    if (avatarId !== undefined && avatarId !== existing.avatarId) {
      await registry.updateProfile({ uid, avatarId });
    }
  } else {
    const reg = await registry.registerNickname({ nickname, role, avatarId: avatarId ?? null });
    if (!reg.ok) {
      const messages: Record<string, string> = {
        NICKNAME_TAKEN: '昵称已被占用，请换一个',
        NICKNAME_RESERVED: '该昵称为保留昵称，不可使用',
        NICKNAME_INVALID: '昵称格式不合法（2–16 字符，中英文/数字/下划线/短横线）',
      };
      return c.json(
        { ok: false, error: messages[reg.code] ?? '昵称不可用', code: reg.code },
        409,
      );
    }
    uid = reg.uid;
    profile = reg.profile;
  }

  // --- 5. 签发 JWT + 下发 Cookie ---
  const token = await signSession(
    { uid, nickname: profile.nickname, role },
    c.env.SESSION_SECRET,
  );
  writeSessionCookie(c, SESSION_COOKIE, token, SESSION_TTL_HOURS * 3600);

  // --- 6. 清空失败计数 + 写审计 ---
  const adminStub = c.env.ADMIN_DO.get(c.env.ADMIN_DO.idFromName('global'));
  await adminStub.recordSuccess(`login:${ipHash}`);
  await adminStub.pushAudit({
    uid,
    nickname: profile.nickname,
    role,
    event: 'login_ok',
    ipHash,
    ipPrefix: prefix,
    country,
    city,
    userAgent,
  });

  return c.json({
    ok: true,
    data: sessionResponse(token, profile, SESSION_TTL_HOURS * 3600),
  });
});

/**
 * 显式续期。
 *
 * 服务端本来就会在任意鉴权请求上滚动续期（见 middleware/auth.ts），
 * 这个端点存在的意义是给**长连接客户端**一个确定的续期时机：
 * 比如一个整晚开着、只发 WebSocket 心跳的桌面客户端，可以定时打一次
 * 这里，确保 token 不过期。
 *
 * 返回新的 token；若已超过绝对寿命，返回 401 SESSION_EXPIRED。
 */
auth.post('/refresh', async (c) => {
  const header = c.req.header('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const token = bearer || getCookie(c, SESSION_COOKIE);

  if (!token) {
    return c.json({ ok: false, error: '未登录', code: ErrorCode.UNAUTHORIZED }, 401);
  }

  const session = await verifySession(token, c.env.SESSION_SECRET);
  if (!session) {
    return c.json(
      { ok: false, error: '会话已过期，请重新登录', code: ErrorCode.UNAUTHORIZED },
      401,
    );
  }

  const decision = decideSessionRefresh(session);
  if (decision.action === 'expired') {
    return c.json(
      { ok: false, error: '登录状态已到期，请重新登录', code: ErrorCode.SESSION_EXPIRED },
      401,
    );
  }

  // 到期时间不能越过绝对上限：TTL 取「滚动窗口」与「剩余绝对寿命」的较小值。
  // 剩得太少就不发了 —— 给一个马上过期的 token 等于骗客户端说「续期成功」。
  const now = Math.floor(Date.now() / 1000);
  const absoluteLeft = session.issuedAt + SESSION_ABSOLUTE_TTL_HOURS * 3600 - now;
  if (absoluteLeft <= 60) {
    return c.json(
      { ok: false, error: '登录状态已到期，请重新登录', code: ErrorCode.SESSION_EXPIRED },
      401,
    );
  }
  const ttl = Math.min(SESSION_TTL_HOURS * 3600, absoluteLeft);

  const fresh = await signRenewedSession(
    { uid: session.uid, nickname: session.nickname, role: session.role },
    c.env.SESSION_SECRET,
    session.issuedAt,
    ttl,
  );

  // 客户端可能只带 Bearer（没有 cookie），所以两种都写：有 cookie 的浏览器顺手续上
  writeSessionCookie(c, SESSION_COOKIE, fresh, ttl);

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const profile = await registry.lookupByUid(session.uid);
  if (!profile) {
    return c.json({ ok: false, error: '用户不存在', code: ErrorCode.UNAUTHORIZED }, 401);
  }

  return c.json({ ok: true, data: sessionResponse(fresh, profile, ttl) });
});

/** 当前会话信息 */
auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const profile = await registry.lookupByUid(user.uid);
  if (!profile) {
    return c.json({ ok: false, error: '用户不存在', code: ErrorCode.UNAUTHORIZED }, 401);
  }
  const now = Math.floor(Date.now() / 1000);
  return c.json({
    ok: true,
    data: {
      profile,
      authMethod: c.get('authMethod'),
      expiresAt: user.exp ?? null,
      sessionExpiresAt: (user.issuedAt ?? now) + SESSION_ABSOLUTE_TTL_HOURS * 3600,
    },
  });
});

/** 更新资料（昵称 / 头像） */
auth.patch('/me', requireAuth, zValidator('json', updateProfileSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));

  const res = await registry.updateProfile({
    uid: user.uid,
    nickname: body.nickname,
    avatarId: body.avatarId,
    avatarUrl: body.avatarDataUrl ?? undefined,
  });

  if (!res.ok) {
    const messages: Record<string, string> = {
      NICKNAME_TAKEN: '昵称已被占用',
      NICKNAME_RESERVED: '该昵称为保留昵称',
      NICKNAME_INVALID: '昵称格式不合法',
      UNAUTHORIZED: '未登录',
    };
    return c.json(
      { ok: false, error: messages[res.code ?? ''] ?? '更新失败', code: res.code },
      400,
    );
  }

  // 昵称可能变了，重新签发 token。
  // 注意 issuedAt 沿用原始值：改资料不该刷新会话的绝对寿命。
  const profile = res.profile!;
  const issuedAt = user.issuedAt ?? Math.floor(Date.now() / 1000);
  const decision = decideSessionRefresh({ issuedAt });
  const ttl = decision.action === 'renew' ? decision.ttlSeconds : SESSION_TTL_HOURS * 3600;
  const token = await signRenewedSession(
    { uid: profile.uid, nickname: profile.nickname, role: profile.role },
    c.env.SESSION_SECRET,
    issuedAt,
    ttl,
  );
  writeSessionCookie(c, SESSION_COOKIE, token, ttl);

  // 资料是元数据：uid 才是身份主键，改名/换头像不等于换人。
  // 因此这里把新资料原地同步到在线名册和该用户当前所在的房间，
  // 而不是让他「退出再进入」——房间里的其他人也会立刻看到新昵称。
  try {
    const presence = c.env.PRESENCE_DO.get(c.env.PRESENCE_DO.idFromName('global'));
    const { roomId } = await presence.refreshProfile({
      uid: profile.uid,
      nickname: profile.nickname,
      avatarId: profile.avatarId,
      avatarUrl: profile.avatarUrl,
    });

    if (roomId) {
      const roomStub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));
      await roomStub.updateMemberProfile({
        uid: profile.uid,
        nickname: profile.nickname,
        avatarId: profile.avatarId,
        avatarUrl: profile.avatarUrl,
      });
    }
  } catch (err) {
    // 同步失败不影响资料本身已保存，客户端下次心跳会自我纠正
    console.error('[auth] 资料同步到房间/名册失败', err);
  }

  return c.json({
    ok: true,
    data: { profile, token, expiresAt: Math.floor(Date.now() / 1000) + ttl },
  });
});

/**
 * 登出。
 *
 * JWT 是无状态的，服务端不维护撤销列表 —— 登出 = 清 cookie + 客户端丢弃 token。
 * 因此这个端点**不要求鉴权**：带着已经过期的 token 来登出也必须成功，
 * 否则客户端会卡在「登不出去」的状态里。
 */
auth.post('/logout', async (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true, data: { loggedOut: true } });
});

export default auth;
