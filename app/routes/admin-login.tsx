import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, KeyRound, Loader2, Shield } from 'lucide-react';

import { adminApi, adminAuthApi, setAdminBaseUrl } from '~/lib/admin-api';
import { resolveBaseUrl } from '~/lib/settings';
import { cn } from '~/lib/utils';

export function meta() {
  return [{ title: '管理后台 · 登录' }];
}

/**
 * 管理后台独立登录页。
 *
 * 与客户端登录完全隔离：不同的端点、不同的 key、不同的 JWT secret、
 * 不同的 cookie。这里不注册昵称、不挑头像 —— 后台只有一个凭据：ADMIN_KEY。
 */
export default function AdminLogin() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');

  useEffect(() => {
    setAdminBaseUrl(resolveBaseUrl());

    void (async () => {
      try {
        await adminAuthApi.me();
        navigate('/dev', { replace: true }); // 已登录直接进后台
      } catch {
        setLoading(false);
      }
    })();
  }, [navigate]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!key.trim()) return setError('请填写管理 key');

    setBusy(true);
    try {
      const res = await adminAuthApi.login(key.trim());
      window.sessionStorage.setItem('cf-teamspeed.adminToken', res.token);
      navigate('/dev', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-2/40">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-2/40 px-4 py-10">
      <form
        onSubmit={handleLogin}
        className="rise-in flex w-full max-w-sm flex-col gap-5 rounded-3xl border border-line bg-surface p-6 shadow-[var(--c-shadow-lg)]"
      >
        <header className="flex flex-col items-center gap-2.5 pb-1 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink text-white">
            <Shield className="h-5.5 w-5.5" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-ink">管理后台</h1>
            <p className="mt-0.5 text-[11px] text-ink-3">独立会话 · 与客户端登录互不相通</p>
          </div>
        </header>

        {error && (
          <div className="flex items-start gap-2 rounded-2xl border border-down/30 bg-down/10 px-4 py-3 text-sm text-down">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <label className="flex flex-col gap-2">
          <span className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-ink-2">管理 Key</span>
            <span className="text-[11px] text-ink-3">后台专用，与访客 key 不同</span>
          </span>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              type="password"
              placeholder="粘贴管理 key"
              autoComplete="off"
              autoFocus
              className={cn(
                'w-full rounded-2xl border border-line bg-surface-2/60 py-3 pl-10 pr-4 text-sm text-ink outline-none transition',
                'placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/12',
              )}
            />
          </div>
        </label>

        <button
          type="submit"
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          进入后台
        </button>

        <p className="text-center text-[11px] leading-relaxed text-ink-3">
          会话有效期 4 小时 · 连续失败 5 次将锁定 15 分钟
        </p>

        {/* 误入时的退路（客户端里已不提供后台入口，这里是唯一的返回路径） */}
        <a
          href="/"
          className="text-center text-[11px] text-ink-3 underline decoration-dotted transition hover:text-ink"
        >
          返回语音室
        </a>
      </form>
    </main>
  );
}

// 避免未使用告警：adminApi 在登录页未直接使用，但保持与其它 tab 同源导入
void adminApi;
