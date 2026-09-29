import { createContext, RouterContextProvider } from 'react-router';

import type { Env } from '../env';

/**
 * React Router 8 的 loadContext 必须是 `RouterContextProvider` 实例。
 *
 * 这里定义一个弱类型 context key，用于在 SSR loader / action 中
 * 读取 Cloudflare 运行时（env + executionCtx）。
 *
 * 之所以用 `unknown` 作为默认值：SSR 只渲染外壳，绝大多数页面不需要
 * 访问 env；即使 React Router 的内部默认值（{@link getLoadContext}）
 * 未注入，loader 里也会拿到 `undefined` 而不会抛错。
 */
export const cloudflareContext = createContext<CloudflareLoadContext | undefined>(undefined);

/**
 * Cloudflare 运行时注入到 SSR 的上下文载荷。
 *
 * 注意：`ctx` 不用 workerd 全局的 `ExecutionContext` 类型——Hono 自定义了
 * 一个结构更窄的同名接口（缺 `tracing` / `abort`），直接标注会类型不兼容。
 * 这里只声明我们实际会用到的方法（等待后台任务）。
 */
export interface CloudflareLoadContext {
  env: Env;
  ctx: Pick<ExecutionContext<unknown>, 'waitUntil' | 'passThroughOnException'>;
}

/** 构造一个带 Cloudflare 绑定的 loadContext。 */
export function createLoadContext(
  env: Env,
  ctx: CloudflareLoadContext['ctx'],
): RouterContextProvider {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, { env, ctx });
  return provider;
}
