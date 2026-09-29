import { useEffect, useState } from 'react';
import { Loader2, Minus, Plus, X } from 'lucide-react';

import { cn } from '~/lib/utils';

/** 房间人数上下限（与 shared/schema.ts 的 createRoomSchema 保持一致） */
export const ROOM_MEMBERS_MIN = 2;
export const ROOM_MEMBERS_MAX = 50;
export const ROOM_NAME_MAX = 24;

export interface RoomDraft {
  name: string;
  maxMembers: number;
}

/**
 * 房间编辑弹窗 —— 新建与改名共用。
 * mode='create' 时标题为「新建房间」；mode='edit' 时标题为「房间设置」。
 */
export function RoomDialog({
  mode,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial: RoomDraft;
  busy: boolean;
  onClose: () => void;
  onSubmit: (draft: RoomDraft) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [maxMembers, setMaxMembers] = useState(initial.maxMembers);

  // 房间切换（进入另一个房间的设置）时重置表单
  useEffect(() => {
    setName(initial.name);
    setMaxMembers(initial.maxMembers);
  }, [initial.name, initial.maxMembers]);

  const trimmed = name.trim();
  const invalid = trimmed.length === 0 || trimmed.length > ROOM_NAME_MAX;

  function clamp(n: number): number {
    return Math.min(ROOM_MEMBERS_MAX, Math.max(ROOM_MEMBERS_MIN, n));
  }

  function submit() {
    if (invalid || busy) return;
    onSubmit({ name: trimmed, maxMembers });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="rise-in relative w-full max-w-sm rounded-3xl border border-line bg-surface p-5 shadow-[var(--c-shadow-lg)]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">
            {mode === 'create' ? '新建房间' : '房间设置'}
          </h2>
          <button
            onClick={onClose}
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-ink-2">房间名</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={ROOM_NAME_MAX}
              placeholder="例如：开黑语音"
              autoFocus
              className="w-full rounded-2xl border border-line bg-surface-2/60 px-4 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/12"
            />
            <span className="flex justify-end text-[11px] text-ink-3">
              <span className="font-mono tabular-nums">
                {trimmed.length}/{ROOM_NAME_MAX}
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-ink-2">最大人数</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setMaxMembers((n) => clamp(n - 1))}
                disabled={maxMembers <= ROOM_MEMBERS_MIN}
                title="减少"
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-2 transition hover:bg-surface-3 disabled:opacity-40"
              >
                <Minus className="h-4 w-4" />
              </button>
              <input
                type="number"
                value={maxMembers}
                min={ROOM_MEMBERS_MIN}
                max={ROOM_MEMBERS_MAX}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setMaxMembers(clamp(Math.trunc(n)));
                }}
                className="w-20 rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-center font-mono text-sm tabular-nums text-ink outline-none transition focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/12"
              />
              <button
                type="button"
                onClick={() => setMaxMembers((n) => clamp(n + 1))}
                disabled={maxMembers >= ROOM_MEMBERS_MAX}
                title="增加"
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-2 transition hover:bg-surface-3 disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
              </button>
              <span className="text-[11px] text-ink-3">
                {ROOM_MEMBERS_MIN}–{ROOM_MEMBERS_MAX} 人
              </span>
            </div>
            <input
              type="range"
              min={ROOM_MEMBERS_MIN}
              max={ROOM_MEMBERS_MAX}
              value={maxMembers}
              onChange={(e) => setMaxMembers(clamp(Number(e.target.value)))}
              className="accent-accent"
            />
          </div>

          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl border border-line px-4 py-2.5 text-xs font-medium text-ink-2 transition hover:bg-surface-2"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={busy || invalid}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-accent-hover',
                (busy || invalid) && 'opacity-50',
              )}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === 'create' ? '创建' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
