import { useEffect, useLayoutEffect } from 'react';
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from 'react-router';
import type { LinksFunction, MetaFunction } from 'react-router';

import './styles.css';

export const links: LinksFunction = () => [
  { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
  // Turnstile 是唯一允许的 CDN 依赖（官方要求必须从 Cloudflare 引入）
  { rel: 'preconnect', href: 'https://challenges.cloudflare.com' },
];

export const meta: MetaFunction = () => [
  { title: '游戏语音室' },
  { name: 'description', content: '基于 Cloudflare Realtime SFU 的私人游戏语音室' },
  { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
  { name: 'color-scheme', content: 'light dark' },
];

/**
 * 首帧主题引导：在 CSS 加载完成后、首次绘制前根据系统偏好打上 .dark / .light。
 * 写成原始字符串由 <script> 同步执行，避免 React 水合前出现白/黑闪。
 */
const THEME_BOOTSTRAP = `(function(){try{var m=window.matchMedia('(prefers-color-scheme: dark)');var a=function(e){var r=document.documentElement;r.classList.toggle('dark',e.matches);r.classList.toggle('light',!e.matches);r.style.colorScheme=e.matches?'dark':'light';};a(m);m.addEventListener('change',a);}catch(e){}})();`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning：首帧主题脚本会在 React 水合前给 <html> 打上
    // .dark/.light 与 color-scheme，属性必然与 SSR 输出不同。
    // 这正是该属性设计的用途（只作用于本元素自身的属性，不影响子树）。
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-screen bg-app text-ink">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // 客户端二次校准 + 监听系统主题实时变化（服务端渲染时会漏掉首帧脚本）
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (dark: boolean) => {
      const root = document.documentElement;
      root.classList.toggle('dark', dark);
      root.classList.toggle('light', !dark);
      root.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply(media.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // 隔离第三方注入脚本（浏览器扩展的 content script 等）抛出的异常，
  // 避免它们污染控制台或干扰页面运行。我们自己的错误仍会正常上抛。
  useEffect(() => {
    const isForeign = (stack?: string) =>
      !!stack && !stack.includes('/app/') && !stack.includes('chrome-extension');

    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { stack?: string } | undefined;
      if (isForeign(reason?.stack)) {
        e.preventDefault();
        console.warn('[已忽略外部脚本的 Promise 异常]', reason);
      }
    };
    const onError = (e: ErrorEvent) => {
      // 扩展脚本的 filename 通常是 chrome-extension:// 或叫 content.js
      if (e.filename?.startsWith('chrome-extension://') || e.filename?.endsWith('content.js')) {
        e.preventDefault();
        console.warn('[已忽略外部注入脚本异常]', e.filename);
      }
    };

    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

  return <Outlet />;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  let title = '出错了';
  let message = '发生了未知错误。';

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    message =
      error.status === 404 ? '找不到这个页面。' : String(error.data ?? '请求失败。');
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <main className="app-backdrop flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold text-ink">{title}</h1>
      <p className="text-sm text-ink-2">{message}</p>
      <a
        href="/"
        className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-hover"
      >
        回到首页
      </a>
    </main>
  );
}
