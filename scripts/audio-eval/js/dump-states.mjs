/**
 * 对比 JS 与 Python 的状态演化，定位穿线差异。
 *
 * 做法：把「JSON 导出的一段固定输入帧」分别喂给两边的实现，
 * 逐帧导出关键状态（erb_norm_state、enc_hidden 的均值/标准差）。
 * 如果两边不一致，就是 JS 侧的穿线逻辑有 bug；
 * 如果一致，问题就在别处（例如输出缓冲复用）。
 *
 * 用法：
 *   node js/dump-states.mjs > /tmp/js-states.json
 *   python tools/dump_states.py > /tmp/py-states.json
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadModel } from './dfn-stream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function stats(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  const mean = sum / arr.length;
  let sq = 0;
  for (let i = 0; i < arr.length; i++) sq += (arr[i] - mean) ** 2;
  return { mean: +mean.toFixed(4), std: +Math.sqrt(sq / arr.length).toFixed(4) };
}

async function main() {
  // 用固定输入：一段真实语音的前 512*20 样本，保证两边完全一致
  const wav = await readFile(path.join(ROOT, 'real', 'harvard_m1.wav'));
  const dataStart = wav.indexOf(Buffer.from('data')) + 8;
  const frames = 20;
  const need = frames * 512;
  const input = new Float32Array(need);
  for (let i = 0; i < need; i++) {
    input[i] = wav.readInt16LE(dataStart + i * 2) / 32768;
  }
  // 与 Python 侧一致：归一化到 -26dBFS
  let sum = 0;
  for (let i = 0; i < need; i++) sum += input[i] * input[i];
  const gain = Math.pow(10, -26 / 20) / Math.sqrt(sum / need);
  for (let i = 0; i < need; i++) input[i] *= gain;

  const model = await loadModel();
  const stream = model.newStream();

  const rows = [];
  for (let f = 0; f < frames; f++) {
    const frame = input.subarray(f * 512, (f + 1) * 512);
    const audio = await stream.processFrame(frame);
    let energy = 0;
    for (let i = 0; i < audio.length; i++) energy += audio[i] * audio[i];
    rows.push({
      frame: f,
      audioRms: +Math.sqrt(energy / audio.length).toFixed(6),
      erb: stats(stream.states['erb_norm_state'].data),
      enc: stats(stream.states['enc_hidden'].data),
      specX: stats(stream.states['rolling_spec_buf_x'].data),
    });
  }

  console.log(JSON.stringify(rows, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
