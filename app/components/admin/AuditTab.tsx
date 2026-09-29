import { useCallback, useEffect, useState } from 'react';
import { Download, ListChecks, RefreshCw } from 'lucide-react';

import { adminApi } from '~/lib/api';
import { cn, relativeTime } from '~/lib/utils';
import { DataTable, TableSearch, type Column } from './DataTable';

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

/**
 * 会话审计 —— 服务端分页（D1 `LIMIT/OFFSET`），支持昵称/事件筛选。
 */
export function AuditTab() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [nickname, setNickname] = useState('');
  const [event, setEvent] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (p: number, size: number, filters: { nickname: string; event: string }) => {
      setLoading(true);
      try {
        const res = await adminApi.audit({
          page: p,
          pageSize: size,
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
    },
    [],
  );

  useEffect(() => {
    void load(page, pageSize, { nickname, event });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, load]);

  const columns: Column<AuditRow>[] = [
    {
      key: 'time',
      header: '时间',
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-ink-3" title={new Date(row.created_at).toLocaleString()}>
          {relativeTime(row.created_at)}
        </span>
      ),
    },
    {
      key: 'nickname',
      header: '昵称',
      render: (row) => (
        <span className="text-ink-2">
          {row.nickname ?? '—'}
          {row.role === 'admin' && <span className="ml-1.5 text-[10px] text-warn">管理员</span>}
        </span>
      ),
    },
    {
      key: 'event',
      header: '事件',
      render: (row) => {
        const meta = EVENT_META[row.event] ?? { label: row.event, tone: 'bg-surface-2 text-ink-2' };
        return (
          <span className={cn('inline-block rounded-md px-2 py-0.5 text-xs font-medium', meta.tone)}>
            {meta.label}
          </span>
        );
      },
    },
    {
      key: 'room',
      header: '房间',
      render: (row) => <span className="font-mono text-xs text-ink-3">{row.room_id ?? '—'}</span>,
    },
    {
      key: 'geo',
      header: '地域',
      render: (row) => (
        <span className="text-xs text-ink-3">
          {row.country ? `${row.country}${row.city ? ` · ${row.city}` : ''}` : '—'}
        </span>
      ),
    },
    {
      key: 'ip',
      header: 'IP 前缀',
      render: (row) => <span className="font-mono text-xs text-ink-3">{row.ip_prefix ?? '—'}</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      loading={loading}
      emptyText="没有匹配的记录"
      pagination={{
        page,
        pageSize,
        total,
        onPageChange: setPage,
        onPageSizeChange: (s) => {
          setPageSize(s);
          setPage(1);
        },
      }}
      toolbar={
        <>
          <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold text-ink-2">
            <ListChecks className="h-4 w-4 text-accent" />
            会话审计
          </h3>

          <TableSearch
            value={nickname}
            onChange={(v) => {
              setNickname(v);
              if (v === '') {
                setPage(1);
                void load(1, pageSize, { nickname: '', event });
              }
            }}
            onSearch={() => {
              setPage(1);
              void load(1, pageSize, { nickname, event });
            }}
            placeholder="按昵称筛选（回车）"
            className="w-44"
          />

          <select
            value={event}
            onChange={(e) => {
              setEvent(e.target.value);
              setPage(1);
              void load(1, pageSize, { nickname, event: e.target.value });
            }}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs outline-none focus:border-accent"
          >
            {EVENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <button
            onClick={() => void load(page, pageSize, { nickname, event })}
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
        </>
      }
    />
  );
}
