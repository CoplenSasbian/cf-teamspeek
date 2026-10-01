import type { RoomDO } from './durable/RoomDO';
import type { RegistryDO } from './durable/RegistryDO';
import type { AdminDO } from './durable/AdminDO';
import type { PresenceDO } from './durable/PresenceDO';

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
  /** 管理后台专用签名密钥（与客户端 SESSION_SECRET 完全独立） */
  ADMIN_SESSION_SECRET: string;
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
  /**
   * 跨域白名单，逗号分隔的完整 origin（如 `https://a.com,https://b.com`）。
   * 留空 = 只服务同源页面 + 不受 CORS 约束的原生客户端。
   * 写 `*` = 放行任意源，但**不允许携带 Cookie**（只能用 Bearer）。
   */
  ALLOWED_ORIGINS?: string;
  /**
   * 登录是否需要人机验证。**默认开启，且对所有身份生效**（访客 + 管理员）。
   * 设为 `false` 可整体关闭 —— 关掉后登录只剩「key + 失败锁定」这一层防护。
   */
  LOGIN_TURNSTILE?: string;
  /**
   * @deprecated 改用 `LOGIN_TURNSTILE`。
   * 仍然兼容（设 false 等同于 LOGIN_TURNSTILE=false），
   * 保留是为了让已在跑的部署升级后行为不变。
   */
  ADMIN_LOGIN_TURNSTILE?: string;

  // ---- Bindings ----
  DB: D1Database;
  ROOM_DO: DurableObjectNamespace<RoomDO>;
  REGISTRY_DO: DurableObjectNamespace<RegistryDO>;
  ADMIN_DO: DurableObjectNamespace<AdminDO>;
  PRESENCE_DO: DurableObjectNamespace<PresenceDO>;
}

/** Hono 上下文变量 */
export interface Variables {
  user: {
    uid: string;
    nickname: string;
    role: 'guest' | 'admin';
    iat?: number;
    exp?: number;
    /** 原始签发时间（秒）。滚动续期时保持不变，用于计算会话绝对寿命 */
    issuedAt?: number;
    /** token 绝对过期时间（秒） */
    expiresAt?: number;
  };
  /** 本次请求用的是 Cookie 还是 Bearer（第三方客户端自检用） */
  authMethod?: 'cookie' | 'bearer';
  /** 客户端 IP 的哈希（隐私）与前缀 */
  ipHash: string;
  ipPrefix: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
