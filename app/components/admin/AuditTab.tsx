import { useEffect, useState } from 'react';
import { Download, ListChecks, RefreshCw, Loader2 } from 'lucide-react';

import { adminApi } from '~/lib/api';
import { cn, relativeTime } from '~/lib/utils';
import { PanelSkeleton } from './OverviewTab';

interface AuditRow {
  id: string;
  uid: string | null;
  nickname: string | null;
  role: string | null;
  room_id: string | null;
  event: string;
  ip_prefix: string | null;
  country: string | null;
  city: string | null;
  user_agent: string | null;
  created_at: number;
}

const EVENT_META: Record<string, { label: string; tone: string }> = {
  login_ok: { label: '登录成功', tone: 'bg-emerald-100 text-up' },
  login_fail: { label: '登录失败', tone: 'bg-down/15 text-down' },
  join: { label: '进入房间', tone: 'bg-accent-soft text-accent-ink' },
  leave: { label: '离开房间', tone: 'bg-surface-2 text-ink-2' },
  kick: { label: '被踢出', tone: 'bg-warn/15 text-warn' },
  ban: { label: '封禁操作', tone: 'bg-down/15 text-down' },
  timeout: { label: '超时离线', tone: 'bg-surface-2 text-ink-3' },
};

const EVENT_OPTIONS = [
  { value: '', label: '全部事件' },
  { value: 'login_ok', label: '登录成功' },
  { value: 'login_fail', label: '登录失败' },
  { value: 'join', label: '进入房间' },
  { value: 'leave', label: '离开房间' },
  { value: 'kick', label: '被踢出' },
];

export function AuditTab() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [nickname, setNickname] = useState('');
  const [event, setEvent] = useState('');
  const [loading, setLoading] = useState(true);

  async function load(p = page, filters = { nickname, event }) {
    setLoading(true);
    try {
      const res = await adminApi.audit({
        page: p,
        pageSize,
        ...(filters.nickname ? { nickname: filters.nickname } : {}),
        ...(filters.event ? { event: filters.event } : {}),
      });
      setRows(res.rows as unknown as AuditRow[]);
      setTotal(res.total);
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold text-ink-2">
          <ListChecks className="h-4 w-4 text-accent" />
          会话审计
          <span className="text-xs font-normal text-ink-3">共 {total} 条</span>
        </h3>

        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPage(1);
              void load(1);
            }
          }}
          placeholder="按昵称筛选"
          className="w-36 rounded-lg border border-line px-3 py-1.5 text-xs outline-none focus:border-accent"
        />

        <select
          value={event}
          onChange={(e) => {
            setEvent(e.target.value);
            setPage(1);
            void load(1, { nickname, event: e.target.value });
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-xs outline-none focus:border-accent"
        >
          {EVENT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <button
          onClick={() => {
            setPage(1);
            void load(1);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>

        <a
          href={adminApi.auditExportUrl()}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
        >
          <Download className="h-3.5 w-3.5" />
          导出 CSV
        </a>
      </div>

      {/* 表格 */}
      {loading ? (
        <PanelSkeleton />
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line py-12 text-center text-sm text-ink-3">
          没有匹配的记录
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line-soft text-xs text-ink-3">
                <th className="px-4 py-3 font-medium">时间</th>
                <th className="px-4 py-3 font-medium">昵称</th>
                <th className="px-4 py-3 font-medium">事件</th>
                <th className="px-4 py-3 font-medium">房间</th>
                <th className="px-4 py-3 font-medium">地域</th>
                <th className="px-4 py-3 font-medium">IP 前缀</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const meta = EVENT_META[row.event] ?? {
                  label: row.event,
                  tone: 'bg-surface-2 text-ink-2',
                };
                return (
                  <tr key={row.id} className="border-b border-line-soft last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-3">
                      {relativeTime(row.created_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-ink-2">{row.nickname ?? '—'}</span>
                      {row.role === 'admin' && (
                        <span className="ml-1.5 text-[10px] text-warn">管理员</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          'inline-block rounded-md px-2 py-0.5 text-xs font-medium',
                          meta.tone,
                        )}
                      >
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-3">
                      {row.room_id ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-3">
                      {row.country ? `${row.country}${row.city ? ` · ${row.city}` : ''}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-3">
                      {row.ip_prefix ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => {
              const p = page - 1;
              setPage(p);
              void load(p);
            }}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-2 disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-xs text-ink-3">
            {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => {
              const p = page + 1;
              setPage(p);
              void load(p);
            }}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-2 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

export { Loader2 };
