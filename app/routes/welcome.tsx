import { useNavigate, useOutletContext } from 'react-router';
import { DoorOpen, Headphones, Plus, RefreshCw, Users } from 'lucide-react';

import { Avatar } from '~/components/Avatar';
import { cn } from '~/lib/utils';
import type { ShellContext } from '~/routes/app-shell';

export function meta() {
  return [{ title: '游戏语音室' }];
}

/** 未选择房间时的中间栏：房间总览。 */
export default function Welcome() {
  const { profile, rooms, refreshRooms, openCreateRoom } =
    useOutletContext<ShellContext>();
  const navigate = useNavigate();

  const live = rooms.filter((r) => r.memberCount > 0);
  const totalOnline = rooms.reduce((sum, r) => sum + r.memberCount, 0);

  return (
    <div className="thin-scroll flex h-full flex-col overflow-y-auto">
      <header className="flex flex-col gap-3 px-6 pb-5 pt-7 sm:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
            <Headphones className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight text-ink">
              嗨，{profile.nickname}
            </h1>
            <p className="text-xs text-ink-3">
              挑一个房间开始语音 · 当前有 {totalOnline} 人在频道里
            </p>
          </div>
          <button
            onClick={() => void refreshRooms()}
            title="刷新"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-surface text-ink-2 transition hover:bg-surface-2"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      <section className="flex flex-col gap-3 px-6 pb-10 sm:px-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-2">
            房间
            <span className="ml-1.5 font-normal text-ink-3">
              {live.length} 个有人 / 共 {rooms.length} 个
            </span>
          </h2>
          <button
            onClick={openCreateRoom}
            className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" />
            新建房间
          </button>
        </div>

        {rooms.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-line bg-surface/50 px-6 py-12 text-center">
            <Headphones className="h-8 w-8 text-ink-3" />
            <p className="text-sm text-ink-3">还没有房间，创建一个开始吧</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rooms.map((room) => {
              const isLive = room.memberCount > 0;
              return (
                <li key={room.id}>
                  <button
                    onClick={() => navigate(`/room/${room.id}`)}
                    className={cn(
                      'group flex h-full w-full flex-col gap-3 rounded-3xl border bg-surface/60 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[var(--c-shadow)]',
                      isLive ? 'border-up/35' : 'border-line',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl transition',
                          isLive ? 'bg-up/12 text-up' : 'bg-surface-2 text-ink-3',
                        )}
                      >
                        <DoorOpen className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">{room.name}</p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                          <Users className="h-3 w-3" />
                          {room.memberCount} / {room.maxMembers} 人
                          {isLive && (
                            <span className="ml-1 flex items-center gap-1 text-up">
                              <span className="h-1.5 w-1.5 rounded-full bg-up" />
                              活跃
                            </span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex min-h-[26px] items-center gap-2">
                      {room.members.length > 0 ? (
                        <>
                          <span className="flex -space-x-2">
                            {room.members.slice(0, 5).map((m) => (
                              <Avatar
                                key={m.uid}
                                nickname={m.nickname}
                                avatarId={m.avatarId}
                                avatarUrl={m.avatarUrl}
                                size={26}
                                className="ring-2 ring-surface"
                              />
                            ))}
                          </span>
                          <span className="truncate text-[11px] text-ink-3">
                            {room.members
                              .slice(0, 3)
                              .map((m) => m.nickname)
                              .join('、')}
                            {room.members.length > 3 ? ` 等 ${room.members.length} 人` : ''}
                          </span>
                        </>
                      ) : (
                        <span className="text-[11px] text-ink-3">还没有人，进去开个麦</span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
