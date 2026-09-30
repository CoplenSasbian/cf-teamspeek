import { Hono } from 'hono';
import { createRequestHandler } from 'react-router';

import authRoutes from './routes/auth';
import roomRoutes from './routes/rooms';
import rtcRoutes from './routes/rtc';
import adminRoutes from './routes/admin';
import presenceRoutes from './routes/presence';
import type { AppEnv, Env } from './env';
import { flushAuditToD1, flushUsageToD1 } from './lib/db';
import { createLoadContext } from './lib/context';
import { corsMiddleware } from './middleware/cors';


// DO 类必须从 Worker 入口导出，wrangler 才能绑定
export { RoomDO } from './durable/RoomDO';
export { RegistryDO } from './durable/RegistryDO';
export { AdminDO } from './durable/AdminDO';
export { PresenceDO } from './durable/PresenceDO';

const app = new Hono<AppEnv>();

// ------------------------------------------------------------
//  CORS —— 必须最先注册
//
//  作用：让「另一个域名的网页客户端」也能调这套 API。
//  白名单为空（默认）时行为与以前完全一致：只服务同源页面；
//  原生客户端（不受 CORS 约束）也不受影响。
//
//  放在最前面的原因：浏览器的预检（OPTIONS）请求不带凭据，
//  如果让它走到鉴权中间件就会被 401 掉，前端只会看到
//  「CORS 预检失败」而看不到真正原因。
// ------------------------------------------------------------
app.use('*', corsMiddleware);

// ------------------------------------------------------------
//  API 路由
// ------------------------------------------------------------
app.route('/api/auth', authRoutes);
app.route('/api/rooms', roomRoutes);
app.route('/api/rtc', rtcRoutes);
app.route('/api/presence', presenceRoutes);

// 管理员后台 API 挂在可配置路径下
app.route('/api/admin', adminRoutes);

app.get('/api/health', (c) =>
  c.json({ ok: true, data: { status: 'healthy', time: Date.now() } }),
);

// ------------------------------------------------------------
//  SSR（React Router）
//  注意：SSR 只渲染外壳，重逻辑全在客户端，控制在 10ms CPU 内
// ------------------------------------------------------------
// React Router 8 的 loadContext 使用 RouterContextProvider 实例。
// @cloudflare/vite-plugin 不会自动注入 `cloudflare` 上下文，
// 因此这里显式构造一个 RouterContextProvider 并放入 env / executionCtx。
const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

app.all('*', (c) => requestHandler(c.req.raw, createLoadContext(c.env, c.executionCtx)));

// ------------------------------------------------------------
//  定时任务：把 DO 缓冲批量落 D1
//  免费版 Workers 支持 cron triggers（1 分钟粒度，1 天多次调用）
//  选用 10 分钟一次，控制 D1 写入行数
// ------------------------------------------------------------
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          await flushUsageToD1(env);
          await flushAuditToD1(env, 2000);
        } catch (err) {
          console.error('[scheduled] flush failed', err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
