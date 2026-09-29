import { SignJWT, jwtVerify } from 'jose';
import { SESSION_TTL_HOURS } from '@shared/constants';
import type { SessionPayload } from '@shared/types';

const ALG = 'HS256';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** 签发会话 JWT */
export async function signSession(
  payload: Pick<SessionPayload, 'uid' | 'nickname' | 'role'>,
  sessionSecret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ uid: payload.uid, nickname: payload.nickname, role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_HOURS * 3600)
    .setSubject(payload.uid)
    .sign(secretKey(sessionSecret));
}

/** 校验会话 JWT，失败返回 null */
export async function verifySession(
  token: string,
  sessionSecret: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(sessionSecret), {
      algorithms: [ALG],
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
