/**
 * 单帧开销分解：推理 vs 状态拷贝 vs 张量构造。
 *
 * 为什么值得量：我先前把「每帧穿线 180KB 状态」标成「需要认真设计」，
 * 但那只是基于数量级的担心。实测才能知道它到底是主要成本还是可忽略 ——
 * 如果是可忽略的，浏览器侧唯一剩下的未知就只是 WASM 多线程语义（更可控）；
 * 如果它占了大头，那 worklet 的缓冲设计就必须围绕它优化。
 *
 * 用法：
 *   node js/bench-breakdown.mjs
 */

import { loadModel, FRAME_SIZE } from './dfn-stream.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const FRAMES = 300;

async function main() {
  const model = await loadModel();

  // 固定输入：一段归一化后的真人语音
  const wav = await readFile(path.join(ROOT, 'real', 'harvard_m1.wav'));
  let off = 12;
  let data = null;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'data') data = wav.subarray(off + 8, off + 8 + size);
    off = off + 8 + size + (size % 2);
  }
  const total = FRAMES * FRAME_SIZE;
  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    const one = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      one[i] = data.readInt16LE((f * FRAME_SIZE + i) * 2) / 32768;
    }
    frames.push(one);
  }

  // ---- 1. 纯推理（不做任何状态回填：状态保持初值）----
  {
    const stream = model.newStream();
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      await stream.sessionRunOnly(frames[f]);
    }
    const ms = performance.now() - t0;
    console.log(`纯推理（不回填状态）      ${(ms / FRAMES * 1000).toFixed(0).padStart(6)}µs/帧   总计 ${ms.toFixed(0)}ms`);
  }

  // ---- 2. 推理 + 状态回填（完整路径）----
  {
    const stream = model.newStream();
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      await stream.processFrame(frames[f]);
    }
    const ms = performance.now() - t0;
    console.log(`完整路径（推理+回填）     ${(ms / FRAMES * 1000).toFixed(0).padStart(6)}µs/帧   总计 ${ms.toFixed(0)}ms`);
  }

  // ---- 3. 状态拷贝本身的开销（不含推理）----
  {
    const stream = model.newStream();
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      for (const st of Object.values(stream.states)) {
        const copy = Float32Array.from(st.data);
        st.data = copy;
      }
    }
    const ms = performance.now() - t0;
    const bytes = Object.values(stream.states).reduce((s, x) => s + x.data.byteLength, 0);
    console.log(`仅状态拷贝（180KB/帧）    ${(ms / FRAMES * 1000).toFixed(0).padStart(6)}µs/帧   总计 ${ms.toFixed(0)}ms`);
    console.log(`                           → ${(bytes / 1024).toFixed(1)} KB/帧，` +
      `${((bytes / 1048576) * (48000 / FRAME_SIZE)).toFixed(1)} MB/s`);
  }

  // ---- 4. 每帧张量构造的开销 ----
  {
    const ort = await import('onnxruntime-node');
    const stream = model.newStream();
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      for (const st of Object.values(stream.states)) {
        // 触发张量构造路径（不 run）
        void new ort.Tensor('float32', st.data, st.shape);
      }
    }
    const ms = performance.now() - t0;
    console.log(`仅张量构造（12 个/帧）    ${(ms / FRAMES * 1000).toFixed(0).padStart(6)}µs/帧   总计 ${ms.toFixed(0)}ms`);
  }

  console.log(`\n单帧预算（512 样本 @48k）= ${(FRAME_SIZE / 48000 * 1000).toFixed(2)}ms = 10667µs`);
  console.log('读法：只要「完整路径」远低于预算，浏览器端就还有充足余量。');
}

main().catch((err) => {
  console.error('失败：', err);
  process.exit(1);
});
