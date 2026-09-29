import { useMemo } from 'react';
import {
  Crown,
  Loader2,
  MoveRight,
  ShieldX,
  UserPlus,
  Users,
} from 'lucide-react';

import { Avatar } from '~/components/Avatar';
import { ContextMenu, type MenuEntry } from '~/components/ContextMenu';
import { cn } from '~/lib/utils';
import type { PresenceSnapshot, PresenceStatus, PresenceUser, Profile, RoomWithMembers } from '@shared/types';

/** 非默认状态的展示文案 */
const STATUS_LABEL: Record<string, string> = {
  busy: '忙碌',
  away: '离开',
  invisible: '隐身',
};

/**
 * 第三栏 —— 连上这台服务器的人。
 *
 * 在线 = 保持 presence 心跳的人（无论是否在房间）；离线 = 已注册但当前没连接的人
 * （离线名册只对管理员返回，普通成员只看到在线的人）。
 *
 * 每一行的操作收进**右键菜单**：
 *   - 邀请（我在房间里、且对方不在我这个房间时）
 *   - 跟随（对方在别的房间时 → 我切过去，等价于「跳到 TA 的频道」）
 *   - 踢出服务器（仅管理员）
 *
 * 「单独调某人音量」不在这里 —— 那是「我听谁的声音」，
 * 属于房间内的事（右键房间里的卡片 / 成员列表），而不是服务器名册。
 */
export function MemberRail({
  profile,
  rooms,
  presence,
  currentRoomId,
  currentRoomName,
  pendingUid,
  onInvite,
  onFollow,
  onKick,
  className,
}: {
  profile: Profile;
  rooms: RoomWithMembers[];
  presence: PresenceSnapshot | null;
  currentRoomId: string | null;
  currentRoomName: string | null;
  pendingUid: string | null;
  onInvite: (user: PresenceUser) => void;
  /** 跟随：切到对方所在的房间 */
  onFollow: (user: PresenceUser) => void;
  onKick: (user: PresenceUser) => void;
  className?: string;
}) {
  const { online, offline } = useMemo(() => {
    const map = new Map<string, PresenceUser>();

    // 以 presence 为准
    for (const u of presence?.online ?? []) map.set(u.uid, u);

    // 再用房间快照补齐（心跳可能有一拍延迟，房间成员是权威的）
    for (const room of rooms) {
      for (const m of room.members) {
        const cur = map.get(m.uid);
        if (!cur) {
          map.set(m.uid, {
            uid: m.uid,
            nickname: m.nickname,
            role: m.role,
            avatarId: m.avatarId,
            avatarUrl: m.avatarUrl,
            online: true,
            status: 'online',
            invitable: true,
            roomId: room.id,
            roomName: room.name,
            lastSeen: m.lastSeen,
          });
        } else if (!cur.roomId) {
          map.set(m.uid, { ...cur, roomId: room.id, roomName: room.name });
        }
      }
    }

    const rank = (u: PresenceUser) =>
      (u.role === 'admin' ? 0 : 1) * 10 + (u.uid === profile.uid ? 0 : 1);
    const byRank = (a: PresenceUser, b: PresenceUser) =>
      rank(a) - rank(b) || a.nickname.localeCompare(b.nickname, 'zh-Hans-CN');

    const onlineList = [...map.values()].sort(byRank);
    const offlineList = (presence?.offline ?? [])
      .filter((u) => !map.has(u.uid))
      .sort((a, b) => a.nickname.localeCompare(b.nickname, 'zh-Hans-CN'));

    return { online: onlineList, offline: offlineList };
  }, [presence, rooms, profile.uid]);

  return (
    <aside
      className={cn(
        'flex w-[240px] shrink-0 flex-col border-l border-line-soft bg-surface/40',
        className,
      )}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 px-4">
        <Users className="h-4 w-4 text-ink-3" />
        <span className="flex-1 text-sm font-semibold tracking-tight text-ink">服务器成员</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-2">
          {online.length}
        </span>
      </header>

      <div className="thin-scroll flex-1 overflow-y-auto px-2 pb-4">
        <GroupLabel>在线 — {online.length}</GroupLabel>
        {online.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-3">暂时没有人</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {online.map((u) => (
              <MemberRow
                key={u.uid}
                user={u}
                isSelf={u.uid === profile.uid}
                isAdmin={profile.role === 'admin'}
                currentRoomId={currentRoomId}
                currentRoomName={currentRoomName}
                pending={pendingUid === u.uid}
                onInvite={onInvite}
                onFollow={onFollow}
                onKick={onKick}
              />
            ))}
          </ul>
        )}

        {offline.length > 0 && (
          <>
            <GroupLabel className="mt-3">离线 — {offline.length}</GroupLabel>
            <ul className="flex flex-col gap-0.5">
              {offline.map((u) => (
                <MemberRow
                  key={u.uid}
                  user={u}
                  isSelf={false}
                  isAdmin={profile.role === 'admin'}
                  currentRoomId={currentRoomId}
                  currentRoomName={currentRoomName}
                  pending={pendingUid === u.uid}
                  onInvite={onInvite}
                  onFollow={onFollow}
                  onKick={onKick}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

function GroupLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'px-2 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3',
        className,
      )}
    >
      {children}
    </p>
  );
}

function MemberRow({
  user,
  isSelf,
  isAdmin,
  currentRoomId,
  currentRoomName,
  pending,
  onInvite,
  onFollow,
  onKick,
}: {
  user: PresenceUser;
  isSelf: boolean;
  isAdmin: boolean;
  currentRoomId: string | null;
  currentRoomName: string | null;
  pending: boolean;
  onInvite: (user: PresenceUser) => void;
  onFollow: (user: PresenceUser) => void;
  onKick: (user: PresenceUser) => void;
}) {
  const inMyRoom = !!currentRoomId && user.roomId === currentRoomId;
  /** 对方在别的房间 → 可以「跟随」过去 */
  const canFollow = !isSelf && user.online && !!user.roomId && !inMyRoom;
  /** 我在房间里、对方不在线上我这个房间、且对方接受邀请 → 可以邀请 */
  const canInvite =
    !isSelf &&
    user.online &&
    user.invitable &&
    user.status !== 'busy' &&
    !!currentRoomId &&
    !inMyRoom;
  const canKick = isAdmin && !isSelf;

  const entries: MenuEntry[] = [];

  if (canFollow) {
    entries.push({
      id: 'follow',
      label: '跟随',
      icon: <MoveRight className="h-3.5 w-3.5" />,
      hint: user.roomName ? `去「${user.roomName}」` : undefined,
      onSelect: () => onFollow(user),
    });
  }

  if (canInvite) {
    entries.push({
      id: 'invite',
      label: '邀请到我的房间',
      icon: <UserPlus className="h-3.5 w-3.5" />,
      hint: currentRoomName ? `「${currentRoomName}」` : undefined,
      onSelect: () => onInvite(user),
    });
  }

  if (canKick) {
    if (entries.length > 0) entries.push({ id: 'sep', separator: true });
    entries.push({
      id: 'kick',
      label: '踢出服务器',
      icon: <ShieldX className="h-3.5 w-3.5" />,
      danger: true,
      onSelect: () => onKick(user),
    });
  }

  const statusDot =
    user.online
      ? user.status === 'busy'
        ? 'bg-down'
        : user.status === 'away'
          ? 'bg-warn'
          : user.status === 'invisible'
            ? 'bg-ink-3'
            : 'bg-up'
      : 'bg-ink-3';
  const statusLabel =
    user.online && user.status !== 'online' && user.status !== 'invisible'
      ? STATUS_LABEL[user.status]
      : null;

  const row = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="relative shrink-0">
        <Avatar
          nickname={user.nickname}
          avatarId={user.avatarId}
          avatarUrl={user.avatarUrl}
          size={30}
          className={cn(
            'ring-1',
            (!user.online || user.status === 'invisible') && 'opacity-45 grayscale',
          )}
        />
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface',
            statusDot,
          )}
        />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1">
          {user.role === 'admin' && <Crown className="h-3 w-3 shrink-0 text-warn" />}
          <span
            className={cn(
              'truncate text-[13px]',
              user.online && user.status !== 'invisible' ? 'font-medium text-ink' : 'text-ink-3',
            )}
          >
            {user.nickname}
          </span>
          {isSelf && (
            <span className="shrink-0 rounded bg-accent-soft px-1 py-px text-[10px] font-medium text-accent-ink">
              我
            </span>
          )}
          {statusLabel && (
            <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[10px] text-ink-3">
              {statusLabel}
            </span>
          )}
        </p>
        <p className="truncate text-[11px] text-ink-3">
          {inMyRoom ? '在同一频道' : user.roomName ? `在 ${user.roomName}` : '未进频道'}
        </p>
      </div>

      {pending && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-3" />}
    </div>
  );

  if (entries.length === 0) {
    return (
      <li className="flex items-center gap-2 rounded-xl px-1.5 py-1 transition hover:bg-surface-2">
        {row}
      </li>
    );
  }

  return (
    <li>
      <ContextMenu
        entries={entries}
        header={user.nickname}
        className="flex items-center gap-2 rounded-xl px-1.5 py-1 transition hover:bg-surface-2"
      >
        {row}
      </ContextMenu>
    </li>
  );
}
