import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';

import { Avatar } from '~/components/Avatar';
import { audioMixer, PLAYBACK_VOLUME_MAX } from '~/lib/audio-mixer';
import { cn } from '~/lib/utils';

/**
 * 音量相关的 UI 基础件。
 *
 * 注意：这些只是 UI。真正的增益由 `audioMixer` 应用在 Web Audio 图上
 * （Cloudflare Realtime SFU 是转发器，不提供任何音量能力）。
 */

// ============================================================
//  基础件
// ============================================================

/** 弹出面板：点触发器打开，点外部或 Esc 关闭（绝对定位，贴在触发器旁） */
export function Popover({
  icon,
  title,
  active = false,
  placement = 'down',
  align = 'end',
  triggerClassName,
  panelClassName,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  /** 打开中或有非默认值时的强调样式 */
  active?: boolean;
  placement?: 'up' | 'down';
  align?: 'start' | 'end';
  triggerClassName?: string;
  panelClassName?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-expanded={open}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-xl transition',
          open || active
            ? 'bg-accent-soft text-accent-ink'
            : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
          triggerClassName,
        )}
      >
        {icon}
      </button>

      {open && (
        <div
          className={cn(
            'rise-in absolute z-30 w-[15rem] rounded-2xl border border-line bg-surface p-3 shadow-[var(--c-shadow-lg)]',
            placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-1.5',
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** 音量滑块：0–max（默认 100%，录制音量可到 200%） */
export function VolumeSlider({
  label,
  value,
  onChange,
  max = PLAYBACK_VOLUME_MAX,
  hint,
  children,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  max?: number;
  hint?: string;
  /** 滑块下方附加内容（例如实时电平条） */
  children?: React.ReactNode;
}) {
  const percent = Math.round(value * 100);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-ink-2">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-ink-2">{percent}%</span>
      </div>

      <input
        type="range"
        min={0}
        max={max * 100}
        step={5}
        value={percent}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label={label}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3"
        style={{ accentColor: 'var(--c-accent)' }}
      />

      {children}
      {hint && <p className="text-[11px] leading-snug text-ink-3">{hint}</p>}
    </div>
  );
}

/** 迷你电平条：用于「试音」时看自己的输入有没有声音 */
export function LevelBar({ level, muted = false }: { level: number; muted?: boolean }) {
  const active = !muted && level > 0.02;
  const bars = 5;
  const filled = muted ? 0 : Math.round(Math.min(1, level * 2.2) * bars);

  return (
    <div className="flex items-center gap-[3px]" aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-2.5 flex-1 rounded-sm transition-colors duration-75',
            i < filled ? (active ? 'bg-up' : 'bg-ink-3') : 'bg-surface-3',
          )}
        />
      ))}
    </div>
  );
}

// ============================================================
//  房间里「单独调某人音量」
// ============================================================

const PANEL_W = 208;
const PANEL_H = 168;
const EDGE = 8;

/**
 * 房间内的成员音量浮层。
 *
 * 只通过**右键**成员卡片 / 列表行打开（定位到鼠标处）。
 * 刻意不再提供常驻的音量小按钮：这是一个应用而不是网页，
 * 界面上应该只留内容，操作收进右键菜单。
 *
 * 用 `position: fixed` + 视口钳制，避免被滚动容器裁掉；
 * 这比在卡片里做绝对定位稳得多。
 */
export function MemberVolumePopover({
  uid,
  nickname,
  avatarId,
  avatarUrl,
  volume,
  mutedByMe,
  className,
  children,
}: {
  uid: string;
  nickname: string;
  avatarId?: string | null;
  avatarUrl?: string | null;
  /** 我为 TA 设置的播放音量（1 = 100%） */
  volume: number;
  /** 我是否单独静音了 TA（与服务端 muted 无关） */
  mutedByMe: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const silenced = mutedByMe || volume === 0;

  const openAt = useCallback((x: number, y: number) => {
    const maxX = window.innerWidth - PANEL_W - EDGE;
    const left = Math.min(Math.max(EDGE, x - PANEL_W / 2), Math.max(EDGE, maxX));
    // 下方放不下就翻到上方
    const top =
      y + PANEL_H + EDGE > window.innerHeight
        ? Math.max(EDGE, y - PANEL_H - EDGE)
        : y + EDGE;
    setPos({ x: left, y: top });
  }, []);

  const close = useCallback(() => setPos(null), []);

  useDismiss(!!pos, close, panelRef);

  return (
    <div
      className={cn('relative', className)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openAt(e.clientX, e.clientY);
      }}
    >
      {children}

      {/* 调过的成员给一个低调的角标，提示「此人音量被我动过」 */}
      {silenced && (
        <span
          title="已被你单独静音（右键可调整）"
          className="shrink-0 text-down"
        >
          <VolumeX className="h-3.5 w-3.5" />
        </span>
      )}

      {pos && (
        <div
          ref={panelRef}
          style={{ position: 'fixed', left: pos.x, top: pos.y, width: PANEL_W }}
          className="rise-in z-50 rounded-2xl border border-line bg-surface p-3 shadow-[var(--c-shadow-lg)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <Avatar nickname={nickname} avatarId={avatarId} avatarUrl={avatarUrl} size={22} className="ring-1" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
              {nickname}
            </span>
          </div>

          <div className="mt-3">
            <VolumeSlider
              label="播放音量"
              value={silenced ? 0 : volume}
              onChange={(v) => audioMixer.setUserVolume(uid, v)}
            />
          </div>

          <button
            type="button"
            onClick={() => audioMixer.setUserMuted(uid, !mutedByMe)}
            className={cn(
              'mt-3 w-full rounded-xl border px-3 py-1.5 text-[11px] font-medium transition',
              mutedByMe
                ? 'border-accent/40 bg-accent-soft text-accent-ink'
                : 'border-line text-ink-2 hover:bg-surface-2',
            )}
          >
            {mutedByMe ? '取消单独静音' : '单独静音 TA'}
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
//  内部工具
// ============================================================

/** 点外部 / Esc 关闭。extraTarget 用于「触发器自身的点击不算外部」 */
function useDismiss(
  active: boolean,
  onDismiss: () => void,
  containerRef: React.RefObject<HTMLElement | null>,
  isInsideExtra?: (target: Node) => boolean,
): void {
  useEffect(() => {
    if (!active) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      if (isInsideExtra?.(target)) return;
      onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active, onDismiss, containerRef, isInsideExtra]);
}
