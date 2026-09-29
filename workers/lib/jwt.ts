import { SignJWT, jwtVerify } from 'jose';
import { SESSION_TTL_HOURS, ADMIN_SESSION_TTL_HOURS } from '@shared/constants';
import type { SessionPayload } from '@shared/types';

const ALG = 'HS256';

/** audience 声明：客户端与管理后台的 token 互不通用，即使 secret 相同也校验不过 */
const AUD_CLIENT = 'ct:client';
const AUD_ADMIN = 'ct:admin';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** 签发客户端会话 JWT */
export async function signSession(
  payload: Pick<SessionPayload, 'uid' | 'nickname' | 'role'>,
  sessionSecret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ uid: payload.uid, nickname: payload.nickname, role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_HOURS * 3600)
    .setAudience(AUD_CLIENT)
    .setSubject(payload.uid)
    .sign(secretKey(sessionSecret));
}

/** 校验客户端会话 JWT，失败返回 null */
export async function verifySession(
  token: string,
  sessionSecret: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(sessionSecret), {
      algorithms: [ALG],
      audience: AUD_CLIENT,
    });
    const uid = typeof payload.uid === 'string' ? payload.uid : payload.sub;
    if (!uid || typeof payload.role !== 'string') return null;
    return {
      uid,
      nickname: String(payload.nickname ?? ''),
      role: payload.role === 'admin' ? 'admin' : 'guest',
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
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

export async function signAdminSession(
  nickname: string,
  adminSecret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nickname, role: 'admin' })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + ADMIN_SESSION_TTL_HOURS * 3600)
    .setAudience(AUD_ADMIN)
    .setSubject('admin')
    .sign(secretKey(adminSecret));
}

export async function verifyAdminSession(
  token: string,
  adminSecret: string,
): Promise<AdminSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(adminSecret), {
      algorithms: [ALG],
      audience: AUD_ADMIN,
    });
    return { nickname: String(payload.nickname ?? 'admin'), iat: payload.iat, exp: payload.exp };
  } catch {
    return null;
  }
}
