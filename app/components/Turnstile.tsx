import { useEffect, useRef, useState } from 'react';

/**
 * Cloudflare Turnstile 小组件。
 *
 * 官方脚本 `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
 * 用 explicit 模式渲染，token 通过 callback 回传。
 *
 * 开发阶段用官方测试 sitekey（1x0000...AA，总是通过），无需真实域名。
 */

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement | string,
        opts: {
          sitekey: string;
          callback?: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
          size?: 'normal' | 'compact' | 'flexible';
          appearance?: 'always' | 'execute' | 'interaction-only';
          action?: string;
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (window.turnstile) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('turnstile 脚本加载失败')));
      return;
    }
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('turnstile 脚本加载失败'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface TurnstileProps {
  siteKey: string;
  /** token 变化回调；过期/失败时回传 null */
  onToken: (token: string | null) => void;
  /** 供外部触发重置（登录失败后需要换新 token） */
  resetSignal?: number;
  theme?: 'light' | 'dark' | 'auto';
}

export function Turnstile({ siteKey, onToken, resetSignal = 0, theme = 'auto' }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  // 初始渲染
  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;

    void (async () => {
      try {
        await loadScript();
        if (cancelled || !containerRef.current || !window.turnstile) return;

        // 避免重复渲染
        if (widgetIdRef.current) return;

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          callback: (token: string) => onToken(token),
          'error-callback': () => {
            setFailed(true);
            onToken(null);
          },
          'expired-callback': () => onToken(null),
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* 忽略 */
        }
        widgetIdRef.current = null;
      }
    };
    // onToken / theme 故意不进依赖：widget 只需渲染一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  // 外部重置
  useEffect(() => {
    if (resetSignal === 0 || !widgetIdRef.current || !window.turnstile) return;
    try {
      window.turnstile.reset(widgetIdRef.current);
      onToken(null);
    } catch {
      /* 忽略 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  if (!siteKey) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={containerRef} className="min-h-[65px]" />
      {failed && (
        <p className="text-xs text-amber-600">
          人机验证组件加载失败，请检查网络后刷新页面
        </p>
      )}
    </div>
  );
}
