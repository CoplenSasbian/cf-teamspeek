import { useEffect, useState } from 'react';
import {
  Settings2,
  UserX,
  Trash2,
  ShieldBan,
  KeyRound,
  RefreshCw,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

import { adminApi } from '~/lib/api';
import { cn, relativeTime } from '~/lib/utils';
import type { RoomMember } from '@shared/types';
import { PanelSkeleton } from './OverviewTab';

interface RoomInfo {
  id: string;
  name: string;
  memberCount: number;
  maxMembers: number;
  members: RoomMember[];
}

interface Ban {
  id: string;
  kind: string;
  value: string;
  reason: string | null;
  createdAt: number;
  expiresAt: number | null;
}

export function ManageTab({
  rooms,
  onChanged,
}: {
  rooms: RoomInfo[];
  onChanged: () => void;
}) {
  const [bans, setBans] = useState<Ban[]>([]);
  const [users, setUsers] = useState<Array<{ uid: string; nickname: string; role: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [banKind, setBanKind] = useState<'ip' | 'nickname'>('nickname');
  const [banValue, setBanValue] = useState('');
  const [banReason, setBanReason] = useState('');

  async function reload() {
    const [b, u] = await Promise.all([
      adminApi.bans().catch(() => ({ bans: [] })),
      adminApi.users().catch(() => ({ users: [] })),
    ]);
    setBans(b.bans);
    setUsers(u.users);
  }

  useEffect(() => {
    void reload();
  }, []);

  async function act(key: string, fn: () => Promise<unknown>, msg: string) {
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
  }

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink-2">
          {notice}
        </div>
      )}

      {/* 房间管理 */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink-2">
          <Settings2 className="h-4 w-4 text-accent" />
          房间管理
        </h3>

        {rooms.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-3">当前没有房间</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rooms.map((room) => (
              <li key={room.id} className="rounded-xl border border-line-soft p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-ink">{room.name}</p>
                    <p className="font-mono text-xs text-ink-3">{room.id}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() =>
                        act(
                          `limit-${room.id}`,
                          async () => {
                            const next = window.prompt(
                              '新的房间人数上限',
                              String(room.maxMembers),
                            );
                            if (!next) return;
                            await adminApi.setLimit(room.id, Number(next));
                          },
                          '人数上限已更新',
                        )
                      }
                      disabled={busy !== null}
                      className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
                    >
                      改人数上限
                    </button>
                    <button
                      onClick={() =>
                        act(
                          `rotate-${room.id}`,
                          () => adminApi.rotateKey(room.id),
                          '房间密钥已轮换',
                        )
                      }
                      disabled={busy !== null}
                      className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
                    >
                      {busy === `rotate-${room.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <KeyRound className="h-3 w-3" />
                      )}
                      轮换密钥
                    </button>
                    <button
                      onClick={() =>
                        act(
                          `close-${room.id}`,
                          () => adminApi.closeRoom(room.id),
                          '房间已关闭',
                        )
                      }
                      disabled={busy !== null}
                      className="flex items-center gap-1 rounded-lg border border-down/30 px-2.5 py-1.5 text-xs font-medium text-down hover:bg-down/10 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      关闭房间
                    </button>
                  </div>
                </div>

                {room.members.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-1.5 border-t border-line-soft pt-3">
                    {room.members.map((m) => (
                      <li
                        key={m.uid}
                        className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-2 ring-1 ring-line"
                      >
                        {m.nickname}
                        <button
                          onClick={() =>
                            act(
                              `kick-${m.uid}`,
                              () => adminApi.kick({ roomId: room.id, uid: m.uid }),
                              `已移出 ${m.nickname}`,
                            )
                          }
                          disabled={busy !== null}
                          title="移出该成员"
                          className="text-ink-3 hover:text-red-500 disabled:opacity-50"
                        >
                          <UserX className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 封禁 */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink-2">
          <ShieldBan className="h-4 w-4 text-down" />
          封禁名单
        </h3>

        <div className="mb-4 flex flex-wrap gap-2">
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
              act(
                'add-ban',
                async () => {
                  if (!banValue.trim()) throw new Error('请填写封禁值');
                  await adminApi.addBan({
                    kind: banKind,
                    value: banValue.trim(),
                    reason: banReason.trim() || undefined,
                  });
                  setBanValue('');
                  setBanReason('');
                },
                '已添加封禁',
              )
            }
            disabled={busy !== null}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            添加封禁
          </button>
        </div>

        {bans.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-3">封禁名单为空</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-soft">
            {bans.map((ban) => (
              <li key={ban.id} className="flex items-center gap-3 py-2.5">
                <span
                  className={cn(
                    'rounded-md px-2 py-0.5 text-xs font-medium',
                    ban.kind === 'ip'
                      ? 'bg-warn/15 text-warn'
                      : 'bg-down/15 text-down',
                  )}
                >
                  {ban.kind === 'ip' ? 'IP' : '昵称'}
                </span>
                <span className="font-mono text-sm text-ink-2">{ban.value}</span>
                {ban.reason && <span className="text-xs text-ink-3">{ban.reason}</span>}
                <span className="ml-auto text-xs text-ink-3">
                  {relativeTime(ban.createdAt)}
                  {ban.expiresAt ? ' · 限时' : ' · 永久'}
                </span>
                <button
                  onClick={() => act(`unban-${ban.id}`, () => adminApi.removeBan(ban.id), '已解除')}
                  disabled={busy !== null}
                  className="text-xs text-ink-3 hover:text-red-500 disabled:opacity-50"
                >
                  解除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 用户与昵称 */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink-2">
          <RefreshCw className="h-4 w-4 text-accent" />
          已注册昵称
          <span className="text-xs font-normal text-ink-3">共 {users.length} 个</span>
        </h3>

        {users.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-3">暂无注册用户</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {users.map((u) => (
              <li
                key={u.uid}
                className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-2 ring-1 ring-line"
              >
                {u.nickname}
                {u.role === 'admin' && ' 👑'}
                <button
                  onClick={() =>
                    act(
                      `release-${u.uid}`,
                      () => adminApi.releaseNickname(u.nickname),
                      `已释放昵称 ${u.nickname}`,
                    )
                  }
                  disabled={busy !== null}
                  title="释放该昵称"
                  className="text-ink-3 hover:text-red-500 disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 危险操作 */}
      <section className="rounded-2xl border border-warn/30 bg-warn/10/60 p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          维护操作
        </h3>
        <button
          onClick={() =>
            act('flush', () => adminApi.flush(), '已把缓冲落库到 D1')
          }
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
