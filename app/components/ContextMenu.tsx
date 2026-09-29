import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';

import { cn } from '~/lib/utils';

/**
 * 右键菜单 / 下拉菜单。
 *
 * 这是「应用」而不是「网页」的手感来源：操作收进菜单，界面上只留内容。
 * 三种用法：
 *   - <ContextMenu>   包住一行/一块区域，右键弹出（定位到鼠标）
 *   - <MenuButton>    一个「⋯」按钮，点击弹出（定位到按钮下方）
 *   - <MenuPanel>     自己管 anchor（少见）
 *
 * 菜单用 fixed 定位 + 视口钳制，避免被 overflow 容器裁掉。
 */

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 右侧的次要说明（例如快捷键、目标房间名） */
  hint?: string;
  /** 危险操作（删除 / 踢出）→ 红色 */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  id: string;
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

export function isMenuSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'separator' in entry;
}

const MENU_MIN_W = 184;
const EDGE = 8;

// ============================================================
//  菜单面板（fixed + 视口钳制 + 键盘导航）
// ============================================================

export function MenuPanel({
  anchor,
  entries,
  header,
  /** 菜单顶部的自定义区域（例如内嵌一条音量滑块） */
  custom,
  onClose,
  /** 触发器的点击不算「点外部」（否则按钮 toggling 会失效） */
  ignoreTarget,
}: {
  anchor: { x: number; y: number };
  entries: MenuEntry[];
  header?: ReactNode;
  custom?: ReactNode;
  onClose: () => void;
  ignoreTarget?: (target: Node) => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: MENU_MIN_W, h: 0 });
  const [active, setActive] = useState(-1);

  /** 可选项在 entries 里的下标（分隔符与禁用项跳过） */
  const selectable = useMemo(
    () =>
      entries
        .map((e, i) => (isMenuSeparator(e) || e.disabled ? -1 : i))
        .filter((i) => i >= 0),
    [entries],
  );

  // 先按估算位置渲染，量出真实尺寸后再钳制回视口内
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, [entries, header, custom, anchor]);

  const left = Math.min(
    Math.max(EDGE, anchor.x),
    Math.max(EDGE, window.innerWidth - size.w - EDGE),
  );
  const top =
    anchor.y + size.h + EDGE > window.innerHeight
      ? Math.max(EDGE, anchor.y - size.h - EDGE)
      : anchor.y;

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (ignoreTarget?.(target)) return;
      onClose();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectable.length === 0) return;
        const down = e.key === 'ArrowDown';
        setActive((cur) => {
          const pos = cur < 0 ? (down ? 0 : selectable.length - 1) : selectable.indexOf(cur) + (down ? 1 : -1);
          return selectable[(pos + selectable.length) % selectable.length]!;
        });
        return;
      }
      if (e.key === 'Enter' && active >= 0) {
        const item = entries[active];
        if (item && !isMenuSeparator(item) && !item.disabled) {
          e.preventDefault();
          onClose();
          item.onSelect();
        }
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onClose);
    // 页面滚动时 fixed 定位会脱离锚点 —— 直接关掉最省心
    window.addEventListener('scroll', onClose, true);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose, ignoreTarget, selectable, active, entries]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: 'fixed', left, top, minWidth: MENU_MIN_W, zIndex: 60 }}
      className="rise-in rounded-2xl border border-line bg-surface p-1.5 shadow-[var(--c-shadow-lg)]"
      onContextMenu={(e) => e.preventDefault()}
    >
      {header && (
        <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          {header}
        </div>
      )}

      {custom}

      {entries.map((entry, i) =>
        isMenuSeparator(entry) ? (
          <div key={entry.id} className="my-1 h-px bg-line-soft" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-[13px] transition',
              entry.disabled
                ? 'cursor-default text-ink-3 opacity-55'
                : entry.danger
                  ? 'text-down hover:bg-down/12'
                  : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              active === i && !entry.disabled && (entry.danger ? 'bg-down/12' : 'bg-surface-2 text-ink'),
            )}
          >
            {entry.icon && (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">{entry.icon}</span>
            )}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint && (
              <span className="shrink-0 truncate text-[11px] text-ink-3">{entry.hint}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

// ============================================================
//  右键菜单（包住一块区域）
// ============================================================

export function ContextMenu({
  entries,
  header,
  custom,
  children,
  className,
  onContextMenu,
  ...rest
}: {
  entries: MenuEntry[];
  header?: ReactNode;
  custom?: ReactNode;
} & ComponentPropsWithoutRef<'div'>) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);

  return (
    <>
      <div
        {...rest}
        ref={wrapRef}
        className={className}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu?.(e);
          setAnchor({ x: e.clientX, y: e.clientY });
        }}
      >
        {children}
      </div>

      {anchor && (
        <MenuPanel
          anchor={anchor}
          entries={entries}
          header={header}
          custom={custom}
          onClose={close}
          ignoreTarget={(n) => wrapRef.current?.contains(n) ?? false}
        />
      )}
    </>
  );
}

// ============================================================
//  「⋯」按钮菜单
// ============================================================

export function MenuButton({
  entries,
  header,
  custom,
  icon,
  title,
  className,
  active = false,
}: {
  entries: MenuEntry[];
  header?: ReactNode;
  custom?: ReactNode;
  icon: ReactNode;
  title: string;
  className?: string;
  /** 菜单里有非默认状态时高亮按钮 */
  active?: boolean;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAnchor(null), []);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (anchor) {
            close();
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
          anchor || active
            ? 'bg-accent-soft text-accent-ink'
            : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
          className,
        )}
      >
        {icon}
      </button>

      {anchor && (
        <MenuPanel
          anchor={anchor}
          entries={entries}
          header={header}
          custom={custom}
          onClose={close}
          ignoreTarget={(n) => btnRef.current?.contains(n) ?? false}
        />
      )}
    </>
  );
}
