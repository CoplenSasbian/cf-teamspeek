import type { Context, Next } from 'hono';
import type { AppEnv } from '../env';

/**
 * 跨域（CORS）支持 —— 让「另一个域名下的网页客户端」也能用这套 API。
 *
 * 设计取舍：
 *
 *   1. **默认同源零开销**。所有 `/api/*` 接口默认只服务本站页面（Cookie + 同源），
 *      没有配置白名单时不产生任何额外交互。原生客户端（Node / Kotlin / Swift / CLI）
 *      本来就不受 CORS 约束，也无需配置。
 *
 *   2. **白名单是环境变量**（`ALLOWED_ORIGINS`，逗号分隔）。只有明确列出的源
 *      才会拿到 CORS 响应头。`*` 单独写表示放行任意源，但**不允许携带凭据**
 *      （浏览器规范：`Access-Control-Allow-Origin: *` 与
 *      `Access-Control-Allow-Credentials: true` 不能共存），此时客户端只能用
 *      Bearer token 鉴权 —— 这正是第三方客户端的推荐做法。
 *
 *   3. **精确回显来源**。命中白名单时回显 `Origin` 而不是写死某个域名，
 *      因为同一个部署可能被多个前端（网页版 / 桌面套壳 / 调试页）使用。
 *
 *   4. **预检（OPTIONS）在中间件最外层拦截**，不会走到鉴权中间件，
 *      所以未登录的预检请求也能拿到正确响应 —— 否则浏览器端会看到
 *      「CORS 预检失败」而不是真正的 401，极难排查。
 */

/** 解析 ALLOWED_ORIGINS：逗号分隔；去空白；统一小写便于比较 */
function parseAllowed(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, '').toLowerCase())
    .filter(Boolean);
}

/** 预检缓存时长（秒）—— 1 小时，减少 OPTIONS 请求量 */
const PREFLIGHT_MAX_AGE = '3600';

/** 允许的请求头：鉴权 + 内容类型 + 少量排查用的自定义头 */
const ALLOW_HEADERS = 'Authorization, Content-Type, X-Requested-With';

/** 允许的方法：本项目全部 API 只用到这几个 */
const ALLOW_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

/** 暴露给前端 JS 可读的响应头（分页/限流排查用） */
const EXPOSE_HEADERS = 'Retry-After, Content-Disposition';

/**
 * 判断某次请求是否需要跨域响应头。
 * 返回 null 表示「不放行」，调用方不应写任何 CORS 头。
 *
 * 导出是为了让 `scripts/test-client-api.ts` 能直接验证判定逻辑 ——
 * 这是安全边界，不该只靠手工点两下确认。
 */
export function resolveCorsOrigin(
  requestOrigin: string | undefined,
  requestUrl: string,
  allowed: string[],
): { origin: string; credentials: boolean } | null {
  if (!requestOrigin) return null; // 同源请求 / 非浏览器客户端：无需 CORS

  // 浏览器的同源请求【也】会带 Origin（GET 带上，POST 视实现而定）。
  // 此时不该回 CORS 头：一来没必要，二来避免把自己误当成第三方。
  try {
    if (new URL(requestUrl).origin.toLowerCase() === requestOrigin.toLowerCase()) return null;
  } catch {
    /* url 解析失败则继续往下判断 */
  }

  const lower = requestOrigin.toLowerCase();

  if (allowed.includes('*')) {
    // 通配：回显来源但禁用凭据，客户端必须用 Bearer
    return { origin: requestOrigin, credentials: false };
  }

  if (allowed.includes(lower)) {
    return { origin: requestOrigin, credentials: true };
  }

  return null;
}

/**
 * 全局 CORS 中间件。
 *
 * 必须在所有 `/api/*` 路由之前注册（见 workers/app.ts）。
 */
export async function corsMiddleware(
  c: Context<AppEnv>,
  next: Next,
): Promise<Response | void> {
  const allowed = parseAllowed(c.env.ALLOWED_ORIGINS);
  const requestOrigin = c.req.header('Origin') ?? undefined;
  const resolved =
    allowed.length > 0 ? resolveCorsOrigin(requestOrigin, c.req.url, allowed) : null;

  // 未命中白名单：
  //   - 预检请求 → 直接 204 且不带 CORS 头，浏览器会判定为「跨域被拒」，
  //     这是预期行为（不放行就是不让你调）。
  //   - 普通请求 → 放行到业务逻辑。**不写 CORS 头**，浏览器自然拦下响应，
  //     但服务端仍然处理了请求 —— 对非浏览器客户端（原生 / curl）来说
  //     这正是它需要的：它们不带 Origin，白名单对它们完全无感。
  if (!resolved) {
    if (c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Method')) {
      return c.body(null, 204);
    }
    return next();
  }

  // ---- 预检请求 ----
  if (c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Method')) {
    c.header('Access-Control-Allow-Origin', resolved.origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', ALLOW_METHODS);
    c.header('Access-Control-Allow-Headers', ALLOW_HEADERS);
    c.header('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
    if (resolved.credentials) c.header('Access-Control-Allow-Credentials', 'true');
    return c.body(null, 204);
  }

  // ---- 实际请求：先跑业务，再把头条补上（错误响应同样需要 CORS 头，
  //      否则前端只能看到「网络错误」而读不到 401/403 的具体错误码） ----
  const response = await next();

  c.header('Access-Control-Allow-Origin', resolved.origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  if (resolved.credentials) c.header('Access-Control-Allow-Credentials', 'true');

  return response;
}
