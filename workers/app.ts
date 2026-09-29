import { Hono } from 'hono';
import { createRequestHandler } from 'react-router';

import authRoutes from './routes/auth';
import roomRoutes from './routes/rooms';
import rtcRoutes from './routes/rtc';
import adminRoutes from './routes/admin';
import type { AppEnv, Env } from './env';
import { flushAuditToD1, flushUsageToD1 } from './lib/db';
import { createLoadContext } from './lib/context';


// DO 类必须从 Worker 入口导出，wrangler 才能绑定
export { RoomDO } from './durable/RoomDO';
export { RegistryDO } from './durable/RegistryDO';
export { AdminDO } from './durable/AdminDO';

const app = new Hono<AppEnv>();

// ------------------------------------------------------------
//  API 路由
// ------------------------------------------------------------
app.route('/api/auth', authRoutes);
app.route('/api/rooms', roomRoutes);
app.route('/api/rtc', rtcRoutes);

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
