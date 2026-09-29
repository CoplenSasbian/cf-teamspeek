import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Activity,
  Gauge,
  ListChecks,
  Settings2,
  Shield,
  LogOut,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

import { OverviewTab, type OverviewData } from '~/components/admin/OverviewTab';
import { UsageTab } from '~/components/admin/UsageTab';
import { AuditTab } from '~/components/admin/AuditTab';
import { ManageTab } from '~/components/admin/ManageTab';
import { adminApi, authApi, setBaseUrl } from '~/lib/api';
import { loadSettings, resolveBaseUrl } from '~/lib/settings';
import { cn } from '~/lib/utils';

export function meta() {
  return [{ title: '管理后台' }];
}

type TabId = 'overview' | 'usage' | 'audit' | 'manage';

const TABS: Array<{ id: TabId; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: '实时概览', icon: Activity },
  { id: 'usage', label: '用量看板', icon: Gauge },
  { id: 'audit', label: '会话审计', icon: ListChecks },
  { id: 'manage', label: '管理操作', icon: Settings2 },
];

export default function DevPage() {
  const navigate = useNavigate();

  const [tab, setTab] = useState<TabId>('overview');
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [profile, setProfile] = useState<{ nickname: string } | null>(null);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // ---- 鉴权 ----
  useEffect(() => {
    const s = loadSettings();
    setBaseUrl(s.baseUrl || resolveBaseUrl());

    void (async () => {
      try {
        const { profile: me } = await authApi.me();
        if (me.role !== 'admin') {
          setAuthorized(false);
          setError('需要管理员权限');
          return;
        }
        setProfile(me);
        setAuthorized(true);
      } catch {
        setAuthorized(false);
        setError('请先以管理员身份登录');
      }
    })();
  }, []);

  // ---- 拉取概览 ----
  const refreshOverview = useCallback(async () => {
    try {
      const data = await adminApi.overview();
      setOverview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    if (!authorized) return;
    void refreshOverview();
    // 5 秒轮询（概览页），其它 tab 不需要实时
    if (tab !== 'overview') return;
    const timer = setInterval(() => void refreshOverview(), 5000);
    return () => clearInterval(timer);
  }, [authorized, tab, refreshOverview, tick]);

  async function logout() {
    await authApi.logout().catch(() => undefined);
    navigate('/', { replace: true });
  }

  if (authorized === null) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-down/15 text-down">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="text-lg font-semibold text-ink">无法访问后台</h1>
        <p className="text-sm text-ink-3">{error}</p>
        <button
          onClick={() => navigate('/', { replace: true })}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
        >
          返回登录
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-5 px-5 py-8">
      {/* 头部 */}
      <header className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink text-white shadow-sm">
          <Shield className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight text-ink">管理后台</h1>
          <p className="text-xs text-ink-3">
            {profile?.nickname} · 每 5 秒刷新概览
          </p>
        </div>
        <button
          onClick={() => void logout()}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-2 hover:bg-surface-2"
        >
          <LogOut className="h-3.5 w-3.5" />
          退出
        </button>
      </header>

      {/* Tab 导航 */}
      <nav className="flex gap-1 rounded-xl bg-surface-2 p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition sm:text-sm',
              tab === id
                ? 'bg-surface text-ink shadow-sm'
                : 'text-ink-3 hover:text-ink-2',
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </nav>

      {/* 内容 */}
      <div className="flex-1">
        {tab === 'overview' && <OverviewTab data={overview} />}
        {tab === 'usage' && <UsageTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'manage' && (
          <ManageTab
            rooms={overview?.rooms ?? []}
            onChanged={() => setTick((t) => t + 1)}
          />
        )}
      </div>
    </main>
  );
}
