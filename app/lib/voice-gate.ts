import type { VoiceGatePrefs } from './settings';

/**
 * 语音门限的主线程侧封装。
 *
 * 节点由 public/voice-gate-worklet.js 实现（见那个文件顶部的设计说明）。
 * 这里只负责：加载模块、建节点、写参数、把节点上报的电平/状态转出来给界面。
 *
 * ⚠️ 本模块会被 SSR bundle 引入，所以不能在这里碰 AudioWorkletNode 之类
 * 的浏览器全局 —— 全部走 AudioContext 实例上的方法。
 */

const VOICE_GATE_WORKLET_URL = '/voice-gate-worklet.js';
const PROCESSOR_NAME = 'cf-voice-gate';

/** 每个 AudioContext 只 addModule 一次（失败的会从缓存里删掉，允许重试） */
const loadedModules = new WeakMap<AudioContext, Promise<void>>();

export function ensureVoiceGateModule(ctx: AudioContext): Promise<void> {
  const cached = loadedModules.get(ctx);
  if (cached) return cached;

  const pending = ctx.audioWorklet.addModule(VOICE_GATE_WORKLET_URL).catch((err: unknown) => {
    // 失败就清缓存：一次网络抖动不该让这个功能永久不可用
    loadedModules.delete(ctx);
    throw err;
  });
  loadedModules.set(ctx, pending);
  return pending;
}

/** worklet 每约 50ms 上报一次 */
export interface VoiceGateReport {
  /** 检测支路的当前电平（dBFS），说话时约 -30 ~ -10 */
  levelDb: number;
  /** 门当前是开是关 */
  open: boolean;
  /** 当前增益（开门且稳定后精确为 1） */
  gain: number;
}

/**
 * 建门限节点。
 *
 * 接线约定：
 *   input 0 ← 主链路（要被门控的信号）
 *   input 1 ← 侧链（原始麦克风，供检测用；不接也能工作，但阈值会失去稳定性）
 *   output  → 下游
 *
 * 返回 null 表示模块加载/创建失败 —— 调用方必须把主链路直连过去，
 * 绝不能因为门限不可用就没声。
 */
export async function createVoiceGate(
  ctx: AudioContext,
  prefs: VoiceGatePrefs,
): Promise<AudioWorkletNode | null> {
  try {
    await ensureVoiceGateModule(ctx);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      // 两路输入：0 = 主链路，1 = 检测侧链
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    applyVoiceGatePrefs(node, prefs);
    return node;
  } catch (err) {
    console.error('[voice-gate] 初始化失败，语音门限不可用（不影响出声）', err);
    return null;
  }
}

/**
 * 写入开关与阈值。两个都是 k-rate AudioParam，随时可改，**不需要重接线** ——
 * 这也是把门常驻在链路里的理由：开关门不会产生任何音频中断。
 */
export function applyVoiceGatePrefs(node: AudioWorkletNode, prefs: VoiceGatePrefs): void {
  const enabled = node.parameters.get('enabled');
  const threshold = node.parameters.get('thresholdDb');
  if (enabled) enabled.value = prefs.enabled ? 1 : 0;
  if (threshold) threshold.value = prefs.thresholdDb;
}
