import { Crown, MicOff, Volume2 } from 'lucide-react';

import { Avatar } from '~/components/Avatar';
import { VolumeMeter } from '~/components/VolumeMeter';
import { cn } from '~/lib/utils';
import type { RoomMember } from '@shared/types';

interface RoomGridProps {
  members: RoomMember[];
  selfUid: string;
  /** 说话中的 uid 集合（布尔集合，避免每帧数值刷新拖累渲染） */
  speaking: Set<string>;
  /** uid → 实时音量 (0–1)，仅用于音量条 */
  levels: Record<string, number>;
  /** uid → 是否已拿到远端音频流 */
  hasStream: Record<string, boolean>;
}

/**
 * Koko 式成员网格：大头像 + 名字在下方，按人数自适应铺开。
 *
 * 列数策略（1 / 2 / 3 / 4 列）随人数增长，让 2~10 人都保持接近正方形的大格子，
 * 而不是把头像挤成小圆点。
 */
export function RoomGrid({ members, selfUid, speaking, levels, hasStream }: RoomGridProps) {
  const count = members.length;
  const cols =
    count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;

  if (count === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-20 text-center">
        <p className="text-sm text-ink-3">房间里还没有人</p>
      </div>
    );
  }

  return (
    <ul
      className={cn(
        'grid w-full gap-3 sm:gap-4',
        cols === 1 && 'grid-cols-1',
        cols === 2 && 'grid-cols-2',
        cols === 3 && 'grid-cols-2 sm:grid-cols-3',
        cols === 4 && 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
      )}
    >
      {members.map((member, i) => (
        <MemberTile
          key={member.uid}
          member={member}
          isSelf={member.uid === selfUid}
          isSpeaking={speaking.has(member.uid)}
          level={levels[member.uid] ?? 0}
          connected={member.uid === selfUid || hasStream[member.uid] === true}
          index={i}
        />
      ))}
    </ul>
  );
}

function MemberTile({
  member,
  isSelf,
  isSpeaking,
  level,
  connected,
  index,
}: {
  member: RoomMember;
  isSelf: boolean;
  isSpeaking: boolean;
  level: number;
  connected: boolean;
  index: number;
}) {
  return (
    <li
      className="rise-in group relative"
      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
    >
      <div
        className={cn(
          'relative flex flex-col items-center justify-center gap-3 rounded-3xl border p-4 pt-6 transition-colors duration-200 sm:p-5 sm:pt-7',
          isSpeaking
            ? 'border-up/45 bg-up/[0.07]'
            : 'border-line-soft bg-surface/55 hover:border-line',
        )}
      >
        {/* 说话者柔光背景 */}
        {isSpeaking && (
          <span
            aria-hidden
            className="speaking-glow pointer-events-none absolute inset-x-6 top-4 h-24 rounded-full bg-up/25 blur-2xl"
          />
        )}

        <div className="relative">
          <Avatar
            nickname={member.nickname}
            avatarId={member.avatarId}
            avatarUrl={member.avatarUrl}
            size={68}
            speaking={isSpeaking}
            className="shadow-[0_8px_24px_-10px_rgb(15_23_42_/_0.35)]"
          />

          {/* 右下角状态角标：静音 / 未连接 */}
          {member.muted ? (
            <span
              title="已静音"
              className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-down text-white"
            >
              <MicOff className="h-3 w-3" />
            </span>
          ) : (
            !connected &&
            !isSelf && (
              <span
                title="连接中…"
                className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-surface-3 text-ink-2"
              >
                <Volume2 className="h-3 w-3" />
              </span>
            )
          )}
        </div>

        <div className="flex min-w-0 max-w-full flex-col items-center gap-1">
          <div className="flex max-w-full items-center gap-1.5">
            {member.role === 'admin' && (
              <Crown className="h-3.5 w-3.5 shrink-0 text-warn" />
            )}
            <span
              className={cn(
                'truncate text-sm font-medium',
                isSpeaking ? 'text-ink' : 'text-ink-2',
              )}
            >
              {member.nickname}
            </span>
            {isSelf && (
              <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">
                我
              </span>
            )}
          </div>

          {/* 音量条：静音者不显示，改为靠角标表达 */}
          {!member.muted && (
            <VolumeMeter
              level={level}
              className={cn('h-2.5 transition-opacity', isSpeaking ? 'opacity-100' : 'opacity-45')}
            />
          )}
        </div>
      </div>
    </li>
  );
}
