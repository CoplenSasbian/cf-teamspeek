import type { Context, Next } from 'hono';
import type { AppEnv } from '../env';

/**
 * 基于内存 Map 的简易限流（滑动窗口）。
 * Worker isolate 之间不共享，但对「防暴力猜 key」已足够——
 * 真正的锁定逻辑在 AdminDO 里（跨 isolate 一致）。
 */
const buckets = new Map<string, number[]>();

export interface RateLimitOptions {
  /** 时间窗（毫秒） */
  windowMs: number;
  /** 窗口内最大请求数 */
  max: number;
  /** 生成限流 key 的函数，默认按 IP */
  keyOf?: (c: Context<AppEnv>) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context<AppEnv>, next: Next) => {
    const key = opts.keyOf
      ? opts.keyOf(c)
      : (c.req.header('CF-Connecting-IP') ?? 'unknown');

    const now = Date.now();
    const windowStart = now - opts.windowMs;

    const hits = (buckets.get(key) ?? []).filter((t) => t > windowStart);
    if (hits.length >= opts.max) {
      const retryAfter = Math.ceil((hits[0]! + opts.windowMs - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { ok: false, error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' },
        429,
      );
    }

    hits.push(now);
    buckets.set(key, hits);

    // 顺手清理过期的桶，避免 Map 无限增长
    if (buckets.size > 2000) {
      for (const [k, v] of buckets) {
        const alive = v.filter((t) => t > windowStart);
        if (alive.length === 0) buckets.delete(k);
        else buckets.set(k, alive);
      }
    }

    await next();
  };
}

/** 预设：登录接口限流 */
export const loginRateLimit = rateLimit({ windowMs: 60_000, max: 10 });

/** 预设：普通 API 限流 */
export const apiRateLimit = rateLimit({ windowMs: 60_000, max: 240 });
