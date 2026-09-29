import type { GtcrnWorkletNode, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import type { Settings } from './settings';

/**
 * 麦克风降噪引擎 —— 基于 @sapphi-red/web-noise-suppressor 的 AudioWorklet。
 *
 * 两种可选引擎：
 *   - GTCRN  效果更好（ICASSP2024，48K 参数超越 RNNoise），推理稍重
 *   - RNNoise xiph 经典，极轻，效果一般
 *
 * ⚠️ 本模块（以及依赖它的 audio-mixer）会被 SSR bundle 引入，
 * 因此包的【类】必须用动态 import() 加载 —— 静态 import 会让
 * `class extends AudioWorkletNode` 在 Workers 环境求值时直接崩掉
 * （ReferenceError: AudioWorkletNode is not defined）。
 *
 * 插入位置：麦克风源 → [降噪节点] → 混音器增益链路。
 * worklet/wasm 资源已复制到 /public（gtcrn-worklet.js / gtcrn.wasm 等），
 * 由构建时脚本保证与 npm 包版本一致。
 */

export type DenoiseEngine = 'off' | 'gtcrn' | 'rnnoise';

const GTCRN_WORKLET_URL = '/gtcrn-worklet.js';
const GTCRN_WASM_URL = '/gtcrn.wasm';
const RNNOISE_WORKLET_URL = '/rnnoise-worklet.js';
const RNNOISE_WASM_URL = '/rnnoise.wasm';
const RNNOISE_SIMD_WASM_URL = '/rnnoise_simd.wasm';

type DenoiseNode = GtcrnWorkletNode | RnnoiseWorkletNode;

/** 当前已加载的降噪节点（每个 AudioContext 一条链，全局唯一麦克风） */
let activeNode: DenoiseNode | null = null;
/** 当前生效的引擎（createDenoiseNode 成功才更新 —— 失败回退时保持 off） */
let activeEngine: DenoiseEngine = 'off';

/** 当前实际生效的降噪引擎（面板展示 / 调试用） */
export function activeDenoiseEngine(): DenoiseEngine {
  return activeEngine;
}

/** 浏览器内动态加载包（SSR 安全：仅客户端会走到这里） */
async function loadWorklets() {
  return await import('@sapphi-red/web-noise-suppressor');
}

function isSimdSupported(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 2, 2, 127, 0]),
    );
  } catch {
    return false;
  }
}

/**
 * 创建降噪节点。返回 null 表示关闭降噪或初始化失败（失败时回退原始麦克风）。
 */
export async function createDenoiseNode(
  ctx: AudioContext,
  engine: DenoiseEngine,
): Promise<DenoiseNode | null> {
  if (engine === 'off') return null;

  try {
    const { GtcrnWorkletNode: G, RnnoiseWorkletNode: R } = await loadWorklets();

    if (engine === 'gtcrn') {
      const wasmBinary = await fetch(GTCRN_WASM_URL).then((r) => {
        if (!r.ok) throw new Error(`gtcrn.wasm 加载失败（${r.status}）`);
        return r.arrayBuffer();
      });
      await ctx.audioWorklet.addModule(GTCRN_WORKLET_URL);
      return new G(ctx, { wasmBinary, maxChannels: 1 });
    }

    // rnnoise
    const simd = isSimdSupported();
    const wasmBinary = await fetch(simd ? RNNOISE_SIMD_WASM_URL : RNNOISE_WASM_URL).then((r) => {
      if (!r.ok) throw new Error(`rnnoise wasm 加载失败（${r.status}）`);
      return r.arrayBuffer();
    });
    await ctx.audioWorklet.addModule(RNNOISE_WORKLET_URL);
    return new R(ctx, { wasmBinary, maxChannels: 1 });
  } catch (err) {
    console.error('[denoise] 初始化失败，回退原始麦克风', err);
    return null;
  }
}

/** GTCRN worklet 支持的采样率（worklet 内部硬约束，超出会初始化失败并静音） */
const SUPPORTED_SAMPLE_RATES = [16000, 48000];

/**
 * 把降噪链路插到「源 → 混音器」之间（或摘掉）。
 * 返回实际用于连接的终点节点：降噪开 → worklet；关 → 源本身。
 *
 * ⚠️ Web Audio 的 `connect()` 是【累加】的，不是替换。切换引擎时必须先把
 * `source` 上所有旧的出边断开，否则每切一次就多留一条路径 ——
 * 最终 `source → gain`（原始带噪信号）与 `source → worklet → gain`
 * （降噪信号）同时存在于同一个 gain 上，两路叠加，降噪被原始信号淹没，
 * 表现为「怎么切都没区别」。
 */
export async function attachDenoise(
  source: MediaStreamAudioSourceNode,
  destination: AudioNode,
  engine: DenoiseEngine,
): Promise<AudioNode> {
  await detachDenoise();

  // 关键：清掉 source 上的历史连接。
  //
  // ⚠️ 两个必须小心的点：
  //   1. connect() 是累加语义 —— 不清旧边会造成「原始信号 + 降噪信号」叠加
  //      （表现为「怎么切降噪都没区别」）
  //   2. source.disconnect() 是【无差别】断开所有出边 —— 包括自适应补偿的
  //      分析器。调用方必须在进来之前先摘掉分析器，否则它们会被静默断开，
  //      而 this.dnPreAnalyser 仍持有引用，后续 tick 读到的是死节点。
  //
  // 另外：断开与「重新连上」之间有窗口。中途若 await 卡住或抛错，
  // source 会处于「零出边」状态 → 对端彻底没声。
  // 因此下面每个分支都保证最终连上 destination。
  try {
    source.disconnect();
  } catch {
    /* 没有连接时 disconnect() 会抛，属正常 */
  }

  if (engine === 'off') {
    activeEngine = 'off';
    source.connect(destination);
    return source;
  }

  // 预检采样率：worklet 内部对不支持的采样率会直接 throw 且【无法从外部感知】，
  // 结果是一条永远静音的轨道被发布出去（表现为「刚进去没声」）。
  const rate = source.context.sampleRate;
  if (!SUPPORTED_SAMPLE_RATES.includes(rate)) {
    console.error(`[denoise] 采样率 ${rate}Hz 不受 ${engine} 支持，回退直连`);
    activeEngine = 'off';
    source.connect(destination);
    return source;
  }

  let node: DenoiseNode | null = null;
  try {
    node = await createDenoiseNode(source.context as AudioContext, engine);
  } catch (err) {
    console.error('[denoise] 创建降噪节点抛错', err);
    node = null;
  }

  if (!node) {
    // 初始化失败：直连，不影响出声
    console.error(`[denoise] ${engine} 初始化失败，回退直连`);
    activeEngine = 'off';
    source.connect(destination);
    return source;
  }

  activeNode = node;
  activeEngine = engine;
  source.connect(node);
  node.connect(destination);
  return node;
}

/** 摘掉当前降噪节点（断开所有连接并销毁） */
export async function detachDenoise(): Promise<void> {
  const node = activeNode;
  activeNode = null;
  activeEngine = 'off';
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    /* ignore */
  }
  node.destroy?.();
}

/** 从设置里读降噪引擎 */
export function denoiseEngineOf(settings: Settings | undefined): DenoiseEngine {
  return settings?.denoise?.engine ?? 'off';
}

// ============================================================
//  A/B 试听：录 3 秒「原始 vs 降噪后」，顺序播放对比
// ============================================================

export interface DenoiseProbeResult {
  /** 采样到的原始音（未降噪） */
  rawBlob: Blob;
  /** 降噪后的音 */
  denoisedBlob: Blob | null;
  /** 实际使用的引擎 */
  engine: DenoiseEngine;
}

/**
 * 采集 countSeconds 秒的麦克风，同时录下「原始」与「降噪后」两路。
 * 降噪关（或初始化失败）时 denoisedBlob 为 null，只返回原始音。
 */
export async function probeDenoise(
  countSeconds = 3,
  engine: DenoiseEngine,
  onCountdown?: (remaining: number) => void,
): Promise<DenoiseProbeResult> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      // 试听对比时不让浏览器 AGC 自动补偿 —— 否则两路音量都被 AGC 拉平，
      // 听不出降噪模型本身带来的电平差异
      autoGainControl: false,
    },
  });

  try {
    const ctx = new AudioContext();
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);

    // 原始路：直接录
    const rawDest = ctx.createMediaStreamDestination();
    source.connect(rawDest);
    const rawRec = new MediaRecorder(rawDest.stream);
    const rawChunks: Blob[] = [];
    rawRec.ondataavailable = (e) => e.data.size > 0 && rawChunks.push(e.data);

    // 降噪路：插入 worklet 后录
    let denoisedRec: MediaRecorder | null = null;
    const denoisedChunks: Blob[] = [];
    let denoisedNode: DenoiseNode | null = null;
    let denoisedDest: MediaStreamAudioDestinationNode | null = null;

    if (engine !== 'off') {
      const node = await createDenoiseNode(ctx, engine);
      if (node) {
        denoisedNode = node;
        denoisedDest = ctx.createMediaStreamDestination();
        source.connect(node);
        node.connect(denoisedDest);
        denoisedRec = new MediaRecorder(denoisedDest.stream);
        denoisedRec.ondataavailable = (e) => e.data.size > 0 && denoisedChunks.push(e.data);
      }
    }

    rawRec.start();
    denoisedRec?.start();

    for (let remain = countSeconds; remain > 0; remain--) {
      onCountdown?.(remain);
      await new Promise((r) => setTimeout(r, 1000));
    }

    rawRec.stop();
    denoisedRec?.stop();
    await new Promise((r) => setTimeout(r, 200));

    const mime = rawChunks[0]?.type || 'audio/webm';
    const rawBlob = new Blob(rawChunks, { type: mime });
    const denoisedBlob = denoisedChunks.length
      ? new Blob(denoisedChunks, { type: denoisedChunks[0]!.type || mime })
      : null;

    source.disconnect();
    denoisedNode?.destroy?.();
    await ctx.close();

    return { rawBlob, denoisedBlob, engine: denoisedBlob ? engine : 'off' };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** 试听一个 blob（创建临时 Audio，播放完自动释放） */
export function playProbeBlob(blob: Blob, onEnded?: () => void): HTMLAudioElement {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => {
    URL.revokeObjectURL(url);
    onEnded?.();
  };
  void audio.play();
  return audio;
}
