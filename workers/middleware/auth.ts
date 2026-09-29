import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { verifySession, verifyAdminSession } from '../lib/jwt';
import { sha256Hex } from '../lib/crypto';
import { ADMIN_SESSION_COOKIE } from '@shared/constants';
import type { AppEnv } from '../env';

export const SESSION_COOKIE = 'ct_session';

/**
 * 鉴权中间件：优先读 HttpOnly Cookie，其次读 Authorization: Bearer。
 * 校验通过后把 user / ipHash / ipPrefix 注入上下文。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const cookieToken = getCookie(c, SESSION_COOKIE);
  const header = c.req.header('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const token = cookieToken ?? bearer;

  if (!token) {
    return c.json({ ok: false, error: '未登录', code: 'UNAUTHORIZED' }, 401);
  }

  const session = await verifySession(token, c.env.SESSION_SECRET);
  if (!session) {
    return c.json({ ok: false, error: '会话已过期，请重新登录', code: 'UNAUTHORIZED' }, 401);
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '';
  c.set('user', session);
  c.set('ipHash', await sha256Hex(`${ip}:${c.env.SESSION_SECRET}`));
  c.set('ipPrefix', ipPrefix(ip));

  await next();
});

/**
 * 管理后台鉴权：读专用 cookie（ct_admin_session），用专用 secret 校验。
 * 与客户端会话完全隔离 —— 客户端 token（哪怕 role=admin）进不了后台 API，
 * 后台 token 也访问不了客户端 API。
 */
export const requireAdminSession = createMiddleware<AppEnv>(async (c, next) => {
  const cookieToken = getCookie(c, ADMIN_SESSION_COOKIE);
  const header = c.req.header('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const token = cookieToken ?? bearer;

  if (!token) {
    return c.json({ ok: false, error: '未登录', code: 'UNAUTHORIZED' }, 401);
  }

  const session = await verifyAdminSession(token, c.env.ADMIN_SESSION_SECRET);
  if (!session) {
    return c.json({ ok: false, error: '后台会话已过期，请重新登录', code: 'UNAUTHORIZED' }, 401);
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '';
  c.set('user', { uid: 'admin', nickname: session.nickname, role: 'admin' });
  c.set('ipHash', await sha256Hex(`${ip}:${c.env.ADMIN_SESSION_SECRET}`));
  c.set('ipPrefix', ipPrefix(ip));

  await next();
});

/** 仅管理员可通过 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ ok: false, error: '需要管理员权限', code: 'FORBIDDEN' }, 403);
  }
  await next();
});

/** 取 IP 前两段（IPv4）/ 前四组（IPv6），用于审计展示且不完整记录 IP */
export function ipPrefix(ip: string): string {
  if (!ip) return '';
  if (ip.includes('.')) {
    return ip.split('.').slice(0, 2).join('.') + '.x.x';
  }
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':') + '::x';
  }
  return '';
}

/** request.cf 的地域信息（Cloudflare 免费提供，无需额外服务） */
export function geoOf(req: Request): { country: string | null; city: string | null } {
  const cf = (req as unknown as { cf?: { country?: string; city?: string } }).cf;
  return { country: cf?.country ?? null, city: cf?.city ?? null };
}
