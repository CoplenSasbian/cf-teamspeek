import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Crown,
  Headphones,
  LogIn,
  LogOut,
  Mic,
  MicOff,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  UserPlus,
  Volume2,
} from 'lucide-react';

import { Avatar } from '~/components/Avatar';
import { ContextMenu, type MenuEntry } from '~/components/ContextMenu';
import { MemberVolumePopover } from '~/components/VolumeControl';
import { VoiceStatusPanel, type LatencySnapshot } from '~/components/VoiceStatusPanel';
import { useMixerVolumes, useSpeakingSet } from '~/lib/audio-mixer';
import type { DenoiseEngine } from '~/lib/denoise';
import { cn } from '~/lib/utils';
import { DEFAULT_ROOM_ID } from '@shared/constants';
import type { Profile, RoomWithMembers } from '@shared/types';
import type { VoiceStatus } from '~/routes/app-shell';

/**
 * 第一栏 —— 房间列表。
 *
 * 对应 KOOK 的「频道列表」：
 *   - 上面是这台服务器的房间（语音房间）
 *   - 进入房间后，房间下方直接铺开房里的人（和 KOOK 语音频道下挂成员一致）
 *   - 底部是自己：头像 / 昵称 / 后台 / 退出
 *
 * Web 端没有「多服务器」概念（一个部署就是一台服务器），所以 KOOK 最左侧的
 * 服务器竖排图标栏在这里是不需要的。
 */
export function Sidebar({
  appName,
  profile,
  rooms,
  currentRoomId,
  currentRoomName,
  busy,
  onEnterRoom,
  onCreateRoom,
  onRenameRoom,
  onDeleteRoom,
  onRefresh,
  onLogout,
  onOpenSettings,
  onCopyInvite,
  className,
  voice,
  onLeaveRoom,
  denoise,
  onCycleDenoise,
  denoiseSwitching,
  measureLatency,
}: {
  appName: string;
  profile: Profile;
  rooms: RoomWithMembers[];
  currentRoomId: string | null;
  currentRoomName: string | null;
  busy: boolean;
  onEnterRoom: (id: string) => void;
  onCreateRoom: () => void;
  /** 打开房间设置弹窗（改名 / 人数上限） */
  onRenameRoom: (room: RoomWithMembers) => void;
  /** 返回 false 表示用户取消了确认 */
  onDeleteRoom: (room: RoomWithMembers) => Promise<boolean>;
  onRefresh: () => void;
  onLogout: () => void;
  onOpenSettings: () => void;
  /** 复制邀请链接（带 key，对方打开即可自动填好） */
  onCopyInvite: () => void;
  className?: string;
  /** 语音状态（麦克风 / 连接 / 音量）——显示在房间列表和用户信息之间 */
  voice: VoiceStatus | null;
  /** 离开当前房间（语音面板的挂断按钮） */
  onLeaveRoom: () => void;
  /** 当前降噪引擎（语音面板的小徽标 + 弹出面板开关） */
  denoise: DenoiseEngine;
  /** 循环切换降噪（off → gtcrn → rnnoise → off），立即生效 */
  onCycleDenoise: () => void;
  denoiseSwitching: boolean;
  /** 延迟测量（在房间里时由房间页实现，用于信号图标 hover 详情） */
  measureLatency: (() => Promise<unknown>) | null;
}) {
  /** 每人音量：订阅一次，避免每行各订阅一份 */
  const volumes = useMixerVolumes();

  /** 说话判定：内部自带 rAF + 迟滞，成员集合不变就不触发重渲染（防图标频闪） */
  const speakingSet = useSpeakingSet(true);

  /** 手风琴：点击行只展开，进入要点「进入」按钮、双击行，或右键菜单里的「进入」 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 房间行的右键菜单：进入 / 改名 / 删除 */
  const roomMenu = (room: RoomWithMembers, active: boolean): MenuEntry[] => {
    const isAdmin = profile.role === 'admin';
    const canManage =
      isAdmin || (room.id !== DEFAULT_ROOM_ID && room.ownerUid === profile.uid);

    const entries: MenuEntry[] = [
      {
        id: 'enter',
        label: active ? '当前所在房间' : '进入房间',
        icon: <LogIn className="h-3.5 w-3.5" />,
        disabled: active || busy,
        onSelect: () => onEnterRoom(room.id),
      },
    ];

    if (canManage) {
      entries.push({ id: 'sep1', separator: true });
      entries.push({
        id: 'rename',
        label: '房间设置…',
        icon: <Pencil className="h-3.5 w-3.5" />,
        hint: '改名 / 人数',
        onSelect: () => onRenameRoom(room),
      });
      entries.push({
        id: 'delete',
        label: '删除房间',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        danger: true,
        onSelect: () => void onDeleteRoom(room),
      });
    }

    return entries;
  };

  const sorted = useMemo(
    () =>
      [...rooms].sort((a, b) => {
        // 有人的房间排前面，其次按创建时间
        if ((b.memberCount > 0 ? 1 : 0) !== (a.memberCount > 0 ? 1 : 0)) {
          return (b.memberCount > 0 ? 1 : 0) - (a.memberCount > 0 ? 1 : 0);
        }
        return a.createdAt - b.createdAt;
      }),
    [rooms],
  );

  return (
    <aside
      className={cn(
        'flex w-[248px] shrink-0 flex-col border-r border-line-soft bg-surface/55',
        className,
      )}
    >
      {/* 服务器头 */}
      <header className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-white">
          <Headphones className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight text-ink">{appName}</p>
          <p className="text-[11px] text-ink-3">当前服务器</p>
        </div>
        <button
          onClick={onCopyInvite}
          title="复制邀请链接（含访问 key，对方打开即可加入）"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 transition hover:bg-accent-soft hover:text-accent-ink"
        >
          <UserPlus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onRefresh}
          title="刷新房间列表"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* 房间列表 */}
      <div className="thin-scroll flex-1 overflow-y-auto px-2 pb-3">
        <div className="flex items-center justify-between px-2 pb-1.5 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            房间
          </span>
          <button
            onClick={onCreateRoom}
            disabled={busy}
            title="新建房间"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {sorted.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-ink-3">还没有房间</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sorted.map((room) => {
              const active = room.id === currentRoomId;
              const live = room.memberCount > 0;
              const open = expanded.has(room.id) || active;

              return (
                <li key={room.id}>
                  {/*
                    行本体 = 展开/收起开关。
                    单击只展开，进入要点「进入」按钮或双击行；
                    其余操作（进入 / 改名 / 删除）收进右键菜单。
                  */}
                  <ContextMenu
                    entries={roomMenu(room, active)}
                    header={room.name}
                    className={cn(
                      'group flex w-full cursor-pointer items-center gap-1 rounded-xl py-1.5 pl-1 pr-1.5 text-left transition',
                      active
                        ? 'bg-accent-soft text-accent-ink'
                        : live
                          ? 'text-ink-2 hover:bg-surface-2'
                          : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
                    )}
                  >
                    <div
                      onClick={() => toggleExpanded(room.id)}
                      onDoubleClick={() => onEnterRoom(room.id)}
                      title="单击展开成员 · 双击进入房间 · 右键更多操作"
                      className="flex min-w-0 flex-1 items-center gap-1"
                    >
                      <span className="flex h-4 w-3 shrink-0 items-center justify-center text-ink-3">
                        {open ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </span>
                      <Volume2
                        className={cn(
                          'h-4 w-4 shrink-0',
                          active ? 'text-accent' : live ? 'text-up' : 'text-ink-3',
                        )}
                      />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-[13px]',
                          active ? 'font-semibold' : 'font-medium',
                        )}
                      >
                        {room.name}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">
                        {room.memberCount}/{room.maxMembers}
                      </span>
                    </div>
                  </ContextMenu>

                  {/* 展开后：进入按钮 + 房间里的成员 */}
                  {open && (
                    <div className="mb-1 ml-[1.15rem] border-l border-line-soft pl-2.5">
                      <button
                        onClick={() => onEnterRoom(room.id)}
                        disabled={active || busy}
                        title={active ? '已在这个房间里' : '进入房间'}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium transition',
                          active
                            ? 'cursor-default text-ink-3'
                            : 'text-accent-ink hover:bg-accent-soft',
                        )}
                      >
                        <LogIn className="h-3 w-3 shrink-0" />
                        {active ? '当前房间' : '进入'}
                      </button>
                    </div>
                  )}

                  {/* 房间里的人（展开即可看，不必进入） */}
                  {open && room.members.length > 0 && (
                    <ul className="mb-1 ml-[1.15rem] flex flex-col gap-0.5 border-l border-line-soft pl-2.5">
                      {room.members.map((m) => {
                        const isSelf = m.uid === profile.uid;
                        const volume = volumes.users[m.uid] ?? 1;
                        const mutedByMe = volumes.mutedUsers.includes(m.uid);
                        const adjusted = mutedByMe || Math.abs(volume - 1) > 0.001;

                        const row = (
                          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1">
                            <Avatar
                              nickname={m.nickname}
                              avatarId={m.avatarId}
                              avatarUrl={m.avatarUrl}
                              size={20}
                              speaking={speakingSet.has(m.uid)}
                              className="ring-1"
                            />
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate text-xs',
                                isSelf ? 'text-accent-ink' : 'text-ink-2',
                              )}
                            >
                              {m.nickname}
                            </span>
                            {speakingSet.has(m.uid) ? (
                              // 正在说话：绿色麦克风图标
                              <Mic className="h-3 w-3 shrink-0 text-up" />
                            ) : m.muted ? (
                              <MicOff className="h-3 w-3 shrink-0 text-down" />
                            ) : null}
                            {m.role === 'admin' && (
                              <Crown className="h-3 w-3 shrink-0 text-warn" />
                            )}
                          </span>
                        );

                        return (
                          <li key={m.uid} className="flex items-center">
                            {isSelf ? (
                              row
                            ) : (
                              // 音量收进右键菜单：列表上不再挂按钮
                              <MemberVolumePopover
                                uid={m.uid}
                                nickname={m.nickname}
                                avatarId={m.avatarId}
                                avatarUrl={m.avatarUrl}
                                volume={volume}
                                mutedByMe={mutedByMe}
                                className="flex min-w-0 flex-1 items-center"
                              >
                                {row}
                              </MemberVolumePopover>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 语音状态：房间列表之下、用户信息之上（常驻，没进房时显示待命态） */}
      <VoiceStatusPanel
        inRoom={!!currentRoomId}
        selfUid={profile.uid}
        roomName={currentRoomName}
        muted={voice?.muted ?? false}
        connected={voice?.connected ?? false}
        connecting={voice?.connecting ?? false}
        hasMic={voice?.hasMic ?? false}
        elapsed={voice?.elapsed ?? null}
        onToggleMute={voice?.onToggleMute ?? (() => {})}
        onLeave={onLeaveRoom}
        denoise={denoise}
        onCycleDenoise={onCycleDenoise}
        denoiseSwitching={denoiseSwitching}
        measureLatency={measureLatency as (() => Promise<LatencySnapshot>) | null}
      />

      {/* 底部：自己（操作全部收成图标按钮） */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line-soft p-2.5">
        <Avatar
          nickname={profile.nickname}
          avatarId={profile.avatarId}
          avatarUrl={profile.avatarUrl}
          size={34}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{profile.nickname}</p>
          <p className="flex items-center gap-1 text-[11px] text-ink-3">
            {profile.role === 'admin' ? (
              <>
                <Crown className="h-3 w-3 text-warn" />
                管理员
              </>
            ) : (
              '成员'
            )}
            <span className="text-up">· 在线</span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={onOpenSettings}
            title="账号设置"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onLogout}
            title="退出登录"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 transition hover:bg-down/12 hover:text-down"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
