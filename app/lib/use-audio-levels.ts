import { useEffect, useMemo, useRef, useState } from 'react';

/** 说话判定阈值（0–1）：低于此值视为静音，避免环境噪声把光圈点亮 */
export const SPEAKING_THRESHOLD = 0.08;

/**
 * 同时测量多个音频流的实时音量（0–1）。
 *
 * 用于房间成员网格：自己 + 所有远端成员都需要音量指示与说话光圈。
 * 每个流一个 AnalyserNode，共用一个 requestAnimationFrame 循环。
 *
 * @param streams uid → MediaStream；uid 从 map 中消失时自动清理。
 * @param enabled 传 false 时全部归零（例如自己被静音）。
 */
export function useAudioLevels(
  streams: Record<string, MediaStream>,
  opts: { enabled?: boolean } = {},
): Record<string, number> {
  const [levels, setLevels] = useState<Record<string, number>>({});
  const enabled = opts.enabled !== false;

  // 把最新 streams 存进 ref，避免 effect 依赖整个对象频繁重建
  const streamsRef = useRef(streams);
  streamsRef.current = streams;

  useEffect(() => {
    if (!enabled) {
      setLevels({});
      return;
    }

    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    // uid → 分析节点集合
    const nodes = new Map<
      string,
      { source: MediaStreamAudioSourceNode; analyser: AnalyserNode }
    >();
    let stopped = false;
    let raf = 0;
    // 复用同一块缓冲区，避免每帧分配
    let buf = new Uint8Array(512);

    const ensureNode = (uid: string, stream: MediaStream) => {
      const existing = nodes.get(uid);
      if (existing) return existing;
      // 流里还没有音轨时先不建节点
      if (stream.getAudioTracks().length === 0) return null;
      try {
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);
        const node = { source, analyser };
        nodes.set(uid, node);
        return node;
      } catch {
        // 同一个 stream 被重复 createMediaStreamSource 会抛错 —— 忽略
        return null;
      }
    };

    const dropNode = (uid: string) => {
      const node = nodes.get(uid);
      if (!node) return;
      try {
        node.source.disconnect();
        node.analyser.disconnect();
      } catch {
        /* 忽略 */
      }
      nodes.delete(uid);
    };

    const tick = () => {
      if (stopped) return;

      const current = streamsRef.current;
      const next: Record<string, number> = {};

      // 清理已消失的流
      for (const uid of [...nodes.keys()]) {
        if (!current[uid]) {
          dropNode(uid);
          continue;
        }
      }

      for (const [uid, stream] of Object.entries(current)) {
        const node = ensureNode(uid, stream);
        if (!node) {
          next[uid] = 0;
          continue;
        }

        if (buf.length !== node.analyser.fftSize) {
          buf = new Uint8Array(node.analyser.fftSize);
        }
        node.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        next[uid] = Math.min(1, rms * 4);
      }

      setLevels(next);
      raf = requestAnimationFrame(tick);
    };

    tick();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      for (const uid of [...nodes.keys()]) dropNode(uid);
      void ctx.close();
    };
  }, [enabled]);

  return levels;
}

/**
 * 从音量表派生「谁在说话」。
 * 只返回布尔而非原始音量，可避免网格组件因每帧数值变化而整体重渲染。
 */
export function useSpeakingSet(
  levels: Record<string, number>,
  muted?: Record<string, boolean>,
): Set<string> {
  return useMemo(() => {
    const set = new Set<string>();
    for (const [uid, level] of Object.entries(levels)) {
      if (level > SPEAKING_THRESHOLD && !muted?.[uid]) set.add(uid);
    }
    return set;
  }, [levels, muted]);
}
