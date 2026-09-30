import { SignJWT, jwtVerify } from 'jose';
import {
  SESSION_ABSOLUTE_TTL_HOURS,
  SESSION_TTL_HOURS,
  ADMIN_SESSION_ABSOLUTE_TTL_HOURS,
  ADMIN_SESSION_TTL_HOURS,
} from '@shared/constants';
import type { SessionPayload } from '@shared/types';

const ALG = 'HS256';

/** audience 声明：客户端与管理后台的 token 互不通用，即使 secret 相同也校验不过 */
const AUD_CLIENT = 'ct:client';
const AUD_ADMIN = 'ct:admin';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 续期时至少要有这么长的剩余寿命，否则视为「会话到顶」。
 * 给一个只剩几秒的 token 毫无意义，还会让客户端误判续期成功。
 */
const MIN_REFRESH_SECONDS = 60;

// ============================================================
//  客户端会话
// ============================================================

/**
 * 会话校验结果。`null` = token 无效。
 *
 * 关键：`iat` 是**原始签发时间**，续期时原样保留。
 * 这样服务端能用一个不变的时间锚点判断会话的绝对寿命，
 * 而不是被「每次续期都刷新 iat」骗过去，把会话无限延长。
 */
export interface VerifiedSession extends SessionPayload {
  /** 原始签发时间（秒） */
  issuedAt: number;
  /** token 过期时间（秒） */
  expiresAt: number;
}

export interface SignSessionOptions {
  /** 覆盖签发时间（续期时传原始 iat）；默认当前时间 */
  issuedAt?: number;
  /** 有效期（秒）；默认 SESSION_TTL_HOURS */
  ttlSeconds?: number;
}

/** 签发客户端会话 JWT */
export async function signSession(
  payload: Pick<SessionPayload, 'uid' | 'nickname' | 'role'>,
  sessionSecret: string,
  options: SignSessionOptions = {},
): Promise<string> {
  const iat = options.issuedAt ?? nowSeconds();
  const ttl = options.ttlSeconds ?? SESSION_TTL_HOURS * 3600;

  return new SignJWT({ uid: payload.uid, nickname: payload.nickname, role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setAudience(AUD_CLIENT)
    .setSubject(payload.uid)
    .sign(secretKey(sessionSecret));
}

/** 校验客户端会话 JWT，失败返回 null */
export async function verifySession(
  token: string,
  sessionSecret: string,
): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(sessionSecret), {
      algorithms: [ALG],
      audience: AUD_CLIENT,
    });
    const uid = typeof payload.uid === 'string' ? payload.uid : payload.sub;
    if (!uid || typeof payload.role !== 'string') return null;

    const issuedAt = typeof payload.iat === 'number' ? payload.iat : nowSeconds();
    return {
      uid,
      nickname: String(payload.nickname ?? ''),
      role: payload.role === 'admin' ? 'admin' : 'guest',
      iat: payload.iat,
      exp: payload.exp,
      issuedAt,
      expiresAt: typeof payload.exp === 'number' ? payload.exp : issuedAt + SESSION_TTL_HOURS * 3600,
    };
  } catch {
    return null;
  }
}

/**
 * 会话续期决策。
 *
 * `ttlSeconds` 的语义：**从当前时刻起**新 token 的有效期。
 * 因此重签时要用 `exp = now + ttlSeconds`，而不是 `exp = iat + ttlSeconds` ——
 * 后者会让「续期」变成一个原地踏步的空操作（老 token 剩多久，新 token 就还是多久）。
 *
 * - `expired`：已超过绝对上限（原始 iat + SESSION_ABSOLUTE_TTL_HOURS），
 *   必须重新用 key 登录。这是防止「一次登录永久有效」的硬闸。
 * - `skip`：token 还足够新（用掉不到 25%），不必重签，省一次签名开销。
 * - `renew`：重签。原始 iat 保持不变，到期时间推到 now + ttlSeconds，
 *   但绝不越过绝对上限。
 */
export function decideSessionRefresh(
  session: Pick<VerifiedSession, 'issuedAt'>,
  now = nowSeconds(),
): { action: 'renew' | 'skip' | 'expired'; ttlSeconds: number } {
  const absoluteTtl = SESSION_ABSOLUTE_TTL_HOURS * 3600;
  const age = now - session.issuedAt;

  if (age >= absoluteTtl) {
    return { action: 'expired', ttlSeconds: 0 };
  }

  // 用掉不到 25% 就不重签：避免每个请求都产生新 token
  if (age < SESSION_TTL_HOURS * 3600 * 0.25) {
    return { action: 'skip', ttlSeconds: 0 };
  }

  const remaining = absoluteTtl - age;
  // 剩余寿命太短就不发新 token 了：给一个只剩几秒的 token 毫无意义，
  // 反而会让客户端误以为「续期成功了」。直接判定到顶，让它回登录页。
  if (remaining <= MIN_REFRESH_SECONDS) {
    return { action: 'expired', ttlSeconds: 0 };
  }

  return {
    action: 'renew',
    ttlSeconds: Math.min(SESSION_TTL_HOURS * 3600, remaining),
  };
}

/**
 * 按「从当前时刻起算」的语义签发续期 token。
 *
 * 与 `signSession` 的区别：`exp = now + ttlSeconds`，而不是 `iat + ttlSeconds`。
 * 这是续期能真正把有效期往后推的关键。
 */
export async function signRenewedSession(
  payload: Pick<SessionPayload, 'uid' | 'nickname' | 'role'>,
  sessionSecret: string,
  issuedAt: number,
  ttlSeconds: number,
): Promise<string> {
  const iat = nowSeconds();
  return new SignJWT({ uid: payload.uid, nickname: payload.nickname, role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(issuedAt)
    .setExpirationTime(iat + ttlSeconds)
    .setAudience(AUD_CLIENT)
    .setSubject(payload.uid)
    .sign(secretKey(sessionSecret));
}

/** 后台会话的续期 token（语义同 signRenewedSession） */
export async function signRenewedAdminSession(
  nickname: string,
  adminSecret: string,
  issuedAt: number,
  ttlSeconds: number,
): Promise<string> {
  const iat = nowSeconds();
  return new SignJWT({ nickname, role: 'admin' })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(issuedAt)
    .setExpirationTime(iat + ttlSeconds)
    .setAudience(AUD_ADMIN)
    .setSubject('admin')
    .sign(secretKey(adminSecret));
}

// ============================================================
//  管理后台会话：独立 secret + 独立 audience + 独立 TTL
// ============================================================

/** 管理后台会话 payload（不需要 uid —— 后台凭 key 登录，不注册昵称） */
export interface AdminSessionPayload {
  nickname: string;
  iat?: number;
  exp?: number;
}

export interface VerifiedAdminSession extends AdminSessionPayload {
  issuedAt: number;
  expiresAt: number;
}

export async function signAdminSession(
  nickname: string,
  adminSecret: string,
  options: SignSessionOptions = {},
): Promise<string> {
  const iat = options.issuedAt ?? nowSeconds();
  const ttl = options.ttlSeconds ?? ADMIN_SESSION_TTL_HOURS * 3600;

  return new SignJWT({ nickname, role: 'admin' })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setAudience(AUD_ADMIN)
    .setSubject('admin')
    .sign(secretKey(adminSecret));
}

export async function verifyAdminSession(
  token: string,
  adminSecret: string,
): Promise<VerifiedAdminSession | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(adminSecret), {
      algorithms: [ALG],
      audience: AUD_ADMIN,
    });
    const issuedAt = typeof payload.iat === 'number' ? payload.iat : nowSeconds();
    return {
      nickname: String(payload.nickname ?? 'admin'),
      iat: payload.iat,
      exp: payload.exp,
      issuedAt,
      expiresAt:
        typeof payload.exp === 'number' ? payload.exp : issuedAt + ADMIN_SESSION_TTL_HOURS * 3600,
    };
  } catch {
    return null;
  }
}

/** 后台会话续期决策（与客户端同构，阈值不同） */
export function decideAdminSessionRefresh(
  session: Pick<VerifiedAdminSession, 'issuedAt'>,
  now = nowSeconds(),
): { action: 'renew' | 'skip' | 'expired'; ttlSeconds: number } {
  const absoluteTtl = ADMIN_SESSION_ABSOLUTE_TTL_HOURS * 3600;
  const age = now - session.issuedAt;

  if (age >= absoluteTtl) {
    return { action: 'expired', ttlSeconds: 0 };
  }

  if (age < ADMIN_SESSION_TTL_HOURS * 3600 * 0.25) {
    return { action: 'skip', ttlSeconds: 0 };
  }

  const remaining = absoluteTtl - age;
  if (remaining <= MIN_REFRESH_SECONDS) {
    return { action: 'expired', ttlSeconds: 0 };
  }

  return {
    action: 'renew',
    ttlSeconds: Math.min(ADMIN_SESSION_TTL_HOURS * 3600, remaining),
  };
}
