import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertTriangle,
  Headphones,
  KeyRound,
  Loader2,
  UserPlus,
} from 'lucide-react';

import { AvatarPicker } from '~/components/Avatar';
import { Turnstile } from '~/components/Turnstile';
import { authApi, setBaseUrl, ApiError } from '~/lib/api';
import {
  loadSettings,
  readInviteParams,
  resolveBaseUrl,
  saveSettings,
} from '~/lib/settings';
import { PRESET_AVATARS } from '@shared/constants';
import { cn } from '~/lib/utils';

export function meta() {
  return [{ title: '游戏语音室 · 登录' }];
}

export default function Login() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [baseUrl, setBaseUrlInput] = useState('');
  const [key, setKey] = useState('');
  const [nickname, setNickname] = useState('');
  const [avatarId, setAvatarId] = useState<string | null>(null);

  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
  /** 本次登录来自邀请链接（顶部显示提示） */
  const [fromInvite, setFromInvite] = useState(false);

  // 已登录直接进应用；否则读取本地设置预填表单。
  // 若 URL 带邀请参数（?key=...&server=...），邀请参数优先于本地设置。
  useEffect(() => {
    const s = loadSettings();
    const invited = readInviteParams();
    const resolved = invited?.server || s.baseUrl || resolveBaseUrl();

    setBaseUrlInput(resolved);
    // 邀请链接带 key 时用它；否则用本地记住的 key
    setKey(invited?.key || s.key);
    setNickname(s.nickname);
    setAvatarId(s.avatarId);
    setBaseUrl(resolved);
    if (invited) setFromInvite(true);

    void (async () => {
      try {
        const cfg = await authApi.config();
        setTurnstileSiteKey(cfg.turnstileSiteKey || '');
      } catch {
        /* 配置拉取失败不阻塞登录 */
      }
      // 被邀请但已登录同一个人：直接进应用（不覆盖会话）
      try {
        await authApi.me();
        if (!invited) {
          navigate('/', { replace: true });
          return;
        }
      } catch {
        /* 未登录，继续填表 */
      }
      setLoading(false);
    })();
  }, [navigate]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const url = baseUrl.trim() || resolveBaseUrl();
    if (!key.trim()) return setError('请填写 key');
    if (!nickname.trim()) return setError('请填写昵称');

    setBusy(true);
    try {
      setBaseUrl(url);
      const res = await authApi.login({
        key: key.trim(),
        nickname: nickname.trim(),
        avatarId,
        turnstileToken,
      });
      saveSettings({
        baseUrl: url,
        key: key.trim(),
        nickname: res.profile.nickname,
        avatarId: res.profile.avatarId,
      });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TURNSTILE_FAILED') {
        setError(`${err.message}（请完成下方人机验证后重试）`);
      } else {
        setError(err instanceof ApiError ? err.message : '登录失败，请检查地址与 key');
      }
      // 失败后 Turnstile token 已被消费，必须重置换新的
      setTurnstileToken(null);
      setTurnstileReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="app-backdrop flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </main>
    );
  }

  return (
    <main className="app-backdrop safe-top safe-bottom flex min-h-screen flex-col items-center px-4 py-8 sm:py-12">
      <div className="flex w-full max-w-lg flex-1 flex-col gap-5">
        <header className="flex flex-col items-center gap-3 pb-1 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-[1.25rem] bg-accent text-white shadow-[var(--c-shadow)]">
            <Headphones className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">游戏语音室</h1>
            <p className="mt-0.5 text-xs text-ink-3">基于 Cloudflare Realtime SFU</p>
          </div>
        </header>

        {fromInvite && (
          <div className="flex items-start gap-2.5 rounded-2xl border border-up/30 bg-up/10 px-4 py-3">
            <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-up" />
            <span className="text-sm text-ink-2">
              你被邀请加入这台服务器，
              <b className="text-ink">已自动填好访问 key</b>
              ——取个昵称、选个头像就能进。
            </span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-2xl border border-down/30 bg-down/10 px-4 py-3 text-sm text-down">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form
          onSubmit={handleLogin}
          className="rise-in flex flex-col gap-5 rounded-3xl border border-line bg-surface p-6 shadow-[var(--c-shadow)]"
        >
          {/* 邀请链接进来时：地址与 key 都已知，收起来减少干扰 */}
          {fromInvite ? (
            <div className="flex items-center gap-2.5 rounded-2xl border border-line bg-surface-2/40 px-3.5 py-2.5">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-up" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
                服务器 <span className="text-ink-2">{baseUrl.replace(/^https?:\/\//, '')}</span>
                {' · '}访问 key 已自动填入
              </span>
              <button
                type="button"
                onClick={() => setFromInvite(false)}
                className="shrink-0 text-[11px] text-ink-3 underline decoration-dotted transition hover:text-ink"
              >
                手动填写
              </button>
            </div>
          ) : (
            <>
              <Field label="服务器地址" hint="浏览器打开时自动填入当前地址">
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder="https://your-worker.workers.dev"
                  className={inputClass}
                  spellCheck={false}
                />
              </Field>

              <Field label="访问 Key" hint="由管理员发放；访客用 guest key">
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
                  <input
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    type="password"
                    placeholder="粘贴你的 key"
                    className={cn(inputClass, 'pl-10')}
                    autoComplete="off"
                  />
                </div>
              </Field>
            </>
          )}

          <Field label="昵称" hint="全局唯一，2–16 字符">
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="起一个名字"
              maxLength={16}
              autoFocus={fromInvite}
              className={inputClass}
            />
          </Field>

          <Field label="头像" hint="可稍后在应用内更换">
            <AvatarPicker value={avatarId} onChange={setAvatarId} presets={PRESET_AVATARS} />
          </Field>

          {turnstileSiteKey && (
            <Field label="人机验证" hint="使用管理员 key 时必填">
              <Turnstile
                siteKey={turnstileSiteKey}
                onToken={setTurnstileToken}
                resetSignal={turnstileReset}
              />
            </Field>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 flex items-center justify-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            进入
          </button>
        </form>
      </div>
    </main>
  );
}

// ------------------------------------------------------------

const inputClass =
  'w-full rounded-2xl border border-line bg-surface-2/60 px-4 py-3 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/12';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
