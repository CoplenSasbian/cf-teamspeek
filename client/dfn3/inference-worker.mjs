/**
 * DFN3 推理线程。
 *
 * 同一份代码跑在两个环境：
 *   - **Node**（`worker_threads`）：用于验证线程协议本身；
 *   - **浏览器**（`Worker`）：真实部署路径。
 *
 * 差异只有三处，都集中在文件顶部的适配里：
 *   1. 怎么拿到 SharedArrayBuffer（workerData vs postMessage）；
 *   2. 怎么加载 onnxruntime（onnxruntime-node vs onnxruntime-web）；
 *   3. 怎么取模型二进制（文件系统 vs fetch）。
 * 其余线程逻辑**完全相同**，所以 Node 里验证过的部分可以直接信任。
 *
 * 协议：
 *   主线程 → 这里：{ type: 'init', sabIn, sabOut, modelUrl?, ortWasmBase? }
 *                   { type: 'close' }
 *   这里 → 主线程：{ type: 'ready', frameSize, sampleRate }
 *                   { type: 'stats', frames, avgInferMs }
 *                   { type: 'error', message }
 *
 * 数据流：inputRing → 逐帧推理 → outputRing。推理与音频线程解耦，
 * 音频线程永不被阻塞（这是把它放进 worker 的全部理由）。
 */

import { RingBuffer } from './ring-buffer.mjs';

const FRAME = 512;
const SAMPLE_RATE = 48000;

// ------------------------------------------------------------
//  环境适配
// ------------------------------------------------------------

const isNode = typeof process !== 'undefined' && process.versions?.node != null;

/** 统一的 postMessage（Node 的 parentPort 与浏览器的 self 语义一致） */
async function getPort() {
  if (isNode) {
    const { parentPort } = await import('node:worker_threads');
    return {
      post: (msg) => parentPort.postMessage(msg),
      onMessage: (handler) => parentPort.on('message', handler),
    };
  }
  return {
    post: (msg) => self.postMessage(msg),
    onMessage: (handler) => self.addEventListener('message', (e) => handler(e.data)),
  };
}

/**
 * 加载 onnxruntime。
 *
 * Node 用 npm 包；浏览器**不能** `import('onnxruntime-web')` —— 这个 worker 是
 * 从 `/dfn3/` 以静态文件形式提供的，没有 node_modules 也没有裸模块解析。
 * 所以浏览器路径改为**从我们准备好的目录动态 import** 那个 ESM 入口
 * （`prepare_web_assets.py` 会把 ort 的 js + wasm 放到 `public/dfn3/ort/`）。
 *
 * 同时把 `ort.env.wasm.wasmPaths` 指向同一目录，否则 ORT 会去默认的
 * CDN/相对路径找 .wasm，在 CSP 严格或离线场景下会失败。
 */
async function loadOrt(wasmBase) {
  if (isNode) return import('onnxruntime-node');

  const base = wasmBase || '/dfn3/ort/';
  const url = `${base}ort.min.js`;

  // 优先直接用全局（如果页面已经用 <script> 加载过）
  if (typeof self !== 'undefined' && self.ort?.InferenceSession) {
    self.ort.env.wasm.wasmPaths = base;
    return self.ort;
  }

  // 动态 import 我们准备好的 ESM 入口
  const mod = await import(/* @vite-ignore */ `${url}`);
  const ort = mod.default ?? mod;
  if (!ort?.InferenceSession) {
    throw new Error(`从 ${url} 加载的模块里没有 InferenceSession`);
  }
  if (ort.env?.wasm) ort.env.wasm.wasmPaths = base;
  return ort;
}

async function loadModelBytes(url) {
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下载失败：${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ------------------------------------------------------------
//  npz（初始状态）解析 —— 与 js/dfn-stream.mjs 同一套逻辑，保持零依赖
// ------------------------------------------------------------

async function loadInitialStates(url) {
  const bytes = await loadModelBytes(url);
  const buf = isNode ? Buffer.from(bytes) : bytes;
  const view = new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);

  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = view;

  const readU32 = (o) => dv.getUint32(o, true);
  const readU16 = (o) => dv.getUint16(o, true);

  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65536; i--) {
    if (readU32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('initial_states 不是合法 zip');

  const count = readU16(eocd + 10);
  let offset = readU32(eocd + 16);
  const decoder = new TextDecoder();
  const states = {};

  for (let i = 0; i < count; i++) {
    if (readU32(offset) !== 0x02014b50) break;
    const nameLen = readU16(offset + 28);
    const extraLen = readU16(offset + 30);
    const commentLen = readU16(offset + 32);
    const localOffset = readU32(offset + 42);
    const name = decoder.decode(u8.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith('.npy')) continue;

    const lNameLen = readU16(localOffset + 26);
    const lExtraLen = readU16(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const headerLen = readU16(dataStart + 8);
    const header = decoder.decode(u8.subarray(dataStart + 10, dataStart + 10 + headerLen));
    const dataOffset = dataStart + 10 + headerLen;

    const shapeMatch = header.match(/'shape':\s*\(([^)]*)\)/);
    if (!shapeMatch) continue;
    const shape = shapeMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    const size = shape.reduce((a, b) => a * b, 1);

    const flat = new Float32Array(size);
    for (let k = 0; k < size; k++) flat[k] = dv.getFloat32(dataOffset + k * 4, true);
    states[name.replace(/\.npy$/, '')] = { data: flat, shape };
  }
  return states;
}

// ------------------------------------------------------------
//  主循环
// ------------------------------------------------------------

async function main() {
  const port = await getPort();

  let inRing = null;
  let outRing = null;
  let stats = { frames: 0, inferMs: 0 };

  port.onMessage(async (msg) => {
    if (msg?.type === 'close') {
      inRing?.close();
      process.exit?.(0);
      return;
    }

    if (msg?.type !== 'init') return;

    try {
      const ort = await loadOrt(msg.ortWasmBase);
      const modelBytes = await loadModelBytes(msg.modelUrl);
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: msg.executionProviders ?? ['wasm'],
        graphOptimizationLevel: 'all',
      });

      const initial = await loadInitialStates(msg.statesUrl);
      const inputNames = session.inputNames;
      const outputNames = session.outputNames;

      // 每个会话独立的状态（逐帧改写）
      const states = {};
      for (const [k, v] of Object.entries(initial)) {
        states[k] = { data: Float32Array.from(v.data), shape: v.shape };
      }

      inRing = new RingBuffer(msg.sabIn);
      outRing = new RingBuffer(msg.sabOut);

      port.post({ type: 'ready', frameSize: FRAME, sampleRate: SAMPLE_RATE });

      // 稳态推理循环：只要还有数据就继续。没有数据时**不忙等**，
      // 靠 Atomics.wait 让出 CPU，避免把一个核烧满（桌面端尤其明显）。
      for (;;) {
        if (!inRing.waitForData(FRAME, 50)) {
          if (inRing.closed && inRing.available < FRAME) break;
          continue;
        }

        const frame = inRing.read(FRAME);
        if (frame.length < FRAME) continue;

        const feeds = {};
        feeds[inputNames[0]] = new ort.Tensor('float32', frame, [FRAME]);
        for (let i = 1; i < inputNames.length; i++) {
          const st = states[inputNames[i]];
          feeds[inputNames[i]] = new ort.Tensor('float32', st.data, st.shape);
        }

        const t0 = nowMs();
        const results = await session.run(feeds);
        stats.inferMs += nowMs() - t0;
        stats.frames += 1;

        const audio = results[outputNames[0]].data;
        for (let i = 1; i < inputNames.length; i++) {
          const value = results[outputNames[i]];
          if (!value) continue;
          states[inputNames[i]].data = Float32Array.from(value.data);
          states[inputNames[i]].shape = value.dims;
        }

        // 输出若满了就丢弃并计数 —— 宁可丢帧也不能阻塞推理循环
        const written = outRing.write(audio instanceof Float32Array ? audio : Float32Array.from(audio));
        if (written < FRAME) stats.dropped = (stats.dropped ?? 0) + (FRAME - written);

        if (stats.frames % 100 === 0) {
          port.post({
            type: 'stats',
            frames: stats.frames,
            avgInferMs: stats.inferMs / stats.frames,
            dropped: stats.dropped ?? 0,
          });
        }
      }

      outRing.close();
      port.post({ type: 'stats', frames: stats.frames, avgInferMs: stats.inferMs / Math.max(stats.frames, 1), done: true });
    } catch (err) {
      port.post({ type: 'error', message: err?.message ?? String(err), stack: err?.stack });
    }
  });
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

main();
