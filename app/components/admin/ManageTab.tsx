import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Settings2,
  UserX,
  Trash2,
  ShieldBan,
  KeyRound,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Users,
  DoorOpen,
  Pencil,
  Search,
} from 'lucide-react';

import { adminApi } from '~/lib/api';
import { cn, relativeTime } from '~/lib/utils';
import { DataTable, TableSearch, type Column } from './DataTable';
import type { RoomMember } from '@shared/types';
import { PanelSkeleton } from './OverviewTab';

interface RoomInfo {
  id: string;
  name: string;
  memberCount: number;
  maxMembers: number;
  members: RoomMember[];
  trackCount: number;
  createdAt: number;
}

interface Ban {
  id: string;
  kind: string;
  value: string;
  reason: string | null;
  createdAt: number;
  expiresAt: number | null;
}

interface UserInfo {
  uid: string;
  nickname: string;
  role: string;
  avatarId: string | null;
  avatarUrl: string | null;
}

type Section = 'rooms' | 'users' | 'bans';

/**
 * 管理操作 —— 房间 / 用户 / 封禁 三个分区。
 *
 * 房间和用户用 DataTable（服务端数据 + 客户端分页/筛选），
 * 数据量最大的两块都支持关键字搜索与每页条数调节；
 * 封禁名单通常很短，保留紧凑卡片式。
 */
export function ManageTab({
  rooms,
  onChanged,
}: {
  rooms: RoomInfo[];
  onChanged: () => void;
}) {
  const [section, setSection] = useState<Section>('rooms');
  const [bans, setBans] = useState<Ban[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [banKind, setBanKind] = useState<'ip' | 'nickname'>('nickname');
  const [banValue, setBanValue] = useState('');
  const [banReason, setBanReason] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(true);

  // ---- 客户端分页 / 筛选状态 ----
  const [roomPage, setRoomPage] = useState(1);
  const [roomPageSize, setRoomPageSize] = useState(10);
  const [roomQuery, setRoomQuery] = useState('');
  const [roomQueryApplied, setRoomQueryApplied] = useState('');

  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = useState(10);
  const [userQuery, setUserQuery] = useState('');
  const [userQueryApplied, setUserQueryApplied] = useState('');

  const reload = useCallback(async () => {
    setLoadingUsers(true);
    const [b, u] = await Promise.all([
      adminApi.bans().catch(() => ({ bans: [] })),
      adminApi.users().catch(() => ({ users: [] })),
    ]);
    setBans(b.bans);
    setUsers(u.users);
    setLoadingUsers(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = useCallback(
    async (key: string, fn: () => Promise<unknown>, msg: string) => {
      setBusy(key);
      setNotice(null);
      try {
        await fn();
        setNotice(msg);
        await reload();
        onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : '操作失败');
      } finally {
        setBusy(null);
      }
    },
    [reload, onChanged],
  );

  // ---- 筛选 + 分页后的数据 ----
  const filteredRooms = useMemo(() => {
    const q = roomQueryApplied.trim().toLowerCase();
    const list = q
      ? rooms.filter(
          (r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
        )
      : rooms;
    return list;
  }, [rooms, roomQueryApplied]);

  const pagedRooms = useMemo(() => {
    const start = (roomPage - 1) * roomPageSize;
    return filteredRooms.slice(start, start + roomPageSize);
  }, [filteredRooms, roomPage, roomPageSize]);

  const filteredUsers = useMemo(() => {
    const q = userQueryApplied.trim().toLowerCase();
    const list = q
      ? users.filter((u) => u.nickname.toLowerCase().includes(q) || u.uid.toLowerCase().includes(q))
      : users;
    return list;
  }, [users, userQueryApplied]);

  const pagedUsers = useMemo(() => {
    const start = (userPage - 1) * userPageSize;
    return filteredUsers.slice(start, start + userPageSize);
  }, [filteredUsers, userPage, userPageSize]);

  // ---- 房间表列定义 ----
  const roomColumns: Column<RoomInfo>[] = [
    {
      key: 'name',
      header: '房间',
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{r.name}</p>
          <p className="font-mono text-[11px] text-ink-3">{r.id}</p>
        </div>
      ),
      className: 'min-w-[10rem]',
    },
    {
      key: 'members',
      header: '人数',
      render: (r) => (
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            r.memberCount > 0 ? 'text-up' : 'text-ink-3',
          )}
        >
          {r.memberCount}/{r.maxMembers}
        </span>
      ),
    },
    {
      key: 'tracks',
      header: '轨道',
      render: (r) => <span className="font-mono text-xs tabular-nums text-ink-3">{r.trackCount}</span>,
    },
    {
      key: 'membersList',
      header: '当前成员',
      render: (r) =>
        r.members.length === 0 ? (
          <span className="text-xs text-ink-3">—</span>
        ) : (
          <span className="text-xs text-ink-2">
            {r.members.slice(0, 3).map((m) => m.nickname).join('、')}
            {r.members.length > 3 ? ` 等 ${r.members.length} 人` : ''}
          </span>
        ),
      className: 'min-w-[8rem]',
    },
    {
      key: 'created',
      header: '创建时间',
      render: (r) => <span className="text-xs text-ink-3">{relativeTime(r.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      render: (r) => (
        <div className="flex items-center gap-1">
          <IconAction
            busy={busy === `rename-${r.id}`}
            title="改名"
            onClick={() =>
              void act(`rename-${r.id}`, async () => {
                const next = window.prompt('新的房间名', r.name);
                if (!next?.trim()) return;
                await adminApi.renameRoom(r.id, next.trim());
              }, '房间名已更新')
            }
          >
            <Pencil className="h-3.5 w-3.5" />
          </IconAction>
          <IconAction
            busy={busy === `limit-${r.id}`}
            title="人数上限"
            onClick={() =>
              void act(`limit-${r.id}`, async () => {
                const next = window.prompt('新的房间人数上限', String(r.maxMembers));
                if (!next) return;
                await adminApi.setLimit(r.id, Number(next));
              }, '人数上限已更新')
            }
          >
            <Settings2 className="h-3.5 w-3.5" />
          </IconAction>
          <IconAction
            busy={busy === `rotate-${r.id}`}
            title="轮换密钥"
            onClick={() => void act(`rotate-${r.id}`, () => adminApi.rotateKey(r.id), '房间密钥已轮换')}
          >
            <KeyRound className="h-3.5 w-3.5" />
          </IconAction>
          <IconAction
            busy={busy === `delete-${r.id}`}
            title="删除房间"
            danger
            onClick={() =>
              void act(`delete-${r.id}`, async () => {
                const live = r.memberCount > 0;
                const ok = window.confirm(
                  live
                    ? `确定删除房间「${r.name}」吗？\n\n里面还有 ${r.memberCount} 人，会被立刻断开。此操作不可恢复。`
                    : `确定删除房间「${r.name}」吗？此操作不可恢复。`,
                );
                if (!ok) return;
                await adminApi.deleteRoom(r.id);
              }, '房间已删除')
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconAction>
        </div>
      ),
    },
  ];

  // ---- 用户表列定义 ----
  const userColumns: Column<UserInfo>[] = [
    {
      key: 'nickname',
      header: '昵称',
      render: (u) => (
        <span className="flex items-center gap-1.5">
          <span className="font-medium text-ink">{u.nickname}</span>
          {u.role === 'admin' && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn">
              管理员
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'uid',
      header: 'UID',
      render: (u) => <span className="font-mono text-xs text-ink-3">{u.uid.slice(0, 8)}…</span>,
      className: 'min-w-[7rem]',
    },
    {
      key: 'actions',
      header: '操作',
      render: (u) => (
        <IconAction
          busy={busy === `release-${u.uid}`}
          title="释放昵称（该用户将无法再以此昵称登录）"
          danger
          onClick={() =>
            void act(`release-${u.uid}`, () => adminApi.releaseNickname(u.nickname), `已释放昵称 ${u.nickname}`)
          }
        >
          <UserX className="h-3.5 w-3.5" />
        </IconAction>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-accent" />
          {notice}
        </div>
      )}

      {/* 分区切换 */}
      <div className="flex gap-1 rounded-xl bg-surface-2 p-1">
        {(
          [
            { id: 'rooms', label: '房间', icon: DoorOpen, count: rooms.length },
            { id: 'users', label: '用户', icon: Users, count: users.length },
            { id: 'bans', label: '封禁', icon: ShieldBan, count: bans.length },
          ] as const
        ).map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition sm:text-sm',
              section === id ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
            <span className="font-mono text-[10px] tabular-nums text-ink-3">{count}</span>
          </button>
        ))}
      </div>

      {/* 房间管理 */}
      {section === 'rooms' && (
        <DataTable
          columns={roomColumns}
          rows={pagedRooms}
          rowKey={(r) => r.id}
          emptyText="当前没有房间"
          pagination={{
            page: roomPage,
            pageSize: roomPageSize,
            total: filteredRooms.length,
            onPageChange: setRoomPage,
            onPageSizeChange: (s) => {
              setRoomPageSize(s);
              setRoomPage(1);
            },
          }}
          toolbar={
            <>
              <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold text-ink-2">
                <DoorOpen className="h-4 w-4 text-accent" />
                房间管理
              </h3>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
                <input
                  value={roomQuery}
                  onChange={(e) => {
                    setRoomQuery(e.target.value);
                    setRoomPage(1);
                    setRoomQueryApplied(e.target.value);
                  }}
                  placeholder="搜索房间名 / ID"
                  className="w-44 rounded-lg border border-line bg-surface py-1.5 pl-8 pr-3 text-xs outline-none transition focus:border-accent"
                />
              </div>
              <button
                onClick={() => void onChanged()}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                刷新
              </button>
            </>
          }
        />
      )}

      {/* 用户管理 */}
      {section === 'users' && (
        <DataTable
          columns={userColumns}
          rows={pagedUsers}
          rowKey={(u) => u.uid}
          loading={loadingUsers}
          emptyText="没有注册用户"
          pagination={{
            page: userPage,
            pageSize: userPageSize,
            total: filteredUsers.length,
            onPageChange: setUserPage,
            onPageSizeChange: (s) => {
              setUserPageSize(s);
              setUserPage(1);
            },
          }}
          toolbar={
            <>
              <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold text-ink-2">
                <Users className="h-4 w-4 text-accent" />
                已注册用户
              </h3>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
                <input
                  value={userQuery}
                  onChange={(e) => {
                    setUserQuery(e.target.value);
                    setUserPage(1);
                    setUserQueryApplied(e.target.value);
                  }}
                  placeholder="搜索昵称 / UID"
                  className="w-44 rounded-lg border border-line bg-surface py-1.5 pl-8 pr-3 text-xs outline-none transition focus:border-accent"
                />
              </div>
              <button
                onClick={() => void reload()}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                刷新
              </button>
            </>
          }
        />
      )}

      {/* 封禁名单 */}
      {section === 'bans' && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <select
              value={banKind}
              onChange={(e) => setBanKind(e.target.value as 'ip' | 'nickname')}
              className="rounded-lg border border-line px-3 py-1.5 text-xs outline-none focus:border-accent"
            >
              <option value="nickname">昵称</option>
              <option value="ip">IP</option>
            </select>
            <input
              value={banValue}
              onChange={(e) => setBanValue(e.target.value)}
              placeholder={banKind === 'ip' ? 'IP 或 IP 前缀' : '要封禁的昵称'}
              className="w-40 rounded-lg border border-line px-3 py-1.5 text-xs outline-none focus:border-accent"
            />
            <input
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              placeholder="原因（可选）"
              className="w-36 rounded-lg border border-line px-3 py-1.5 text-xs outline-none focus:border-accent"
            />
            <button
              onClick={() =>
                void act('add-ban', async () => {
                  if (!banValue.trim()) throw new Error('请填写封禁值');
                  await adminApi.addBan({
                    kind: banKind,
                    value: banValue.trim(),
                    reason: banReason.trim() || undefined,
                  });
                  setBanValue('');
                  setBanReason('');
                }, '已添加封禁')
              }
              disabled={busy !== null}
              className="rounded-lg bg-down px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              添加封禁
            </button>
          </div>

          {bans.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line py-12 text-center text-sm text-ink-3">
              封禁名单为空
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-line-soft rounded-2xl border border-line bg-surface">
              {bans.map((ban) => (
                <li key={ban.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className={cn(
                      'rounded-md px-2 py-0.5 text-xs font-medium',
                      ban.kind === 'ip' ? 'bg-warn/15 text-warn' : 'bg-down/15 text-down',
                    )}
                  >
                    {ban.kind === 'ip' ? 'IP' : '昵称'}
                  </span>
                  <span className="font-mono text-sm text-ink-2">{ban.value}</span>
                  {ban.reason && <span className="truncate text-xs text-ink-3">{ban.reason}</span>}
                  <span className="ml-auto shrink-0 text-xs text-ink-3">
                    {relativeTime(ban.createdAt)}
                    {ban.expiresAt ? ' · 限时' : ' · 永久'}
                  </span>
                  <button
                    onClick={() => void act(`unban-${ban.id}`, () => adminApi.removeBan(ban.id), '已解除')}
                    disabled={busy !== null}
                    className="shrink-0 text-xs text-ink-3 transition hover:text-down disabled:opacity-50"
                  >
                    解除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 危险操作 */}
      <section className="rounded-2xl border border-warn/30 bg-warn/10/60 p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          维护操作
        </h3>
        <button
          onClick={() => void act('flush', () => adminApi.flush(), '已把缓冲落库到 D1')}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {busy === 'flush' && <Loader2 className="h-3 w-3 animate-spin" />}
          立即落库（审计 + 用量）
        </button>
        <p className="mt-2 text-xs text-warn">
          把 DO 内存中的缓冲立刻写入 D1，并清理超过保留期的审计记录。
        </p>
      </section>
    </div>
  );
}

/** 表格行内的小图标按钮 */
function IconAction({
  children,
  title,
  onClick,
  busy,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  busy: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-lg transition disabled:opacity-50',
        danger
          ? 'text-ink-3 hover:bg-down/12 hover:text-down'
          : 'text-ink-3 hover:bg-surface-2 hover:text-ink',
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );
}

export { TableSearch };
