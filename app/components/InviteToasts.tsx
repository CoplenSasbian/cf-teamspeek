import { Check, UserPlus, X } from 'lucide-react';

import type { PresenceInvite } from '@shared/types';

/**
 * 邀请提醒：别人邀请你进频道时，右下角弹出的卡片。
 */
export function InviteToasts({
  invites,
  onAccept,
  onDismiss,
}: {
  invites: PresenceInvite[];
  onAccept: (invite: PresenceInvite) => void;
  onDismiss: (id: string) => void;
}) {
  if (invites.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[19rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {invites.map((invite) => (
        <div
          key={invite.id}
          className="rise-in pointer-events-auto rounded-2xl border border-line bg-surface p-3 shadow-[var(--c-shadow-lg)]"
        >
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
              <UserPlus className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug text-ink">
                <span className="font-semibold">{invite.fromNickname}</span> 邀请你加入频道
              </p>
              <p className="mt-0.5 truncate text-xs text-ink-3">「{invite.roomName}」</p>
            </div>
            <button
              onClick={() => onDismiss(invite.id)}
              title="忽略"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => onAccept(invite)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover"
            >
              <Check className="h-3.5 w-3.5" />
              加入频道
            </button>
            <button
              onClick={() => onDismiss(invite.id)}
              className="rounded-xl border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:bg-surface-2"
            >
              忽略
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
