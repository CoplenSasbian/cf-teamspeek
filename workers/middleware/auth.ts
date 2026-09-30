import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie } from 'hono/cookie';
import {
  verifySession,
  verifyAdminSession,
  signRenewedSession,
  signRenewedAdminSession,
  decideSessionRefresh,
  decideAdminSessionRefresh,
  type VerifiedSession,
  type VerifiedAdminSession,
} from '../lib/jwt';
import { sha256Hex } from '../lib/crypto';
import { ADMIN_SESSION_COOKIE } from '@shared/constants';
import { ErrorCode } from '@shared/types';
import type { AppEnv } from '../env';

export const SESSION_COOKIE = 'ct_session';

/** 客户端携带凭据的方式。会在响应里回显（`X-Auth-Method`），便于客户端自检 */
export type AuthMethod = 'cookie' | 'bearer';

interface Credential {
  token: string;
  method: AuthMethod;
}

/**
 * 取凭据：`Authorization: Bearer` **优先于** Cookie。
 *
 * 为什么 Bearer 优先：一个客户端可能同时持有两者（比如内嵌 WebView 的桌面壳，
 * 外层用 token、WebView 里带着 cookie）。显式声明的凭据应当胜过隐式的，
 * 否则「切账号」这类操作会被旧 cookie 悄悄覆盖。
 * 对纯浏览器客户端无影响 —— 它们根本不发 Authorization 头。
 */
function readCredential(c: Context<AppEnv>, cookieName: string): Credential | null {
  const header = c.req.header('Authorization');
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return { token, method: 'bearer' };
  }
  const cookieToken = getCookie(c, cookieName);
  if (cookieToken) return { token: cookieToken, method: 'cookie' };
  return null;
}

/** 与请求协议保持一致的 Cookie 选项 */
function sessionCookieOptions(url: string, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // Lax：同站请求自动携带；跨站 XHR 不携带（防 CSRF）。
    // 第三方域名的网页客户端请改用 Bearer，不要指望 cookie 跨站。
    sameSite: 'Lax' as const,
    secure: new URL(url).protocol === 'https:',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * 续期落地：
 *   - Cookie 客户端 → Set-Cookie（浏览器完全无感）
 *   - Bearer 客户端 → 响应头 `X-Refreshed-Token`（长连接场景也能顺手换掉）
 *
 * 无论哪种方式都回 `X-Refreshed-Token`，这样客户端只需实现一条路径。
 */
async function applyRefresh(
  c: Context<AppEnv>,
  opts: {
    token: string;
    ttlSeconds: number;
    method: AuthMethod;
    cookieName: string;
  },
): Promise<void> {
  if (opts.method === 'cookie') {
    setCookie(
      c,
      opts.cookieName,
      opts.token,
      sessionCookieOptions(c.req.url, opts.ttlSeconds),
    );
  }
  c.header('X-Refreshed-Token', opts.token);
}

/**
 * 鉴权中间件：Cookie 或 Bearer 均可。
 *
 * 校验通过后注入 `user` / `authMethod` / `ipHash` / `ipPrefix`。
 *
 * **滚动续期**：只要会话还活跃，服务端会在任意一次鉴权请求上顺带换发 token
 * （原始 `iat` 不变，到期时间往后推）。这解决了一个真实痛点 ——
 * 原来的 12 小时固定 TTL 意味着「连玩一整晚」中途会被踢下线。
 * 绝对寿命由 `SESSION_ABSOLUTE_TTL_HOURS` 兜底，不会被无限续期。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const cred = readCredential(c, SESSION_COOKIE);
  if (!cred) {
    return c.json({ ok: false, error: '未登录', code: ErrorCode.UNAUTHORIZED }, 401);
  }

  const session = await verifySession(cred.token, c.env.SESSION_SECRET);
  if (!session) {
    return c.json(
      { ok: false, error: '会话已过期，请重新登录', code: ErrorCode.UNAUTHORIZED },
      401,
    );
  }

  const decision = decideSessionRefresh(session);

  // 绝对寿命到顶：必须重新用 key 登录。
  // 刻意用 SESSION_EXPIRED 而不是 UNAUTHORIZED —— 前者告诉客户端
  // 「清理本地会话、回登录页」，后者是「这个 token 不对」。
  if (decision.action === 'expired') {
    return c.json(
      { ok: false, error: '登录状态已到期，请重新登录', code: ErrorCode.SESSION_EXPIRED },
      401,
    );
  }

  if (decision.action === 'renew') {
    const token = await signRenewedSession(
      { uid: session.uid, nickname: session.nickname, role: session.role },
      c.env.SESSION_SECRET,
      session.issuedAt,
      decision.ttlSeconds,
    );
    await applyRefresh(c, {
      token,
      ttlSeconds: decision.ttlSeconds,
      method: cred.method,
      cookieName: SESSION_COOKIE,
    });
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '';
  c.set('user', session);
  c.set('authMethod', cred.method);
  c.set('ipHash', await sha256Hex(`${ip}:${c.env.SESSION_SECRET}`));
  c.set('ipPrefix', ipPrefix(ip));

  await next();
});

/**
 * 管理后台鉴权：读专用凭据（cookie `ct_admin_session` 或 Bearer），
 * 用专用 secret 校验。与客户端会话完全隔离 —— 客户端 token（哪怕 role=admin）
 * 进不了后台 API，后台 token 也访问不了客户端 API。
 *
 * Bearer 支持是**跨客户端的关键**：后台 API 之前只认 cookie，
 * 于是任何非浏览器客户端（脚本 / 原生 App / CI）都无法调管理接口。
 */
export const requireAdminSession = createMiddleware<AppEnv>(async (c, next) => {
  const cred = readCredential(c, ADMIN_SESSION_COOKIE);
  if (!cred) {
    return c.json({ ok: false, error: '未登录', code: ErrorCode.UNAUTHORIZED }, 401);
  }

  const session = await verifyAdminSession(cred.token, c.env.ADMIN_SESSION_SECRET);
  if (!session) {
    return c.json(
      { ok: false, error: '后台会话已过期，请重新登录', code: ErrorCode.UNAUTHORIZED },
      401,
    );
  }

  const decision = decideAdminSessionRefresh(session);
  if (decision.action === 'expired') {
    return c.json(
      { ok: false, error: '后台登录状态已到期，请重新登录', code: ErrorCode.SESSION_EXPIRED },
      401,
    );
  }

  if (decision.action === 'renew') {
    const token = await signRenewedAdminSession(
      session.nickname,
      c.env.ADMIN_SESSION_SECRET,
      session.issuedAt,
      decision.ttlSeconds,
    );
    await applyRefresh(c, {
      token,
      ttlSeconds: decision.ttlSeconds,
      method: cred.method,
      cookieName: ADMIN_SESSION_COOKIE,
    });
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '';
  c.set('user', { uid: 'admin', nickname: session.nickname, role: 'admin' });
  c.set('authMethod', cred.method);
  c.set('ipHash', await sha256Hex(`${ip}:${c.env.ADMIN_SESSION_SECRET}`));
  c.set('ipPrefix', ipPrefix(ip));

  await next();
});

/** 仅管理员可通过（客户端会话内的 admin 角色） */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ ok: false, error: '需要管理员权限', code: ErrorCode.FORBIDDEN }, 403);
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

/**
 * 供路由复用：把新签发的会话写回客户端（cookie）。
 * Bearer 客户端直接读响应体里的 token，不依赖这个。
 */
export function writeSessionCookie(
  c: Context<AppEnv>,
  cookieName: string,
  token: string,
  ttlSeconds: number,
): void {
  setCookie(c, cookieName, token, sessionCookieOptions(c.req.url, ttlSeconds));
}

/** 类型别名，便于路由层直接引用 */
export type { VerifiedSession, VerifiedAdminSession };
