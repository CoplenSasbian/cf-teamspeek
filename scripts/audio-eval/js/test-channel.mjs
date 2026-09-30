/**
 * DfnChannel（worklet 纯逻辑）的确定性验证。
 *
 * 为什么能用 Node 验证 worklet：`DfnChannel` 不碰任何 AudioWorklet 全局，
 * 只操作 RingBuffer 接口。所以可以在这里按 128 样本量子喂入、逐量子比对输出。
 *
 * 用**脚本化假推理端**而不是真 worker：这样每个量子都是确定性的，
 * 相位切换、欠载兜底这些边界能被精确复现。真 worker 的端到端验证在
 * `test-threaded.mjs` 里做（那里验的是线程协议）。
 *
 * 验证内容：
 *   1. **干信号延迟精确** —— 启动期输出 = 输入延迟 512 样本（不是近似）；
 *   2. **湿信号相位正确** —— 就绪后输出 = 模型结果，且与干信号时间轴一致；
 *   3. **欠载兜底** —— 模型供不上时输出干信号而不是空洞；
 *   4. **样本守恒** —— 每量子进 128 出 128，永不丢帧。
 *
 * 用法：node js/test-channel.mjs
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RingBuffer } from '../../../client/dfn3/ring-buffer.mjs';
import { DfnChannel, FRAME_SIZE, RENDER_QUANTUM } from '../../../client/dfn3/channel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
}

/** 内存版的 RingBuffer 替身：语义与真实实现一致，但便于注入受控数据 */
function makeRing(capacity) {
  const sab = RingBuffer.allocate(capacity);
  return new RingBuffer(sab);
}

async function main() {
  const NSAMPLES = RENDER_QUANTUM * 400; // 50 个整帧
  // 确定性输入：一段斜坡 + 正弦，便于逐样本比对
  const input = new Float32Array(NSAMPLES);
  for (let i = 0; i < NSAMPLES; i++) {
    input[i] = 0.3 * Math.sin((2 * Math.PI * i) / 97) + 0.0001 * i;
  }

  console.log('\n[1] 启动期：输出应为「输入延迟 512 样本」');
  {
    const inRing = makeRing(FRAME_SIZE * 32);
    const outRing = makeRing(FRAME_SIZE * 32);
    const ch = new DfnChannel({ inRing, outRing });

    // 只处理 4 个量子（512 样本），此时延迟线刚好填满
    const first = [];
    for (let q = 0; q < 4; q++) {
      first.push(ch.process(input.subarray(q * 128, (q + 1) * 128)));
    }
    const got = new Float32Array(512);
    first.forEach((b, i) => got.set(b, i * 128));

    // 前 512 样本应当全是 0（延迟线的初始内容），因为还没读到"512 样本前"的数据
    let allZero = true;
    for (let i = 0; i < 512; i++) if (got[i] !== 0) allZero = false;
    check('延迟线未填满时输出静音（不是输入本身）', allZero);

    // 第 5 个量子起，输出应当等于输入的第 0 个量子
    const q5 = ch.process(input.subarray(512, 640));
    let match = true;
    for (let i = 0; i < 128; i++) if (q5[i] !== input[i]) match = false;
    check('填满后输出 = 输入延迟 512 样本', match);
  }

  console.log('\n[2] 就绪后：输出应切换为模型结果');
  {
    const inRing = makeRing(FRAME_SIZE * 32);
    const outRing = makeRing(FRAME_SIZE * 32);
    const ch = new DfnChannel({ inRing, outRing });

    // 先把模型结果塞进输出环（模拟 worker 已产出 2 帧）
    const wet = new Float32Array(FRAME_SIZE * 2);
    for (let i = 0; i < wet.length; i++) wet[i] = 0.5; // 常量便于识别
    outRing.write(wet);

    const out = ch.process(input.subarray(0, 128));
    // 第一个量子会从干切湿并做交叉淡入，所以不能要求全 0.5；
    // 但第 2 个量子之后应当完全是湿信号
    const out2 = ch.process(input.subarray(128, 256));
    let allWet = true;
    for (let i = 0; i < 128; i++) if (Math.abs(out2[i] - 0.5) > 1e-6) allWet = false;
    check('切换后输出为模型结果', allWet, `首个量子样本[0]=${out[0].toFixed(4)}`);
    check('相位切换后 phase = wet', ch.phase === 'wet');
  }

  console.log('\n[3] 欠载兜底：模型供不上时必须输出干信号而不是空洞');
  {
    const inRing = makeRing(FRAME_SIZE * 32);
    const outRing = makeRing(FRAME_SIZE * 32);
    const ch = new DfnChannel({ inRing, outRing });

    // 一次性给足，进入 wet
    outRing.write(new Float32Array(FRAME_SIZE * 2).fill(0.5));
    ch.process(input.subarray(0, 128));
    ch.process(input.subarray(128, 256));
    ch.process(input.subarray(256, 384));
    ch.process(input.subarray(384, 512));
    ch.process(input.subarray(512, 640));

    // 现在把输出环清空，制造欠载
    outRing.read(outRing.available);
    const before = ch.stats.underruns;
    const out = ch.process(input.subarray(640, 768));
    check('欠载被计数', ch.stats.underruns > before, `underruns=${ch.stats.underruns}`);

    let nonZero = false;
    for (let i = 0; i < 128; i++) if (out[i] !== 0) nonZero = true;
    check('欠载时输出干信号（不是全零空洞）', nonZero);
  }

  console.log('\n[4] 样本守恒：每量子进 128 出 128');
  {
    const inRing = makeRing(FRAME_SIZE * 64);
    const outRing = makeRing(FRAME_SIZE * 64);
    const ch = new DfnChannel({ inRing, outRing });

    // 模拟推理端：每处理一帧就往输出环写一帧（延迟 1 帧）
    let total = 0;
    let okLen = true;
    for (let q = 0; q < 200; q++) {
      const out = ch.process(input.subarray(q * 128, (q + 1) * 128));
      if (out.length !== 128) okLen = false;
      total += out.length;

      // 把输入环里的整帧取出、原样写回输出环（模拟"模型"）
      while (inRing.available >= FRAME_SIZE) {
        const frame = inRing.read(FRAME_SIZE);
        outRing.write(frame);
      }
    }
    check('每个量子输出长度恒为 128', okLen);
    check('总输出样本数 = 总输入样本数', total === 200 * 128, `${total} vs ${200 * 128}`);
  }

  console.log('\n[5] 输入帧装配：128 样本量子正确拼成 512 样本帧');
  {
    const inRing = makeRing(FRAME_SIZE * 64);
    const outRing = makeRing(FRAME_SIZE * 64);
    const ch = new DfnChannel({ inRing, outRing });

    for (let q = 0; q < 4; q++) ch.process(input.subarray(q * 128, (q + 1) * 128));
    check('4 个量子后喂出 1 帧', ch.stats.framesFed === 1, `framesFed=${ch.stats.framesFed}`);
    const frame = inRing.read(FRAME_SIZE);
    let match = true;
    for (let i = 0; i < FRAME_SIZE; i++) if (frame[i] !== input[i]) match = false;
    check('帧内容与输入前 512 样本一致', match);
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('失败：', err);
  process.exit(1);
});
