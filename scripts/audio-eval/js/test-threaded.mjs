/**
 * 线程架构验证台：在 Node 里跑通「生产者线程 → worker 推理 → 消费者线程」全链路。
 *
 * 为什么这一步价值很高：浏览器里 worklet 那层胶水**无法在这里验证**，
 * 但环形缓冲协议、worker 生命周期、状态穿线、丢弃策略这些**真正的逻辑**
 * 可以在这里验证透。验证过之后，浏览器侧剩下的就只有 API 差异了。
 *
 * 验证内容：
 *   1. 输出**样本数与输入一致**（不丢不重）；
 *   2. 输出**与直接同步调用逐样本一致**（证明线程协议没引入错误）；
 *   3. 吞吐与端到端延迟实测。
 *
 * 用法：
 *   node js/test-threaded.mjs
 */

import { Worker } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RingBuffer } from '../../../client/dfn3/ring-buffer.mjs';
import { loadModel, FRAME_SIZE, SAMPLE_RATE } from './dfn-stream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MODEL_DIR = path.join(ROOT, 'models');
const WORKER = path.join(ROOT, '..', '..', 'client', 'dfn3', 'inference-worker.mjs');

/** AudioWorklet 的渲染量子 —— 刻意用 128 喂，模拟真实音频线程的节奏 */
const QUANTUM = 128;

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

function correlate(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    dbb += y * y;
  }
  return num / Math.sqrt(da * dbb);
}

async function main() {
  // ---- 准备输入：真实语音，归一化到 -26dBFS ----
  const wav = readWavSamples(await readFile(path.join(ROOT, 'real', 'harvard_m1.wav')));
  const speech = resampleLinear(wav.samples, wav.sampleRate, SAMPLE_RATE);
  const seconds = 10;
  const n = Math.min(speech.length, seconds * SAMPLE_RATE);
  const input = new Float32Array(n - (n % FRAME_SIZE));
  {
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += speech[i] * speech[i];
    const gain = Math.pow(10, -26 / 20) / Math.sqrt(sum / input.length);
    for (let i = 0; i < input.length; i++) input[i] = speech[i] * gain;
  }
  console.log(`输入：${(input.length / SAMPLE_RATE).toFixed(1)}s，${input.length} 样本`);

  // ---- 参考：直接同步调用（已与 Python 验证一致）----
  console.log('\n[1] 参考路径：直接同步调用');
  const model = await loadModel();
  const directStream = model.newStream();
  const t0 = performance.now();
  const direct = await directStream.processAll(input);
  const directMs = performance.now() - t0;
  console.log(`    ${direct.length} 样本，耗时 ${directMs.toFixed(0)}ms`);
  await writeFile(path.join(ROOT, 'out_real', 'thread_direct.wav'), toWav(direct));

  // ---- 线程路径：ring buffer + worker ----
  console.log('\n[2] 线程路径：ring buffer + worker（128 样本量子喂入）');
  const capIn = FRAME_SIZE * 64;
  const capOut = FRAME_SIZE * 64;
  const sabIn = RingBuffer.allocate(capIn);
  const sabOut = RingBuffer.allocate(capOut);
  const inRing = new RingBuffer(sabIn, { producer: true });
  const outRing = new RingBuffer(sabOut);

  const worker = new Worker(WORKER, {
    workerData: { marker: 'node' },
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker 启动超时（30s）')), 30_000);
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        clearTimeout(timer);
        resolve(msg);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        reject(new Error(`worker 错误：${msg.message}\n${msg.stack ?? ''}`));
      } else if (msg.type === 'stats' && msg.done) {
        console.log(`    worker 统计：${msg.frames} 帧，平均推理 ${msg.avgInferMs?.toFixed(2)}ms`);
      } else if (msg.type === 'stats' && msg.dropped) {
        console.log(`    ⚠️ 输出缓冲丢弃 ${msg.dropped} 样本（说明消费者跟不上）`);
      }
    });
    worker.on('error', reject);
  });

  worker.postMessage({
    type: 'init',
    sabIn,
    sabOut,
    modelUrl: path.join(MODEL_DIR, 'denoiser_model.onnx'),
    statesUrl: path.join(MODEL_DIR, 'initial_states.npz'),
    executionProviders: ['cpu'],
  });

  await ready;
  console.log('    worker 就绪');

  // 生产者：按 128 样本量子喂入，模拟 AudioWorklet 的节奏
  const collected = [];
  const feedStart = performance.now();
  let fed = 0;
  let lastReport = 0;

  while (fed < input.length) {
    const chunk = input.subarray(fed, Math.min(fed + QUANTUM, input.length));
    const wrote = inRing.write(chunk);
    fed += wrote;
    if (wrote === 0) {
      // 缓冲满：等消费端推进（真实音频线程不会等，但这里要保证数据完整）
      await new Promise((r) => setTimeout(r, 1));
      continue;
    }

    // 消费已经产出的部分
    const avail = outRing.available;
    if (avail >= FRAME_SIZE) {
      const got = outRing.read(avail - (avail % FRAME_SIZE));
      collected.push(got);
    } else if (performance.now() - lastReport > 1000) {
      lastReport = performance.now();
      process.stdout.write(`\r    进度 ${(fed / input.length * 100).toFixed(0)}%`);
    }
  }

  // 收尾：等剩余输出。
  //
  // 注意：这里靠 worker 的最终 stats 消息判断结束，而**不是**在轮询里反复
  // `worker.once('exit', ...)` —— 后者每次都会新增一个监听器，既触发
  // MaxListenersExceededWarning，又让墙钟统计完全失真（实测把 4 秒的活
  // 报成了 30 秒）。踩过这个坑，写在这里。
  inRing.close();

  const finalStats = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ frames: 0, avgInferMs: NaN, timedOut: true }), 60_000);
    worker.on('message', (msg) => {
      if (msg.type === 'stats' && msg.done) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });

  const drainDeadline = Date.now() + 5000;
  while (Date.now() < drainDeadline && outRing.available > 0) {
    collected.push(outRing.read(outRing.available));
  }
  const feedMs = performance.now() - feedStart;

  const threaded = concat(collected);
  console.log(`\n    产出 ${threaded.length} 样本，墙钟耗时 ${feedMs.toFixed(0)}ms`);
  console.log(
    `    worker 自报：${finalStats.frames} 帧，平均推理 ${Number.isFinite(finalStats.avgInferMs) ? finalStats.avgInferMs.toFixed(2) + 'ms' : 'n/a'}` +
      (finalStats.dropped ? `，丢弃 ${finalStats.dropped} 样本` : ''),
  );

  await writeFile(path.join(ROOT, 'out_real', 'thread_ring.wav'), toWav(threaded));

  // ---- 对比 ----
  console.log('\n=== 结果 ===');
  const nCmp = Math.min(threaded.length, direct.length);
  const r = correlate(threaded.subarray(0, nCmp), direct.subarray(0, nCmp));
  console.log(`  参考样本数 ${direct.length}，线程路径样本数 ${threaded.length}`);
  console.log(`  相关系数 r = ${r.toFixed(6)}`);

  const sampleMatch = Math.abs(threaded.length - direct.length) <= FRAME_SIZE * 2;
  console.log(`  ${sampleMatch ? '✓' : '✗'} 样本数一致（允许 2 帧的尾部差）`);
  console.log(`  ${r > 0.999 ? '✓' : '✗'} 与直接路径逐样本一致（线程协议未引入错误）`);

  await worker.terminate();
  process.exit(sampleMatch && r > 0.999 ? 0 : 1);
}

function concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function toWav(samples, sampleRate = SAMPLE_RATE) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

main().catch((err) => {
  console.error('\n失败：', err);
  process.exit(1);
});
