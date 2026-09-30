import type { GtcrnWorkletNode, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import { createDfn3Node, dfn3Supported, type Dfn3Handle } from './dfn3-engine';
import { micAudioConstraints } from './sfu-session';
import type { MicInputPrefs, Settings } from './settings';

/**
 * 麦克风降噪引擎。
 *
 * 三个可选引擎：
 *   - GTCRN  效果更好（ICASSP2024，48K 参数超越 RNNoise），推理稍重
 *   - RNNoise xiph 经典，极轻，效果一般
 *   - DFN3   DeepFilterNet3（ONNX，浏览器内跑）。**对「说话中打字」的键盘声
 *            有实质抑制**（实测 −5.6~−7.0dB），而前两个引擎对同时发生的
 *            非人声基本无效（它们是按「平稳噪声」训练的）。
 *            代价：延迟 32ms（前两者的降噪延迟是 13.3ms），且首次要下载约 24MB。
 *
 * ⚠️ 本模块（以及依赖它的 audio-mixer）会被 SSR bundle 引入，
 * 因此包的【类】必须用动态 import() 加载 —— 静态 import 会让
 * `class extends AudioWorkletNode` 在 Workers 环境求值时直接崩掉
 * （ReferenceError: AudioWorkletNode is not defined）。
 * dfn3-engine 内部同理：它的 dfn3Supported() 会访问 globalThis.crossOriginIsolated，
 * 所以在 SSR 期间只做只读判断，真正的加载走异步。
 *
 * 插入位置：麦克风源 → [高通] → [降噪节点] → 补偿增益 → 软限幅 → 发布。
 * worklet/wasm 资源已复制到 /public（gtcrn-worklet.js / gtcrn.wasm 等），
 * 由构建时脚本保证与 npm 包版本一致。
 */

export type DenoiseEngine = 'off' | 'gtcrn' | 'rnnoise' | 'dfn3';

const GTCRN_WORKLET_URL = '/gtcrn-worklet.js';
const GTCRN_WASM_URL = '/gtcrn.wasm';
const RNNOISE_WORKLET_URL = '/rnnoise-worklet.js';
const RNNOISE_WASM_URL = '/rnnoise.wasm';
const RNNOISE_SIMD_WASM_URL = '/rnnoise_simd.wasm';

/** 两个自带引擎的节点形态：AudioWorkletNode + 可选的 destroy() */
type DenoiseNode = (GtcrnWorkletNode | RnnoiseWorkletNode) & { destroy?: () => void };

/**
 * 统一的降噪节点句柄。
 *
 * 前两个引擎是「AudioWorkletNode + destroy()」，DFN3 是
 * 「AudioWorkletNode + dispose()（还要停 worker）」。这里用一个可选 destroy
 * 把两者统一 —— 否则 attachDenoise / swapDenoise / 各处的清理逻辑都要分叉。
 */
type DenoiseHandle = DenoiseNode | Dfn3Handle;

/** 当前已加载的降噪句柄（每个 AudioContext 一条链，全局唯一麦克风） */
let activeNode: DenoiseHandle | null = null;
/** 当前生效的引擎（createDenoiseNode 成功才更新 —— 失败回退时保持 off） */
let activeEngine: DenoiseEngine = 'off';

/**
 * 降噪 worklet 的固有延迟（样本 @48kHz）。
 *
 * 两个引擎实测都是 640 样本（13.33ms），推导来自 worklet 里的环形缓冲：
 *   - GTCRN：frameSize 768 = 6×128，写满一帧才推理，输出从帧内第 1 个
 *     128 块开始吐 → (6-1)×128 = 640（前 5 块吐出的是初始化的全零）
 *   - RNNoise：环形缓冲 1920，输出读指针 = 写指针 + 1280
 *     → 1920-1280 = 640
 *
 * 自适应补偿必须把「降噪前」的测量也延迟这么多，否则两边比的是
 * 两段相差 13ms 的声音 —— 语音在 10ms 尺度上起伏极大，比值会乱跳。
 */
export const DENOISE_LATENCY_SAMPLES = 640;

/**
 * DFN3 的固有延迟（样本 @48kHz）= 512。
 *
 * 512 样本帧的 STFT 前瞻。加上 worklet 里对齐用的那一段干信号延迟
 * （见 client/dfn3/channel.mjs），**总延迟是 1024 样本 ≈ 21.3ms**；
 * 再加上模型内部的流水线（实测端到端 32ms，见 scripts/audio-eval/README.md）。
 *
 * 自适应补偿要用这个值把「降噪前」那一路对齐 —— 用错值会让比值在语音上乱跳，
 * 进而让本地音量补偿做出错误的增益调整。
 */
export const DFN3_LATENCY_SAMPLES = 1024;

/** 按引擎取固有延迟（样本 @48kHz）。补偿分析器用它对齐干信号。 */
export function denoiseLatencySamples(engine: DenoiseEngine): number {
  return engine === 'dfn3' ? DFN3_LATENCY_SAMPLES : DENOISE_LATENCY_SAMPLES;
}

/** 当前实际生效的降噪引擎（面板展示 / 调试用） */
export function activeDenoiseEngine(): DenoiseEngine {
  return activeEngine;
}

/**
 * DFN3 在当前环境是否可用（不看资产是否已下载，只看浏览器能力）。
 * 设置面板用它决定要不要把 DFN3 显示为可选。
 */
export function dfn3Availability(): { ok: boolean; reason?: string } {
  return dfn3Supported();
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

// ============================================================
//  资源缓存：worklet 模块 + wasm 二进制
// ============================================================

/** 已 addModule 过的 worklet URL（按 AudioContext 记） */
const loadedModules = new WeakMap<AudioContext, Set<string>>();
/**
 * wasm 二进制缓存。存 Promise 而不是结果：并发调用只会 fetch 一次；
 * 失败时把缓存删掉，下次还能重试（否则一次网络抖动会永久毁掉降噪）。
 */
const wasmCache = new Map<string, Promise<ArrayBuffer>>();

function fetchWasm(url: string): Promise<ArrayBuffer> {
  const cached = wasmCache.get(url);
  if (cached) return cached;

  const pending = fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`${url} 加载失败（${res.status}）`);
      const buf = await res.arrayBuffer();
      // 在主线程先验一遍二进制。
      //
      // 为什么必须在这一步拦：worklet 内部的实例化是【静默失败】的 ——
      // 看 worklet 源码，processor 没建起来时 `process()` 走短路分支，
      // 既不写输出也照样返回 true，外部完全看不出来，结果就是发布一条
      // 永远静音的轨道。能在这里抛错，至少会走「回退直连」而不是变哑巴。
      if (!WebAssembly.validate(buf)) throw new Error(`${url} 不是合法的 wasm`);
      return buf;
    })
    .catch((err: unknown) => {
      wasmCache.delete(url);
      throw err;
    });

  wasmCache.set(url, pending);
  return pending;
}

async function ensureModule(ctx: AudioContext, url: string): Promise<void> {
  let done = loadedModules.get(ctx);
  if (!done) {
    done = new Set<string>();
    loadedModules.set(ctx, done);
  }
  if (done.has(url)) return;
  await ctx.audioWorklet.addModule(url);
  done.add(url);
}

/** 引擎对应的资源 URL */
function assetsOf(engine: Exclude<DenoiseEngine, 'off'>): { module: string; wasm: string } {
  if (engine === 'gtcrn') return { module: GTCRN_WORKLET_URL, wasm: GTCRN_WASM_URL };
  return {
    module: RNNOISE_WORKLET_URL,
    wasm: isSimdSupported() ? RNNOISE_SIMD_WASM_URL : RNNOISE_WASM_URL,
  };
}

/**
 * 预热：提前把 worklet 模块与 wasm 拉进缓存。
 *
 * 切换引擎的耗时几乎全在「fetch wasm + addModule」上，预热过之后再切就只剩
 * 接线，用户感知不到停顿。失败无所谓（后续按需加载还会再试一遍），
 * 所以这里只 warn 不抛。
 */
export async function prewarmDenoise(ctx: AudioContext, engine: DenoiseEngine): Promise<void> {
  if (engine === 'off') return;

  // DFN3 刻意**不预热**。
  //
  // 它要下载约 24MB（ORT 运行时 + 模型），而「用户可能会切到这个引擎」
  // 这个概率并不高 —— 为一个可能不发生的选择预先拉 24MB 是明显的浪费，
  // 尤其对流量敏感的用户。代价是首次切换会等下载完成，所以
  // createDfn3Node 提供了 onProgress 回调用于给出进度反馈。
  if (engine === 'dfn3') return;

  try {
    const { module, wasm } = assetsOf(engine);
    await Promise.all([ensureModule(ctx, module), fetchWasm(wasm)]);
  } catch (err) {
    console.warn('[denoise] 预热失败（不影响后续按需加载）', err);
  }
}

/**
 * 创建降噪节点。返回 null 表示关闭降噪或初始化失败（失败时回退原始麦克风）。
 */
export async function createDenoiseNode(
  ctx: AudioContext,
  engine: DenoiseEngine,
): Promise<DenoiseHandle | null> {
  if (engine === 'off') return null;

  // DFN3 走完全不同的形态：AudioWorklet + Web Worker + SharedArrayBuffer，
  // 不是「一个 worklet + 一个 wasm」那种库提供的节点。
  if (engine === 'dfn3') {
    const handle = await createDfn3Node(ctx);
    return handle;
  }

  try {
    const { GtcrnWorkletNode: G, RnnoiseWorkletNode: R } = await loadWorklets();
    const { module, wasm } = assetsOf(engine);
    const [cached] = await Promise.all([fetchWasm(wasm), ensureModule(ctx, module)]);
    // 传副本：缓存里的 ArrayBuffer 会被反复使用（切引擎、重进房、试听各一次），
    // 万一将来某个环节把它 transfer 掉，缓存会变成一个长度 0 的空壳，
    // 之后所有降噪都静默失效。复制一次 200KB 远比查这种 bug 便宜。
    const wasmBinary = cached.slice(0);

    if (engine === 'gtcrn') return new G(ctx, { wasmBinary, maxChannels: 1 });
    return new R(ctx, { wasmBinary, maxChannels: 1 });
  } catch (err) {
    console.error('[denoise] 初始化失败，回退原始麦克风', err);
    return null;
  }
}

/** GTCRN worklet 支持的采样率（worklet 内部硬约束，超出会初始化失败并静音） */
const GTCRN_SAMPLE_RATES = [16000, 48000];
/**
 * RNNoise worklet 假定 48kHz（库的 d.ts 原文 "Assumes sample rate to be 48kHz"），
 * 帧长固定 480 样本。给它 16k 不会报错，但时间尺度整体错掉（一帧变成 30ms）。
 * 现在 AudioContext 固定 48k，所以这条约束不会被触发；分开写是为了别把两个
 * 引擎的采样率要求混为一谈（原实现共用一份 16k/48k 的列表，注释只提 GTCRN）。
 */
const RNNOISE_SAMPLE_RATES = [48000];

/**
 * DFN3 只支持 48kHz —— 而且这是**模型内部**的硬约束（ERB 滤波器组按 48k 设计），
 * 不是可以重采样绕过的。给它 44.1k 会得到完全错误的频谱特征。
 */
const DFN3_SAMPLE_RATES = [48000];

function supportedRates(engine: Exclude<DenoiseEngine, 'off'>): number[] {
  if (engine === 'gtcrn') return GTCRN_SAMPLE_RATES;
  if (engine === 'dfn3') return DFN3_SAMPLE_RATES;
  return RNNOISE_SAMPLE_RATES;
}

/** 断开节点（本来就没连时 disconnect() 会抛，属正常） */
function safeDisconnect(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    /* 没有出边时 disconnect() 会抛，忽略 */
  }
}

/** 释放 worklet 的 wasm 状态（DFN3 还要顺带停掉推理 worker） */
function destroyNode(node: DenoiseHandle | null): void {
  if (!node) return;
  safeDisconnect(node);
  try {
    // DFN3 的句柄用 dispose()（内部会 terminate worker）
    if ('dispose' in node && typeof node.dispose === 'function') {
      node.dispose();
      return;
    }
    (node as DenoiseNode).destroy?.();
  } catch {
    /* ignore */
  }
}

/**
 * 一次性改接线：把 input 的出口从旧路径改到 node（node 为 null 表示直连 destination）。
 *
 * ⚠️ Web Audio 的 `connect()` 是【累加】的，不是替换。切换引擎时必须先把
 * `input` 上所有旧的出边断开，否则每切一次就多留一条路径 ——
 * 最终 `input → destination`（原始带噪信号）与 `input → worklet → destination`
 * （降噪信号）同时存在于同一个 gain 上，两路叠加，降噪被原始信号淹没，
 * 表现为「怎么切都没区别」。
 *
 * ⚠️ 断边与接线必须在本函数内一次做完（中间不能有 await）。图变更按渲染量子
 * 提交：同一个 JS 任务里的 disconnect + connect 会在同一个量子生效，中间不
 * 存在静音窗；一旦中间插入 await，那个量子就没人喂了。
 */
function rewire(input: AudioNode, destination: AudioNode, node: DenoiseHandle | null): void {
  safeDisconnect(input);
  if (node) {
    node.connect(destination);
    input.connect(node);
  } else {
    input.connect(destination);
  }
}

/**
 * 把降噪链路插到「输入 → 目的地」之间（或摘掉）。
 * 返回实际用于连接的终点节点：降噪开 → worklet；关 → 输入本身。
 *
 * 【先建后切】是这段代码的全部要点（原实现是反的）：
 *   原实现先 `input.disconnect()` 再 `await createDenoiseNode()`，而 await 里是
 *   fetch wasm + addModule，首次可能几百毫秒。这段时间 input 零出边，发布给 SFU
 *   的轨道是**全程静音**的 —— 对端听到的是长时间静音，不是「一瞬间」。
 *   现在：新节点在旧链路照常出声的情况下建好，再在同一个同步块里一次改完接线。
 *
 * 调用方注意：`input.disconnect()` 是无差别的，会连带断开挂在 input 上的分析器，
 * 补偿分析器必须在返回值之后再挂。
 */
export async function attachDenoise(
  input: AudioNode,
  destination: AudioNode,
  engine: DenoiseEngine,
): Promise<AudioNode> {
  const previous = activeNode;

  // ---- 关闭：不需要异步，直接同步改接线 ----
  if (engine === 'off') {
    rewire(input, destination, null);
    destroyNode(previous);
    activeNode = null;
    activeEngine = 'off';
    return input;
  }

  // 预检采样率：worklet 内部对不支持的采样率会直接 throw 且【无法从外部感知】，
  // 结果是一条永远静音的轨道被发布出去（表现为「刚进去没声」）。
  const rate = input.context.sampleRate;
  if (!supportedRates(engine).includes(rate)) {
    console.error(`[denoise] 采样率 ${rate}Hz 不受 ${engine} 支持，回退直连`);
    rewire(input, destination, null);
    destroyNode(previous);
    activeNode = null;
    activeEngine = 'off';
    return input;
  }

  // ---- 建：这一步是异步的，旧链路在此期间继续出声 ----
  const node = await createDenoiseNode(input.context as AudioContext, engine);

  if (!node) {
    console.error(`[denoise] ${engine} 初始化失败，回退直连`);
    rewire(input, destination, null);
    destroyNode(previous);
    activeNode = null;
    activeEngine = 'off';
    return input;
  }

  // ---- 切：全部同步完成，不存在静音窗 ----
  rewire(input, destination, node);
  destroyNode(previous);
  activeNode = node;
  activeEngine = engine;
  return node;
}

/**
 * 摘掉当前降噪节点（断开接线并释放 wasm 状态）。
 * 调用方负责把输入直接接回目的地（见 audio-mixer 的降级路径）。
 */
export function detachDenoise(): void {
  const node = activeNode;
  activeNode = null;
  activeEngine = 'off';
  destroyNode(node);
}

/** 从设置里读降噪引擎 */
export function denoiseEngineOf(settings: Settings | undefined): DenoiseEngine {
  return settings?.denoise?.engine ?? 'off';
}

// ============================================================
//  A/B 试听 + 客观量化：录 3 秒「原始 vs 降噪后」
// ============================================================

/** 量化结果：全部 dBFS，负值。底噪越低越好，语音损失越接近 0 越好 */
export interface DenoiseProbeMetrics {
  /** 原始音里的底噪电平 */
  rawNoiseDb: number;
  /** 降噪后的底噪电平 */
  denoisedNoiseDb: number;
  /** 底噪被压掉多少 dB（越大越好） */
  noiseReductionDb: number;
  /** 原始音里的语音电平 */
  rawSpeechDb: number;
  /** 降噪后的语音电平 */
  denoisedSpeechDb: number;
  /** 语音被削掉多少 dB（正数 = 人声变小了；接近 0 最好） */
  speechLossDb: number;
  /** 原始音里「语音 − 底噪」的间隔。太小说明这段录音几乎没说话，前面几个数字不可信 */
  rawSpeechToNoiseDb: number;
}

export interface DenoiseProbeResult {
  /** 采样到的原始音（未降噪） */
  rawBlob: Blob;
  /** 降噪后的音 */
  denoisedBlob: Blob | null;
  /** 实际使用的引擎 */
  engine: DenoiseEngine;
  /** 客观量化；降噪未生效或解码失败时为 null */
  metrics: DenoiseProbeMetrics | null;
}

/** 一段录音里「底噪」与「语音」两个电平（dBFS） */
interface Levels {
  noiseDb: number;
  speechDb: number;
}

const SILENCE_DB = -100;

/**
 * 用**分位数**估底噪与语音：3 秒里通常既有说话也有停顿，取平均会把两者混在
 * 一起。这里按 20ms 一帧算 RMS 后排序：
 *   - 第 10 百分位 → 底噪（最安静的那些帧）
 *   - 第 90 百分位 → 语音（最响的那些帧）
 * 粗糙，但对「有没有改善、改善多少」足够用，而且不依赖任何模型。
 */
function analyzeLevels(buf: AudioBuffer): Levels {
  const data = buf.getChannelData(0);
  const frameLen = Math.max(1, Math.round(buf.sampleRate * 0.02));
  const frames: number[] = [];

  for (let start = 0; start + frameLen <= data.length; start += frameLen) {
    let sum = 0;
    for (let i = 0; i < frameLen; i++) {
      const v = data[start + i]!;
      sum += v * v;
    }
    frames.push(Math.sqrt(sum / frameLen));
  }

  if (frames.length < 5) return { noiseDb: SILENCE_DB, speechDb: SILENCE_DB };

  frames.sort((a, b) => a - b);
  const at = (q: number) =>
    Math.max(frames[Math.min(frames.length - 1, Math.floor(q * frames.length))]!, 1e-7);
  return { noiseDb: 20 * Math.log10(at(0.1)), speechDb: 20 * Math.log10(at(0.9)) };
}

async function decodeLevels(ctx: AudioContext, blob: Blob): Promise<Levels | null> {
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return analyzeLevels(buf);
  } catch {
    return null;
  }
}

function buildMetrics(raw: Levels, denoised: Levels): DenoiseProbeMetrics {
  return {
    rawNoiseDb: raw.noiseDb,
    denoisedNoiseDb: denoised.noiseDb,
    noiseReductionDb: raw.noiseDb - denoised.noiseDb,
    rawSpeechDb: raw.speechDb,
    denoisedSpeechDb: denoised.speechDb,
    speechLossDb: raw.speechDb - denoised.speechDb,
    rawSpeechToNoiseDb: raw.speechDb - raw.noiseDb,
  };
}

/**
 * 采集 countSeconds 秒的麦克风，同时录下「原始」与「降噪后」两路。
 * 降噪关（或初始化失败）时 denoisedBlob 为 null，只返回原始音。
 *
 * ⚠️ 采集参数必须和真实房间一致（同一份 MicInputPrefs）：否则用户试听的是
 * 一条「房间外」的链路，听到的差别和实际发出去的并不是一回事。原实现在这里
 * 用了 autoGainControl: false，就是这样一处不一致。
 */
export async function probeDenoise(opts: {
  seconds?: number;
  engine: DenoiseEngine;
  input: MicInputPrefs;
  /** 采集设备（与房间里保持一致；不传则用系统默认） */
  deviceId?: string;
  onCountdown?: (remaining: number) => void;
}): Promise<DenoiseProbeResult> {
  const { engine, input, onCountdown, deviceId } = opts;
  const countSeconds = opts.seconds ?? 3;

  // 与房间、试麦共用同一份约束（sfu-session 的 micAudioConstraints）
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micAudioConstraints(input, deviceId),
    video: false,
  });

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
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
    let denoisedNode: DenoiseHandle | null = null;
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

    // 量化：必须在关闭 ctx 之前解码
    let metrics: DenoiseProbeMetrics | null = null;
    if (denoisedBlob) {
      const [rawLevels, denoisedLevels] = await Promise.all([
        decodeLevels(ctx, rawBlob),
        decodeLevels(ctx, denoisedBlob),
      ]);
      if (rawLevels && denoisedLevels) metrics = buildMetrics(rawLevels, denoisedLevels);
    }

    source.disconnect();
    destroyNode(denoisedNode);
    await ctx.close();
    ctx = null;

    return { rawBlob, denoisedBlob, engine: denoisedBlob ? engine : 'off', metrics };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    if (ctx) void ctx.close().catch(() => undefined);
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
