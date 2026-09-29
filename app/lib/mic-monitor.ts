import { micAudioConstraints } from './sfu-session';
import { DEFAULT_MIC_INPUT_PREFS, type MicInputPrefs } from './settings';

/**
 * 进房前的「试麦」—— 打开麦克风，只读电平，不出声。
 *
 * 为什么需要它：设置里的设备下拉框如果没有反馈，用户根本不知道
 * 自己选中的设备到底有没有在收音。这是「能选设备」和「选对了设备」的区别。
 *
 * 与房间链路的关系：完全独立。它自己开一条 getUserMedia + 一个临时
 * AudioContext，停止时全部释放，不碰 audioMixer 的任何状态。
 */

/** 电平轮询间隔。60ms 足够看清说话时的跳动，也不会给主线程添负担 */
const POLL_MS = 60;
/** 低于这个值当静音处理（避免 log(0)） */
const SILENCE_DB = -100;

export interface MicMonitorOptions {
  prefs?: MicInputPrefs;
  deviceId?: string;
  /** 每约 60ms 回调一次（dBFS，负值；-100 = 静音） */
  onLevel: (levelDb: number) => void;
}

export interface MicMonitor {
  stop(): void;
}

export async function startMicMonitor(opts: MicMonitorOptions): Promise<MicMonitor> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micAudioConstraints(opts.prefs ?? DEFAULT_MIC_INPUT_PREFS, opts.deviceId),
    video: false,
  });

  const ctx = new AudioContext();
  await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.4;

  // 零增益汇点：让分析器真的被渲染，但绝不发出声音。
  // 直接把 analyser 接到 destination 会造成啸叫（自己听自己）。
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink);
  sink.connect(ctx.destination);

  const buf = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    const rms = Math.sqrt(sum / buf.length);
    opts.onLevel(rms > 1e-7 ? Math.max(20 * Math.log10(rms), SILENCE_DB) : SILENCE_DB);
  }, POLL_MS);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        source.disconnect();
        analyser.disconnect();
        sink.disconnect();
      } catch {
        /* 已经断了 */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    },
  };
}
