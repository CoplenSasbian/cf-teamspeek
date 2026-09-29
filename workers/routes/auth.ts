import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { loginSchema, updateProfileSchema } from '@shared/schema';
import { signSession } from '../lib/jwt';
import { timingSafeEqual, sha256Hex } from '../lib/crypto';
import { verifyTurnstile } from '../lib/turnstile';
import { loginRateLimit } from '../middleware/ratelimit';
import { SESSION_COOKIE, requireAuth, ipPrefix, geoOf } from '../middleware/auth';
import { SESSION_TTL_HOURS } from '@shared/constants';
import type { AppEnv } from '../env';

const auth = new Hono<AppEnv>();

/** 客户端启动时读取的前端配置（非敏感） */
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
    },
  });
});

/** 登录：用 guest/admin key 换取会话 JWT */
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
    return c.json({ ok: false, error: 'key 无效', code: 'INVALID_KEY' }, 401);
  }

  const role = isAdmin ? 'admin' : 'guest';

  // --- 2. 管理员登录强制 Turnstile ---
  if (role === 'admin') {
    const ts = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
    if (!ts.success) {
      const missing = ts.errors.includes('missing-input-response');
      return c.json(
        {
          ok: false,
          error: missing ? '请先完成人机验证' : '人机验证未通过，请重试',
          code: 'TURNSTILE_FAILED',
          detail: ts.errors,
        },
        403,
      );
    }
  }

  // --- 3. 昵称注册 / 复用 ---
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));

  // 若是管理员本人且昵称已注册给同一 uid，则直接复用
  const existing = await registry.lookupByNickname(nickname);

  let uid: string;
  let profile: { uid: string; nickname: string; role: 'guest' | 'admin'; avatarId: string | null; avatarUrl: string | null };

  if (existing) {
    if (existing.role !== role) {
      return c.json(
        { ok: false, error: '该昵称已被其他身份占用，请换一个昵称', code: 'NICKNAME_TAKEN' },
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

  // --- 4. 签发 JWT ---
  const token = await signSession({ uid, nickname: profile.nickname, role }, c.env.SESSION_SECRET);

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: SESSION_TTL_HOURS * 3600,
  });

  // --- 5. 清空失败计数 + 写审计 ---
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

  return c.json({ ok: true, data: { token, role, profile } });
});

/** 当前会话信息 */
auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName('global'));
  const profile = await registry.lookupByUid(user.uid);
  if (!profile) {
    return c.json({ ok: false, error: '用户不存在', code: 'UNAUTHORIZED' }, 401);
  }
  return c.json({ ok: true, data: { profile } });
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

  // 昵称可能变了，重新签发 token
  const profile = res.profile!;
  const token = await signSession(
    { uid: profile.uid, nickname: profile.nickname, role: profile.role },
    c.env.SESSION_SECRET,
  );
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: SESSION_TTL_HOURS * 3600,
  });

  return c.json({ ok: true, data: { profile, token } });
});

/** 登出 */
auth.post('/logout', async (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true, data: { loggedOut: true } });
});

export default auth;
