import { cn } from '~/lib/utils';
import type { PresetAvatarId } from '@shared/constants';

/**
 * 头像渲染（三层优先级）：
 *   1. 自定义上传（avatarUrl）
 *   2. 预设头像（avatarId → /avatars/{id}.svg）
 *   3. 昵称 seed 自动生成（首字母 + 哈希色）
 */

interface AvatarProps {
  nickname: string;
  avatarId?: string | null;
  avatarUrl?: string | null;
  size?: number;
  speaking?: boolean;
  className?: string;
}

/** 从昵称派生一个稳定的色相 */
function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  return h;
}

/** 取昵称首个「字符」（含中文/emoji） */
function firstGlyph(nickname: string): string {
  const trimmed = nickname.trim();
  if (!trimmed) return '?';
  return [...trimmed][0]!.toUpperCase();
}

export function Avatar({
  nickname,
  avatarId,
  avatarUrl,
  size = 40,
  speaking = false,
  className,
}: AvatarProps) {
  const style = { width: size, height: size };

  const wrapper = cn(
    'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 ring-2 transition-[box-shadow,transform] duration-200',
    speaking ? 'speaking-ring ring-up' : 'ring-line',
    className,
  );

  if (avatarUrl) {
    return (
      <div className={wrapper} style={style}>
        <img src={avatarUrl} alt={nickname} className="h-full w-full object-cover" />
      </div>
    );
  }

  if (avatarId) {
    return (
      <div className={wrapper} style={style}>
        <img
          src={`/avatars/${avatarId}.svg`}
          alt={nickname}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  // 默认：昵称派生
  const hue = hashHue(nickname || 'anonymous');
  return (
    <div
      className={wrapper}
      style={{
        ...style,
        background: `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 42) % 360} 72% 48%))`,
      }}
    >
      <span
        className="select-none font-semibold text-white"
        style={{ fontSize: size * 0.42 }}
      >
        {firstGlyph(nickname)}
      </span>
    </div>
  );
}

/** 预设头像选择网格 */
export function AvatarPicker({
  value,
  onChange,
  presets,
  size = 48,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  presets: readonly string[];
  size?: number;
}) {
  return (
    <div className="grid grid-cols-6 gap-2">
      {presets.map((id) => {
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(selected ? null : (id as PresetAvatarId))}
            title={id}
            className={cn(
              'relative overflow-hidden rounded-full ring-2 transition',
              selected
                ? 'ring-accent ring-offset-2 ring-offset-surface'
                : 'ring-transparent hover:ring-line',
            )}
            style={{ width: size, height: size }}
          >
            <img
              src={`/avatars/${id}.svg`}
              alt={id}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </button>
        );
      })}
    </div>
  );
}
