/**
 * DFN3 降噪引擎的主线程装配层。
 *
 * 职责：把三样东西接成一个可用的 AudioNode ——
 *   1. **AudioWorklet**（音频线程，跑 `dfn3-worklet.mjs`）
 *   2. **Web Worker**（推理线程，跑 `inference-worker.mjs`）
 *   3. **两个 SharedArrayBuffer**（它们之间的音频通道）
 *
 * 设计要点：
 *
 * 1. **必须有 COOP/COEP 才能用 SharedArrayBuffer。** 缺任何一个头，
 *    `crossOriginIsolated` 就是 false，构造会抛。这里显式检测并给出可操作的
 *    错误信息，而不是让它在深层报一个难懂的错。
 *
 * 2. **模型与运行时延迟加载。** 约 24MB（ORT wasm 10.7MB + 模型 12.9MB），
 *    不能拖慢进房。加载期间音频走直通（worklet 里已处理），不会出现静音。
 *
 * 3. **失败必须可回退。** 返回 null 表示不可用，调用方按现有约定
 *    （`attachDenoise` 的 fellBack 分支）回退到原始麦克风或更轻的引擎。
 */

export const FRAME_SIZE = 512;
export const RENDER_QUANTUM = 128;

/** 资产默认位置（放在 public/dfn3/ 下） */
const DEFAULT_PATHS = {
  workletModule: '/dfn3/dfn3-worklet.mjs',
  worker: '/dfn3/inference-worker.mjs',
  model: '/dfn3/denoiser_model.onnx',
  states: '/dfn3/initial_states.npz',
  ortWasmBase: '/dfn3/ort/',
} as const;

type AssetPaths = typeof DEFAULT_PATHS;

/** 环形缓冲容量（样本）。32 帧 ≈ 341ms，足以吸收主线程卡顿 */
const RING_FRAMES = 32;

export interface Dfn3Stats {
  framesFed: number;
  underruns: number;
  phase: string;
}

/**
 * DFN3 句柄：**本身就是 AudioNode**，另外挂了 dispose / stats。
 *
 * 为什么让句柄继承 AudioNode 而不是包一层：整条降噪链路
 * （attachDenoise / rewire / 补偿分析器 / destroyNode）都是对 AudioNode 操作的。
 * 如果这里返回一个包装对象，那些地方全都要分叉判断引擎类型 —— 改动面会大得多，
 * 也更容易漏掉某条清理路径。让句柄即节点，下游一行都不用改。
 */
export type Dfn3Handle = AudioWorkletNode & {
  /** 关闭：停 worker、断接线 */
  dispose: () => void;
  /** 运行时统计（欠载次数是判断要不要降级的关键指标） */
  stats: () => Dfn3Stats;
};

export interface Dfn3Options {
  /** 覆盖默认资产路径 */
  paths?: Partial<AssetPaths>;
  /** ONNX Runtime 执行器，默认 ['wasm'] */
  executionProviders?: string[];
  /** 首次欠载（推理跟不上）时回调 —— 调用方据此降级 */
  onUnderrun?: (info: { underruns: number }) => void;
  /** 加载进度回调（模型较大，给用户反馈很重要） */
  onProgress?: (stage: string) => void;
}

/** worklet / worker 回传的消息（只声明我们用到的字段） */
interface WorkerMessage {
  type?: string;
  message?: string;
  framesFed?: number;
  underruns?: number;
  phase?: string;
}

/** SharedArrayBuffer 头部字节数（与 client/dfn3/ring-buffer.mjs 保持一致） */
const HEADER_BYTES = 16;

/**
 * 创建 DFN3 降噪节点。
 *
 * @returns 成功返回句柄；环境不支持或加载失败返回 null（调用方回退）
 */
export async function createDfn3Node(
  ctx: AudioContext,
  options: Dfn3Options = {},
): Promise<Dfn3Handle | null> {
  const paths: AssetPaths = { ...DEFAULT_PATHS, ...(options.paths ?? {}) };
  const report = options.onProgress ?? ((): void => undefined);

  // ---- 前置检查：SharedArrayBuffer 需要跨源隔离 ----
  const support = dfn3Supported();
  if (!support.ok) {
    console.error(
      `[dfn3] 当前环境不可用：${support.reason}\n` +
        '  若原因是缺 COOP/COEP，请在响应头加上：\n' +
        '    Cross-Origin-Opener-Policy: same-origin\n' +
        '    Cross-Origin-Embedder-Policy: require-corp',
    );
    return null;
  }

  // ---- 采样率检查：模型硬约束 48kHz ----
  if (ctx.sampleRate !== 48000) {
    console.error(`[dfn3] 模型要求 48kHz，当前 AudioContext 是 ${ctx.sampleRate}Hz`);
    return null;
  }

  let worker: Worker | null = null;
  let node: AudioWorkletNode | null = null;

  try {
    report('加载 worklet 模块');
    await ctx.audioWorklet.addModule(paths.workletModule);

    report('启动推理线程');
    worker = new Worker(paths.worker, { type: 'module' });

    // SharedArrayBuffer 通道（头部 + 数据）
    const sabIn = new SharedArrayBuffer(HEADER_BYTES + RING_FRAMES * FRAME_SIZE * 4);
    const sabOut = new SharedArrayBuffer(HEADER_BYTES + RING_FRAMES * FRAME_SIZE * 4);

    // 初始化 worker 并等它就绪（模型下载在这里发生）
    report('加载模型（约 13MB，首次较慢）');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('推理线程启动超时（120s）')), 120_000);
      const onMessage = (e: MessageEvent<WorkerMessage>): void => {
        const msg = e.data;
        if (msg?.type === 'ready') {
          clearTimeout(timer);
          worker?.removeEventListener('message', onMessage as EventListener);
          resolve();
        } else if (msg?.type === 'error') {
          clearTimeout(timer);
          worker?.removeEventListener('message', onMessage as EventListener);
          reject(new Error(msg.message ?? '推理线程初始化失败'));
        }
      };
      worker?.addEventListener('message', onMessage as EventListener);
      worker?.postMessage({
        type: 'init',
        sabIn,
        sabOut,
        modelUrl: paths.model,
        statesUrl: paths.states,
        ortWasmBase: paths.ortWasmBase,
        executionProviders: options.executionProviders,
      });
    });

    report('接入音频链路');
    node = new AudioWorkletNode(ctx, 'cf-dfn3', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });

    // 把两个缓冲交给 worklet
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worklet 初始化超时')), 10_000);
      const onMessage = (e: MessageEvent<WorkerMessage>): void => {
        const msg = e.data;
        if (msg?.type === 'ready') {
          clearTimeout(timer);
          node?.port.removeEventListener('message', onMessage as EventListener);
          resolve();
        } else if (msg?.type === 'error') {
          clearTimeout(timer);
          node?.port.removeEventListener('message', onMessage as EventListener);
          reject(new Error(msg.message ?? 'worklet 初始化失败'));
        }
      };
      node?.port.addEventListener('message', onMessage as EventListener);
      node?.port.start();
      node?.port.postMessage({ type: 'init', sabIn, sabOut, frameSize: FRAME_SIZE });
    });

    // 运行时消息：欠载上报与统计
    let latest: Dfn3Stats = { framesFed: 0, underruns: 0, phase: 'booting' };
    node.port.onmessage = (e: MessageEvent<WorkerMessage>): void => {
      const msg = e.data;
      if (msg?.type === 'stats') {
        latest = {
          framesFed: msg.framesFed ?? 0,
          underruns: msg.underruns ?? 0,
          phase: msg.phase ?? 'unknown',
        };
      } else if (msg?.type === 'underrun') {
        const count = msg.underruns ?? 0;
        console.warn(`[dfn3] 推理跟不上（欠载 ${count} 次），音质会退化`);
        options.onUnderrun?.({ underruns: count });
      }
    };

    report('就绪');
    const created = node;
    const createdWorker = worker;

    // 把 dispose / stats 挂到节点自身上 —— 见 Dfn3Handle 的注释
    const handle = created as Dfn3Handle;
    handle.dispose = () => {
      try {
        created.port.postMessage({ type: 'stop' });
      } catch {
        /* 已关闭 */
      }
      try {
        created.disconnect();
      } catch {
        /* 没有出边时 disconnect 会抛，属正常 */
      }
      createdWorker.terminate();
    };
    handle.stats = () => ({ ...latest });
    return handle;
  } catch (err) {
    console.error('[dfn3] 初始化失败，回退', err);
    try {
      node?.disconnect();
    } catch {
      /* ignore */
    }
    worker?.terminate();
    return null;
  }
}

/**
 * 该环境是否具备运行 DFN3 的条件（不做实际加载）。
 * 设置面板用它决定要不要把 DFN3 显示为可选。
 */
export function dfn3Supported(): { ok: boolean; reason?: string } {
  if (typeof SharedArrayBuffer === 'undefined') {
    return { ok: false, reason: '浏览器不支持 SharedArrayBuffer' };
  }
  if (!globalThis.crossOriginIsolated) {
    return { ok: false, reason: '缺少 COOP/COEP 响应头（未跨源隔离）' };
  }
  if (typeof AudioWorkletNode === 'undefined') {
    return { ok: false, reason: '浏览器不支持 AudioWorklet' };
  }
  return { ok: true };
}
