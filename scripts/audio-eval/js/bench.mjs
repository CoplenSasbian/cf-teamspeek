/**
 * 在 Node 里跑 DFN3，回答两个问题：
 *   1. **质量**：JS 侧实现的输出，与 Python 参考实现的结论一致吗？（应当 r>0.9）
 *   2. **性能**：实时率是多少？—— 这决定「32ms 延迟能不能接受」值不值得。
 *
 * 之所以在 Node 里量性能：浏览器 worklet 的推理规模与之相同（同一份 ONNX、
 * 同样的逐帧调用），WASM SIMD 与原生 CPU EP 的性能差距通常在 1.5–3 倍内，
 * 足以判断可行性。真正的浏览器实测留到移植后。
 *
 * 用法：
 *   cd scripts/audio-eval
 *   node js/bench.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadModel, FRAME_SIZE, SAMPLE_RATE } from './dfn-stream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REAL_DIR = path.join(ROOT, 'real');
const OUT_DIR = path.join(ROOT, 'out_real');

// ------------------------------------------------------------
//  极简 WAV 读写（16-bit PCM 单声道）—— 与 Python 侧同一格式
// ------------------------------------------------------------

function readWav(buffer) {
  const buf = Buffer.from(buffer);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 RIFF/WAV');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');
  if (fmt.bits !== 16) throw new Error(`只支持 16-bit，收到 ${fmt.bits}`);

  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

function writeWav(samples, sampleRate) {  const n = samples.length;
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

// ------------------------------------------------------------
//  质量度量
// ------------------------------------------------------------

/** 线性插值重采样（与 Python 侧 tools/real_speech_check.py 同法，便于对齐） */
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

function db(x) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return 10 * Math.log10(Math.max(sum / x.length, 1e-20));
}

/** 在给定滞后下算相关系数 */
function corrAt(ref, test, lag) {
  const n = Math.min(ref.length, test.length);
  const a = lag >= 0 ? ref.subarray(0, n - lag) : ref.subarray(-lag, n);
  const b = lag >= 0 ? test.subarray(lag, n) : test.subarray(0, n + lag);
  const m = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < m; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= m;
  mb /= m;
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let i = 0; i < m; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    dbb += y * y;
  }
  const den = Math.sqrt(da * dbb);
  return den > 0 ? num / den : 0;
}

/** 搜索最佳延迟并返回 (lag, r) */
function bestLag(ref, test, maxLagMs = 60, sr = SAMPLE_RATE) {
  const maxLag = Math.round((maxLagMs / 1000) * sr);
  let best = { lag: 0, r: -2 };
  for (let lag = 0; lag <= maxLag; lag += 4) {
    const r = corrAt(ref, test, lag);
    if (r > best.r) best = { lag, r };
  }
  return best;
}

function siSdr(ref, test, lag) {
  const n = Math.min(ref.length, test.length);
  const a = lag >= 0 ? ref.subarray(0, n - lag) : ref.subarray(-lag, n);
  const b = lag >= 0 ? test.subarray(lag, n) : test.subarray(0, n + lag);
  const m = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < m; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= m;
  mb /= m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += y * x;
    den += x * x;
  }
  const alpha = den > 0 ? num / den : 0;
  let target = 0;
  let noise = 0;
  for (let i = 0; i < m; i++) {
    const t = alpha * (a[i] - ma);
    const e = b[i] - mb - t;
    target += t * t;
    noise += e * e;
  }
  return 10 * Math.log10(Math.max(target, 1e-20) / Math.max(noise, 1e-20));
}

// ------------------------------------------------------------

async function main() {
  console.log('加载模型…');
  const t0 = performance.now();
  const model = await loadModel();
  console.log(`  加载耗时 ${(performance.now() - t0).toFixed(0)}ms`);
  console.log(`  输入 ${model.inputNames.length} 个，输出 ${model.outputNames.length} 个`);
  console.log(`  状态张量：${Object.keys(model.initialStates).length} 个`);

  const stateBytes = Object.values(model.initialStates).reduce(
    (sum, s) => sum + s.data.byteLength,
    0,
  );
  console.log(`  每帧需复制的状态：${(stateBytes / 1024).toFixed(1)} KB`);

  const targets = ['harvard_m1.wav', 'harvard_m2.wav', 'harvard_f1.wav'];
  console.log(`\n${'文件'.padEnd(18)}${'时长'.padStart(8)}${'音频dBFS'.padStart(11)}${'输出dBFS'.padStart(11)}${'延迟'.padStart(9)}${'r'.padStart(8)}${'SI-SDR'.padStart(9)}`);
  console.log('-'.repeat(74));

  const reports = [];
  for (const name of targets) {
    let wav;
    try {
      wav = readWav(await readFile(path.join(REAL_DIR, name)));
    } catch (err) {
      console.log(`跳过 ${name}：${err.message}`);
      continue;
    }

    // 只取前 15 秒，够量指标也快
    const limit = Math.min(wav.samples.length, 15 * SAMPLE_RATE);
    const raw = wav.samples.subarray(0, limit - (limit % FRAME_SIZE));

    // ⚠️ 必须重采样到 48kHz。
    // 第一版忘了这一步，直接把 8kHz 的录音按 48kHz 喂给模型 ——
    // 结果是 r≈0.4 的垃圾输出，看起来像"状态穿线有 bug"，
    // 实际上状态逐帧与 Python 完全一致（见 js/dump-states.mjs 的对比）。
    // 教训：模型对采样率的假设是硬的，喂错采样率的表现和"模型坏了"一模一样。
    const resampled = resampleLinear(raw, wav.sampleRate, SAMPLE_RATE);

    // ⚠️ 还要归一化到与 Python 侧相同的电平（−26 dBFS）。
    // DeepFilterNet 内部的归一化状态对输入电平敏感，电平不对会判成噪声。
    // 这也说明**真实部署时必须做输入增益归一化**，否则换个麦克风就失效。
    const input = new Float32Array(resampled.length);
    {
      let sum = 0;
      for (let i = 0; i < resampled.length; i++) sum += resampled[i] * resampled[i];
      const rms = Math.sqrt(sum / resampled.length);
      const gain = Math.pow(10, -26 / 20) / Math.max(rms, 1e-9);
      for (let i = 0; i < resampled.length; i++) input[i] = resampled[i] * gain;
    }

    const stream = model.newStream();
    const start = performance.now();
    const out = await stream.processAll(input);
    const elapsedMs = performance.now() - start;

    const audioMs = (input.length / SAMPLE_RATE) * 1000;
    const rtf = elapsedMs / audioMs; // <1 表示比实时快
    const { lag, r } = bestLag(input, out);
    const sdr = siSdr(input, out, lag);

    console.log(
      `${name.padEnd(18)}${(audioMs / 1000).toFixed(1).padStart(7)}s` +
        `${db(input).toFixed(1).padStart(11)}${db(out).toFixed(1).padStart(11)}` +
        `${((lag / SAMPLE_RATE) * 1000).toFixed(1).padStart(8)}ms${r.toFixed(3).padStart(8)}${sdr.toFixed(1).padStart(9)}`,
    );

    reports.push({ name, rtf, elapsedMs, audioMs, r, sdr, frames: stream.frames });

    // 导出 WAV 供试听（Node 侧的实现与 Python 侧应当一致）
    await writeFile(
      path.join(OUT_DIR, `${name.replace(/\.wav$/, '')}__node_dfn3.wav`),
      writeWav(out, SAMPLE_RATE),
    );
  }

  if (reports.length) {
    const avgRtf = reports.reduce((s, x) => s + x.rtf, 0) / reports.length;
    console.log('\n=== 性能 ===');
    console.log(`  平均实时率 RTF = ${avgRtf.toFixed(3)}（${(1 / avgRtf).toFixed(1)}× 实时）`);
    console.log(`  单帧平均推理 ${((reports[0].elapsedMs / reports[0].frames) * 1000).toFixed(0)}µs`);
    console.log(`  单帧预算（10.67ms）= ${(10.67 * 1000).toFixed(0)}µs → 占用 ` +
      `${(((reports[0].elapsedMs / reports[0].frames) * 1000) / 10670 * 100).toFixed(1)}%`);

    console.log('\n=== 结论 ===');
    const worstR = Math.min(...reports.map((x) => x.r));
    if (worstR > 0.9) {
      console.log(`  ✓ JS 侧实现与 Python 侧一致（最低 r=${worstR.toFixed(3)}）—— 穿线逻辑正确`);
    } else {
      console.log(`  ✗ JS 侧输出与输入相关性不足（最低 r=${worstR.toFixed(3)}）—— 状态穿线有问题`);
    }
    if (avgRtf < 0.3) {
      console.log(`  ✓ 实时率充裕（RTF ${avgRtf.toFixed(3)}）—— 浏览器 WASM 即使慢 2–3 倍也够用`);
    } else if (avgRtf < 1) {
      console.log(`  ⚠️ 实时率偏紧（RTF ${avgRtf.toFixed(3)}）—— 浏览器 WASM 可能不够，需要 SIMD/多线程`);
    } else {
      console.log(`  ✗ 达不到实时（RTF ${avgRtf.toFixed(3)}）—— 浏览器内实时不可行`);
    }
    console.log(`\n  试听文件已写到 out_real/*__node_dfn3.wav`);
  }
}

main().catch((err) => {
  console.error('失败：', err);
  process.exit(1);
});
