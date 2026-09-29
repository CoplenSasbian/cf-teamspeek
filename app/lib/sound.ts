import { audioMixer } from './audio-mixer';
import { loadSettings, saveSettings } from './settings';

/**
 * 界面音效 —— Web Audio 合成，不加载任何音频文件。
 *
 * 为什么合成而不是放 mp3：几个提示音加起来不到 1KB 的代码，
 * 零网络请求、零资源管理、音色统一（同一套振荡器参数），
 * 而且能精确控制包络避免「咔哒」爆音。
 *
 * 触发点：
 *   - joinSelf   我进入了房间
 *   - leaveSelf  我离开了房间
 *   - memberIn   有人进入我所在的房间
 *   - memberOut  有人离开我所在的房间
 *   - message    新文字消息
 *   - invite     被邀请入房
 *
 * 全部走 audioMixer 的 AudioContext（master 音量对音效也生效），
 * 并且只在混音器解锁后发声 —— 不会出现「打开页面就响一声」。
 */

export type SoundName =
  | 'joinSelf'
  | 'leaveSelf'
  | 'memberIn'
  | 'memberOut'
  | 'message'
  | 'invite';

/** 各音效的合成参数（频率 Hz / 时长 ms / 类型） */
const SPECS: Record<
  SoundName,
  { notes: Array<{ f: number; t: number; d: number; type?: OscillatorType; gain?: number }>; kind: 'up' | 'down' | 'ping' | 'chime' }
> = {
  // 进房：两音上行，明亮
  joinSelf: { kind: 'up', notes: [{ f: 523, t: 0, d: 90 }, { f: 784, t: 90, d: 140 }] },
  // 离房：两音下行，收尾感
  leaveSelf: { kind: 'down', notes: [{ f: 523, t: 0, d: 90 }, { f: 349, t: 90, d: 160 }] },
  // 有人进来：单音轻快上滑
  memberIn: { kind: 'up', notes: [{ f: 660, t: 0, d: 70 }, { f: 880, t: 60, d: 90, gain: 0.5 }] },
  // 有人离开：单音下滑
  memberOut: { kind: 'down', notes: [{ f: 660, t: 0, d: 70 }, { f: 494, t: 60, d: 100, gain: 0.5 }] },
  // 新消息：短促双击
  message: { kind: 'ping', notes: [{ f: 880, t: 0, d: 60, gain: 0.4 }, { f: 1175, t: 70, d: 80, gain: 0.35 }] },
  // 被邀请：三音小琶音
  invite: {
    kind: 'chime',
    notes: [
      { f: 659, t: 0, d: 110 },
      { f: 831, t: 110, d: 110 },
      { f: 988, t: 220, d: 200 },
    ],
  },
};

/** 总增益（相对 master 音量的比例），别让提示音盖过人声 */
const FX_GAIN = 0.22;

export function playSound(name: SoundName): void {
  if (typeof window === 'undefined') return;
  if (loadSettings().soundEffects === false) return;

  const ctx = audioMixer.getContextIfRunning();
  if (!ctx) return; // AudioContext 还没解锁（无用户手势）→ 安静跳过

  const spec = SPECS[name];
  const now = ctx.currentTime + 0.01;

  // 独立的音效总线 → 挂到 destination（人声走 <audio>.volume，互不影响）
  const bus = ctx.createGain();
  bus.gain.value = FX_GAIN;
  bus.connect(ctx.destination);

  for (const note of spec.notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = note.type ?? 'sine';
    osc.frequency.setValueAtTime(note.f, now + note.t / 1000);

    const start = now + note.t / 1000;
    const end = start + note.d / 1000;
    const peak = note.gain ?? 0.8;

    // 包络：2ms 快起 → 保持 → 25ms 释放，杜绝爆音
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.002);
    gain.gain.setValueAtTime(peak, Math.max(start + 0.002, end - 0.025));
    gain.gain.linearRampToValueAtTime(0, end);

    osc.connect(gain);
    gain.connect(bus);
    osc.start(start);
    osc.stop(end + 0.02);
  }

  // 总线用完即弃
  const totalMs = spec.notes.reduce((max, n) => Math.max(max, n.t + n.d), 0);
  setTimeout(() => bus.disconnect(), totalMs + 100);
}

// ============================================================
//  开关（持久化）
// ============================================================

export function soundEffectsEnabled(): boolean {
  return loadSettings().soundEffects !== false;
}

export function setSoundEffectsEnabled(on: boolean): void {
  saveSettings({ soundEffects: on });
  if (on) playSound('message'); // 打开时给个反馈音
}
