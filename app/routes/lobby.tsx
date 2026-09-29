import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Headphones,
  Loader2,
  Shield,
  User,
  KeyRound,
  AlertTriangle,
  DoorOpen,
  Plus,
  RefreshCw,
  Check,
} from 'lucide-react';

import { Avatar, AvatarPicker } from '~/components/Avatar';
import { Turnstile } from '~/components/Turnstile';
import { authApi, roomsApi, setBaseUrl, ApiError } from '~/lib/api';
import { loadSettings, saveSettings, resolveBaseUrl } from '~/lib/settings';
import { PRESET_AVATARS } from '@shared/constants';
import { cn } from '~/lib/utils';
import type { RoomSummary } from '@shared/types';

type Tab = 'login' | 'profile';

export function meta() {
  return [{ title: '游戏语音室 · 登录' }];
}

export default function Lobby() {
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>('login');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 表单
  const [baseUrl, setBaseUrlInput] = useState('');
  const [key, setKey] = useState('');
  const [nickname, setNickname] = useState('');
  const [avatarId, setAvatarId] = useState<string | null>(null);

  // 登录后
  const [profile, setProfile] = useState<{
    uid: string;
    nickname: string;
    role: 'guest' | 'admin';
    avatarId: string | null;
    avatarUrl: string | null;
  } | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [adminPath, setAdminPath] = useState('/dev');

  // Turnstile
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  // ---- 初始化：读取本地设置 + 尝试恢复会话 ----
  useEffect(() => {
    const s = loadSettings();
    const resolved = s.baseUrl || resolveBaseUrl();
    setBaseUrlInput(resolved);
    setKey(s.key);
    setNickname(s.nickname);
    setAvatarId(s.avatarId);
    setBaseUrl(resolved);

    void (async () => {
      try {
        const cfg = await authApi.config();
        setAdminPath(cfg.adminPath || '/dev');
        setTurnstileSiteKey(cfg.turnstileSiteKey || '');
      } catch {
        /* 配置拉取失败不阻塞 */
      }

      try {
        const { profile: me } = await authApi.me();
        setProfile(me);
        setTab('profile');
        await refreshRooms();
      } catch {
        /* 未登录，留在登录页 */
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshRooms() {
    try {
      const { rooms: list } = await roomsApi.list();
      setRooms(list);
    } catch {
      setRooms([]);
    }
  }

  // ---- 登录 ----
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const url = baseUrl.trim() || resolveBaseUrl();
    if (!key.trim()) return setError('请填写 key');
    if (!nickname.trim()) return setError('请填写昵称');
    // 注意：不在这里强制要求 token。
    // 是否需要人机由服务端判定（仅管理员 key 需要），
    // 客户端只在 token 已就绪时带上；缺失时服务端会返回明确错误。

    setBusy(true);
    try {
      setBaseUrl(url);
      const res = await authApi.login({
        key: key.trim(),
        nickname: nickname.trim(),
        avatarId,
        turnstileToken,
      });
      saveSettings({ baseUrl: url, key: key.trim(), nickname: res.profile.nickname, avatarId: res.profile.avatarId });
      setProfile(res.profile);
      setTab('profile');
      await refreshRooms();
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

  // ---- 保存资料 ----
  async function handleSaveProfile(overrides?: { nickname?: string; avatarId?: string | null }) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await authApi.updateMe({
        nickname: overrides?.nickname ?? nickname,
        avatarId: overrides?.avatarId === undefined ? avatarId : overrides.avatarId,
      });
      setProfile(res.profile);
      saveSettings({ nickname: res.profile.nickname, avatarId: res.profile.avatarId });
      setNotice('资料已保存');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  // ---- 进入房间 ----
  async function enterRoom(id: string) {
    setBusy(true);
    setError(null);
    try {
      navigate(`/room/${id}`);
    } catch {
      setError('进入房间失败');
      setBusy(false);
    }
  }

  async function createRoom() {
    setBusy(true);
    setError(null);
    try {
      const { room } = await roomsApi.create({ name: `${profile?.nickname ?? '我'}的房间` });
      await refreshRooms();
      await enterRoom(room.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建房间失败');
      setBusy(false);
    }
  }

  async function handleLogout() {
    await authApi.logout().catch(() => undefined);
    setProfile(null);
    setTab('login');
    setRooms([]);
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
        {/* ---------------- 品牌头 ---------------- */}
        <header className="flex flex-col items-center gap-3 pb-1 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-[1.25rem] bg-accent text-white shadow-[var(--c-shadow)]">
            <Headphones className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">游戏语音室</h1>
            <p className="mt-0.5 text-xs text-ink-3">基于 Cloudflare Realtime SFU</p>
          </div>

          {profile && (
            <div className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-2">
              <Avatar
                nickname={profile.nickname}
                avatarId={profile.avatarId}
                avatarUrl={profile.avatarUrl}
                size={20}
              />
              <span className="font-medium text-ink">{profile.nickname}</span>
              {profile.role === 'admin' && (
                <span className="inline-flex items-center gap-0.5 text-warn">
                  <Shield className="h-3 w-3" />
                  管理员
                </span>
              )}
            </div>
          )}
        </header>

        {/* ---------------- 提示 ---------------- */}
        {error && (
          <Notice tone="error">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </Notice>
        )}
        {notice && (
          <Notice tone="success">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </Notice>
        )}

        {/* ---------------- Tab 切换 ---------------- */}
        {profile && (
          <div className="mx-auto flex gap-1 rounded-full border border-line bg-surface p-1">
            {(
              [
                { id: 'profile' as Tab, label: '房间', icon: DoorOpen },
                { id: 'login' as Tab, label: '账号', icon: User },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-5 py-2 text-sm font-medium transition',
                  tab === id
                    ? 'bg-accent text-white shadow-sm'
                    : 'text-ink-2 hover:bg-surface-2',
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ---------- 登录表单 ---------- */}
        {tab === 'login' && (
          <form
            onSubmit={handleLogin}
            className="rise-in flex flex-col gap-5 rounded-3xl border border-line bg-surface p-6 shadow-[var(--c-shadow)]"
          >
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
                <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />                <input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  type="password"
                  placeholder="粘贴你的 key"
                  className={cn(inputClass, 'pl-10')}
                  autoComplete="off"
                />
              </div>
            </Field>

            <Field label="昵称" hint="全局唯一，2–16 字符">
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="起一个名字"
                maxLength={16}
                className={inputClass}
              />
            </Field>

            <Field label="头像" hint="可稍后在账号页更换">
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
        )}

        {/* ---------- 已登录：房间列表 + 资料 ---------- */}
        {tab === 'profile' && profile && (
          <>
            {/* 资料卡 */}
            <section className="rise-in rounded-3xl border border-line bg-surface p-5 shadow-[var(--c-shadow)]">
              <div className="flex items-center gap-4">
                <Avatar
                  nickname={profile.nickname}
                  avatarId={profile.avatarId}
                  avatarUrl={profile.avatarUrl}
                  size={56}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold text-ink">{profile.nickname}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-ink-3">
                    {profile.uid.slice(0, 8)}…
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {profile.role === 'admin' && (
                    <a
                      href={adminPath}
                      className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:bg-surface-2"
                    >
                      后台
                    </a>
                  )}
                  <button
                    onClick={handleLogout}
                    className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:bg-surface-2"
                  >
                    退出
                  </button>
                </div>
              </div>

              <div className="mt-4 border-t border-line-soft pt-4">
                <p className="mb-2.5 text-xs font-medium text-ink-3">更换头像</p>
                <AvatarPicker
                  value={avatarId}
                  onChange={(id) => {
                    setAvatarId(id);
                    void handleSaveProfile({ avatarId: id });
                  }}
                  presets={PRESET_AVATARS}
                  size={44}
                />
              </div>
            </section>

            {/* 房间列表 */}
            <section className="rise-in flex flex-col gap-3">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-ink-2">可用房间</h2>
                <div className="flex gap-2">
                  <button
                    onClick={() => void refreshRooms()}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-ink-2 transition hover:bg-surface-2"
                    title="刷新"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => void createRoom()}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    新建房间
                  </button>
                </div>
              </div>

              {rooms.length === 0 ? (
                <EmptyRooms onEnter={() => void enterRoom('home')} disabled={busy} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {rooms.map((room) => {
                    const live = room.memberCount > 0;
                    return (
                      <li key={room.id}>
                        <button
                          onClick={() => void enterRoom(room.id)}
                          disabled={busy}
                          className="group flex w-full items-center gap-3.5 rounded-2xl border border-line bg-surface px-4 py-3.5 text-left transition hover:border-accent/40 hover:bg-accent-soft/40 disabled:opacity-50"
                        >
                          <div
                            className={cn(
                              'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl transition',
                              live
                                ? 'bg-up/12 text-up'
                                : 'bg-surface-2 text-ink-3',
                            )}
                          >
                            <DoorOpen className="h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink">{room.name}</p>
                            <p className="text-xs text-ink-3">
                              {room.memberCount} / {room.maxMembers} 人
                            </p>
                          </div>
                          {live && (
                            <span className="flex items-center gap-1.5 rounded-full bg-up/12 px-2 py-1 text-[11px] font-medium text-up">
                              <span className="h-1.5 w-1.5 rounded-full bg-up" />
                              活跃
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

// ------------------------------------------------------------

const inputClass =
  'w-full rounded-2xl border border-line bg-surface-2/60 px-4 py-3 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/12';

function Notice({
  tone,
  children,
}: {
  tone: 'error' | 'success';
  children: React.ReactNode;
}) {
  const styles =
    tone === 'error'
      ? 'border-down/30 bg-down/10 text-down'
      : 'border-up/30 bg-up/10 text-up';
  return (
    <div className={cn('flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm', styles)}>
      {children}
    </div>
  );
}

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

function EmptyRooms({ onEnter, disabled }: { onEnter: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-line bg-surface/50 px-6 py-10 text-center">
      <Headphones className="h-8 w-8 text-ink-3" />
      <p className="text-sm text-ink-3">还没有房间</p>
      <button
        onClick={onEnter}
        disabled={disabled}
        className="rounded-full bg-accent px-4 py-2 text-xs font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
      >
        进入默认房间
      </button>
    </div>
  );
}
