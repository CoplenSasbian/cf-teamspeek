/**
 * 线程架构的一致性核验：把「总时间」拆开，确认没有隐藏的阻塞或丢弃。
 *
 * 起因：测试台第一版把 4 秒的活报成了 30 秒（drain 循环里反复加监听器），
 * 而 worker 自报的单帧推理是 2.2ms —— 两个数字互相矛盾。
 * 这种矛盾如果不查清，就会拿一个错误的前提去做后续决策。
 *
 * 这个脚本验算：总时间 ≈ 帧数 × 单帧推理 + 环形缓冲/调度开销。
 * 若两者差距远大于预期开销，说明还有阻塞点没找到。
 *
 * 用法：
 *   node js/check-threading-overhead.mjs
 */

import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RingBuffer } from '../../../client/dfn3/ring-buffer.mjs';
import { loadModel, FRAME_SIZE, SAMPLE_RATE } from './dfn-stream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MODEL_DIR = path.join(ROOT, 'models');
const WORKER = path.join(ROOT, '..', '..', 'client', 'dfn3', 'inference-worker.mjs');

function readWavSamples(buffer) {
  const buf = Buffer.from(buffer);
  let off = 12;
  let data = null;
  let sampleRate = 48000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(off + 8);
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off = off + 8 + size + (size % 2);
  }
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return { samples: out, sampleRate };
}

function resampleLinear(x, srcRate, dstRate) {
  if (srcRate === dstRate) return x;
  const nOut = Math.round((x.length * dstRate) / srcRate);
  const out = new Float32Array(nOut);
  const ratio = (x.length - 1) / Math.max(nOut - 1, 1);
  for (let i = 0; i < nOut; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, x.length - 1);
    const t = pos - i0;
    out[i] = x[i0] * (1 - t) + x[i1] * t;
  }
  return out;
}

async function main() {
  const wav = readWavSamples(await readFile(path.join(ROOT, 'real', 'harvard_m1.wav')));
  const speech = resampleLinear(wav.samples, wav.sampleRate, SAMPLE_RATE);
  const seconds = 20;
  const n = Math.min(speech.length, seconds * SAMPLE_RATE);
  const input = new Float32Array(n - (n % FRAME_SIZE));
  {
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += speech[i] * speech[i];
    const gain = Math.pow(10, -26 / 20) / Math.sqrt(sum / input.length);
    for (let i = 0; i < input.length; i++) input[i] = speech[i] * gain;
  }
  const audioMs = (input.length / SAMPLE_RATE) * 1000;
  const totalFrames = input.length / FRAME_SIZE;
  console.log(`输入 ${(audioMs / 1000).toFixed(1)}s = ${totalFrames} 帧\n`);

  // ---- A：参考路径（同线程，无限速喂入）----
  const model = await loadModel();
  const s = model.newStream();
  const tA = performance.now();
  const directOut = await s.processAll(input);
  const msA = performance.now() - tA;
  console.log(`[A] 同步直接调用        ${msA.toFixed(0)}ms   RTF ${(msA / audioMs).toFixed(3)}   单帧 ${(msA / totalFrames * 1000).toFixed(0)}µs`);

  // ---- B：线程路径（不限速喂入，尽量喂满）----
  const sabIn = RingBuffer.allocate(FRAME_SIZE * 128);
  const sabOut = RingBuffer.allocate(FRAME_SIZE * 128);
  const inRing = new RingBuffer(sabIn, { producer: true });
  const outRing = new RingBuffer(sabOut);
  const worker = new Worker(WORKER);

  const finalStats = new Promise((resolve) => {
    worker.on('message', (msg) => {
      if (msg.type === 'ready') worker.postMessage({ type: 'go' });
      if (msg.type === 'stats' && msg.done) resolve(msg);
      if (msg.type === 'error') resolve({ error: msg.message });
    });
  });

  worker.postMessage({
    type: 'init',
    sabIn,
    sabOut,
    modelUrl: path.join(MODEL_DIR, 'denoiser_model.onnx'),
    statesUrl: path.join(MODEL_DIR, 'initial_states.npz'),
    executionProviders: ['cpu'],
  });

  // 等就绪：简单轮询 inRing 是否开始被消费
  await new Promise((r) => setTimeout(r, 1500));

  const tB = performance.now();
  let fed = 0;
  let outTotal = 0;
  let blocked = 0;
  while (fed < input.length) {
    const wrote = inRing.write(input.subarray(fed, Math.min(fed + 4096, input.length)));
    if (wrote === 0) {
      blocked += 1;
      await new Promise((r) => setImmediate(r));
      const avail = outRing.available;
      if (avail > 0) outTotal += outRing.read(avail - (avail % FRAME_SIZE)).length;
      continue;
    }
    fed += wrote;
    const avail = outRing.available;
    if (avail >= FRAME_SIZE) outTotal += outRing.read(avail - (avail % FRAME_SIZE)).length;
  }
  inRing.close();

  const stats = await finalStats;
  const tBend = performance.now();
  // 把输出环里的剩量读干净（worker 结束后可能还留着不足一帧的尾巴）
  while (outRing.available > 0) {
    const got = outRing.read(outRing.available);
    if (got.length === 0) break;
    outTotal += got.length;
  }
  const msB = tBend - tB;

  console.log(`[B] 线程路径（满载喂入） ${msB.toFixed(0)}ms   RTF ${(msB / audioMs).toFixed(3)}   阻塞次数 ${blocked}`);
  if (stats.error) console.log(`    worker 错误：${stats.error}`);
  else console.log(`    worker 自报：${stats.frames} 帧，平均推理 ${stats.avgInferMs?.toFixed(2)}ms，丢弃 ${stats.dropped ?? 0} 样本`);

  // ---- 核验 ----
  console.log(`\n=== 核验 ===`);
  const expectedInfer = (stats.avgInferMs ?? 0) * (stats.frames ?? 0);
  const overhead = msB - expectedInfer;
  // 尾部容差：worker 在收到 close 后可能来不及处理最后一帧，
  // 所以允许差 1 帧。真正的错误是"差很多"或"多出来"。
  const tailDiff = Math.abs(outTotal - input.length);
  const countOk = tailDiff <= FRAME_SIZE;
  console.log(`  预期纯推理时间 ${expectedInfer.toFixed(0)}ms（${stats.frames} 帧 × ${stats.avgInferMs?.toFixed(2)}ms）`);
  console.log(`  实际墙钟       ${msB.toFixed(0)}ms`);
  console.log(`  差额（调度+缓冲）${overhead.toFixed(0)}ms  = 单帧 ${(overhead / totalFrames * 1000).toFixed(0)}µs`);
  console.log(`  输出样本 ${outTotal} / 输入 ${input.length}（差 ${outTotal - input.length}，容差 ±${FRAME_SIZE}）  ${countOk ? '✓' : '✗'}`);

  if (overhead > msB * 0.5) {
    console.log('\n  ⚠️ 开销占比过高 —— 线程架构本身可能有瓶颈，需进一步查');
  } else {
    console.log('\n  ✓ 开销占比合理 —— 线程架构本身不是瓶颈，成本主要就是推理');
  }

  // ---- 线程路径 vs 参考路径 ----
  console.log(`\n  参考路径单帧 ${(msA / totalFrames * 1000).toFixed(0)}µs vs 线程路径单帧 ${(msB / totalFrames * 1000).toFixed(0)}µs`);
  console.log(`  → 线程化带来的额外开销约 ${((msB - msA) / msA * 100).toFixed(0)}%`);

  await worker.terminate();
  process.exit(0);
}

main().catch((err) => {
  console.error('失败：', err);
  process.exit(1);
});
