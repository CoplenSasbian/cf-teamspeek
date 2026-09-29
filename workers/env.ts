import type { RoomDO } from './durable/RoomDO';
import type { RegistryDO } from './durable/RegistryDO';
import type { AdminDO } from './durable/AdminDO';

/**
 * Worker 环境绑定（与 wrangler.jsonc 的 bindings / vars 一一对应）。
 *
 * 用 `DurableObjectNamespace<T>` 参数化，这样 `env.ROOM_DO.get(id)`
 * 返回的 stub 上能直接看到 RoomDO 的方法（RPC 类型）。
 */
export interface Env {
  // ---- Secrets（.dev.vars / wrangler secret） ----
  REALTIME_SFU_APP_ID: string;
  REALTIME_SFU_BEARER_TOKEN: string;
  GUEST_KEY: string;
  ADMIN_KEY: string;
  SESSION_SECRET: string;
  TURNSTILE_SECRET_KEY: string;

  // ---- Vars（wrangler.jsonc vars） ----
  TURNSTILE_SITE_KEY: string;
  ADMIN_PATH: string;
  APP_NAME: string;
  MAX_ROOM_MEMBERS: string;
  E2EE_ENABLED: string;
  E2EE_FALLBACK: string;
  AUDIO_BITRATE_KBPS: string;
  USAGE_FLUSH_INTERVAL_MINUTES: string;
  AUDIT_RETENTION_DAYS: string;

  // ---- Bindings ----
  DB: D1Database;
  ROOM_DO: DurableObjectNamespace<RoomDO>;
  REGISTRY_DO: DurableObjectNamespace<RegistryDO>;
  ADMIN_DO: DurableObjectNamespace<AdminDO>;
}

/** Hono 上下文变量 */
export interface Variables {
  user: {
    uid: string;
    nickname: string;
    role: 'guest' | 'admin';
    iat?: number;
    exp?: number;
  };
  /** 客户端 IP 的哈希（隐私）与前缀 */
  ipHash: string;
  ipPrefix: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
