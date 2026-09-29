/**
 * 语音门限 worklet 的离线测试。
 *
 *   npm run test:gate
 *
 * 为什么值得单独测：`public/voice-gate-worklet.js` 里有几条不变量是
 * 「改一行就静默失效、而且在浏览器里很难察觉」的 ——
 * 比如增益没精确落到 1（用户听到的音量变了）、或者前瞻把增益也一起延迟了
 * （等于没有前瞻，字头被削）。把它们钉成断言，比每次靠耳朵判断可靠。
 *
 * 实现方式：把 worklet 源码跑在 node:vm 里，补上 AudioWorkletProcessor、
 * registerProcessor、sampleRate 三个全局，不依赖浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKLET = path.join(ROOT, 'public', 'voice-gate-worklet.js');
const SR = 48000;
const LOOK = Math.round(0.004 * SR);

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

// ---------------- 装载 worklet ----------------
let Registered = null;
class FakeProcessor {
  constructor() {
    this.port = { postMessage() {}, onmessage: null };
  }
}
const sandbox = {
  AudioWorkletProcessor: FakeProcessor,
  sampleRate: SR,
  registerProcessor: (_name, cls) => {
    Registered = cls;
  },
  Math,
  Float32Array,
  console,
  Number,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(WORKLET, 'utf8'), sandbox, { filename: 'voice-gate-worklet.js' });
if (!Registered) throw new Error('worklet 没有调用 registerProcessor');

// ---------------- 工具 ----------------
function run(node, input, { thresholdDb = -45, enabled = true } = {}) {
  const out = new Float32Array(input.length);
  const params = { thresholdDb: [thresholdDb], enabled: [enabled ? 1 : 0] };
  let peakEnv = 0;
  for (let off = 0; off + 128 <= input.length; off += 128) {
    const chunk = input.subarray(off, off + 128);
    const o = [new Float32Array(128)];
    node.process([[chunk], [chunk]], [o], params);
    out.set(o[0], off);
    if (node.env > peakEnv) peakEnv = node.env;
  }
  return { out, peakEnv };
}
const dB = (v) => 20 * Math.log10(Math.max(v, 1e-12));
const peakOf = (a, from = 0) => {
  let p = 0;
  for (let i = from; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
};

/** 浊音：F0 及其低次谐波（能量集中在基频段，正是检测带通要看的） */
function voiced(n, amp = 0.2, f0 = 120) {
  const x = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 1; k <= 12; k++) s += Math.sin((2 * Math.PI * f0 * k * i) / SR) / k;
    x[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  for (let i = 0; i < n; i++) x[i] *= amp / peak;
  return x;
}
/** 键盘敲击：8ms 衰减正弦爆发，能量在中高频 */
function click(n, at = 0, amp = 0.4, ms = 8, freq = 3000) {
  const x = new Float32Array(n);
  const len = Math.round((ms / 1000) * SR);
  for (let i = 0; i < len && at + i < n; i++) {
    x[at + i] = amp * Math.exp(-i / (len / 4)) * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return x;
}

// ============================================================
console.log('\n[1] 关闭时：逐样本直通，幅度一点都不改');
{
  const sig = voiced(SR, 0.2);
  const { out } = run(new Registered(), sig, { enabled: false });
  let maxDiff = 0;
  for (let i = LOOK; i < sig.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - sig[i - LOOK]));
  check(maxDiff === 0, '输出与输入逐样本相同', `最大偏差=${maxDiff}`);
}

console.log('\n[2] 开门时：增益精确为 1（这是「不影响音量」的落地方式）');
{
  const sig = voiced(SR, 0.2);
  const { out } = run(new Registered(), sig, { enabled: true, thresholdDb: -45 });
  const from = LOOK + Math.round(0.2 * SR);
  let maxDiff = 0;
  for (let i = from; i < sig.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - sig[i - LOOK]));
  const rms = (a) => Math.sqrt([...a].reduce((s, v) => s + v * v, 0) / a.length);
  const ratio = rms(out.subarray(from)) / rms(sig.subarray(from - LOOK, sig.length - LOOK));
  check(maxDiff === 0, '说话时输出与输入逐样本相同', `最大偏差=${maxDiff}`);
  check(Math.abs(ratio - 1) < 1e-9, '输出/输入 RMS 比 = 1', `比值=${ratio.toFixed(12)}`);
}

console.log('\n[3] 不说话：关到 0');
{
  const { out, ...rest } = run(new Registered(), new Float32Array(SR), {
    enabled: true,
    thresholdDb: -45,
  });
  const tail = peakOf(out, Math.round(0.6 * SR));
  check(tail === 0, '静音段输出恒为 0', `尾部峰值=${tail}`);
}

console.log('\n[4] 检测支路的鉴别力：人声 vs 敲击');
{
  const rv = run(new Registered(), voiced(SR, 0.2), { enabled: false });
  const rc = run(new Registered(), click(SR, 0, 0.4), { enabled: false });
  const margin = dB(rv.peakEnv) - dB(rc.peakEnv);
  check(
    margin > 15,
    `鉴别余量 > 15dB（实测 ${margin.toFixed(1)}dB）`,
    `人声=${dB(rv.peakEnv).toFixed(1)}dB 敲击=${dB(rc.peakEnv).toFixed(1)}dB`,
  );
  console.log('     注：检测带通只看语音基频段（约 260Hz）。若改成高通/宽带检测，这里会退化 ——');
  console.log('     键盘敲击的能量集中在中高频，那样等于专挑敲击最响的频段做判断。');
}

console.log('\n[5] 静音段里连续敲击：门不该被敲开');
{
  const sig = new Float32Array(SR);
  for (let t = 0; t < 5; t++) {
    const c = click(SR, Math.round((0.2 + t * 0.2) * SR), 0.4);
    for (let i = 0; i < sig.length; i++) sig[i] += c[i];
  }
  const settle = Math.round(0.5 * SR);
  for (const th of [-45, -38, -32]) {
    const node = new Registered();
    const params = { thresholdDb: [th], enabled: [1] };
    const out = new Float32Array(sig.length);
    let opened = false;
    for (let off = 0; off + 128 <= sig.length; off += 128) {
      const o = [new Float32Array(128)];
      node.process([[sig.subarray(off, off + 128)], [sig.subarray(off, off + 128)]], [o], params);
      out.set(o[0], off);
      if (off >= settle && node.open) opened = true;
    }
    const tailPeak = peakOf(out, out.length - Math.round(0.2 * SR));
    check(!opened && tailPeak === 0, `阈值 ${th}dB：稳定后门始终关着且输出为 0`);
  }
  console.log('     注：关门是 60ms 时间常数的淡出（不是硬切，避免"啪"的一声），');
  console.log('     所以稳定期刚过还有一小段衰减尾巴，量级远低于可闻。');
}

console.log('\n[6] 已知取舍：清辅音在检测频段里能量很低');
{
  const sig = new Float32Array(SR);
  const len = Math.round(0.15 * SR);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < len; i++) sig[i] = 0.15 * rnd();
  for (let i = 1; i < len; i++) sig[i] = 0.15 * (sig[i] - sig[i - 1]) * 3;
  const rf = run(new Registered(), sig, { enabled: false });
  const rv = run(new Registered(), voiced(SR, 0.2), { enabled: false });
  console.log(`     浊音=${dB(rv.peakEnv).toFixed(1)}dB  /s/=${dB(rf.peakEnv).toFixed(1)}dB`);
  console.log('     阈值调得比 /s/ 高，长 /s/ 会被切掉；调得比敲击低，敲击会漏进来。');
  console.log('     这是门控方案唯一的取舍点，界面上给了电平表让用户自己找平衡。');
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
