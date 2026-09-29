import { useEffect, useRef, useState } from 'react';
import { cn } from '~/lib/utils';

/**
 * 实时音量指示条。
 * 用 Web Audio API 的 AnalyserNode 计算 RMS，驱动 CSS 高度。
 */
export function VolumeMeter({ level, bars = 5, className }: { level: number; bars?: number; className?: string }) {
  const active = Math.round(level * bars);

  return (
    <div className={cn('flex items-end gap-0.5', className)} style={{ height: 16 }}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-1 rounded-sm transition-colors',
            i < active ? 'bg-up' : 'bg-surface-3',
          )}
          style={{ height: `${((i + 1) / bars) * 100}%` }}
        />
      ))}
    </div>
  );
}

/**
 * 用 Web Audio API 计算一个 MediaStream 的实时音量。
 * 返回 0–1 的归一化值。
 */
export function useAudioLevel(
  stream: MediaStream | null,
  opts: { enabled?: boolean; onLevel?: (level: number) => void } = {},
): number {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number>(0);
  const onLevelRef = useRef(opts.onLevel);
  onLevelRef.current = opts.onLevel;

  useEffect(() => {
    if (!stream || opts.enabled === false) {
      setLevel(0);
      return;
    }

    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.fftSize);
    let stopped = false;
    let lastReport = 0;

    const tick = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(buf);

      // RMS
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // 放大 + 限幅，让小声也可见
      const normalized = Math.min(1, rms * 4);

      setLevel(normalized);

      // 节流上报「是否在说话」（给 WS 广播用）
      const now = performance.now();
      if (now - lastReport > 350) {
        lastReport = now;
        onLevelRef.current?.(normalized);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    tick();

    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
      source.disconnect();
      analyser.disconnect();
      void ctx.close();
    };
  }, [stream, opts.enabled]);

  return level;
}
