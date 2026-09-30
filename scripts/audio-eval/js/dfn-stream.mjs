/**
 * DeepFilterNet3 流式推理（JavaScript 侧实现）。
 *
 * 为什么要先写 Node 版，而不是直接写浏览器 worklet：
 *   1. **机制完全相同** —— onnxruntime-node 与 onnxruntime-web 都是
 *      `session.run(feeds) → outputs`，状态在线程内手工穿线。
 *      这里验证通的穿线逻辑可以逐行搬到浏览器。
 *   2. **能实测实时率** —— 决定「32ms 延迟能不能接受」需要真实数字，
 *      而这个数字在浏览器里才是最终答案，先用同规模 CPU 推理量一遍。
 *   3. **能产出可试听的输出** —— 用真人语音跑一遍，人耳确认模型没把语音搞坏。
 *
 * 模型契约（由 tools/inspect_onnx.py 打印得到）：
 *   输入：input_frame[512] + 12 个状态张量（erb_norm_state[32]、
 *         band_unit_norm_state[1,96,1]、analysis_mem[512] … enc_hidden[1,1,256] 等）
 *   输出：enhanced_audio_frame[512] + 12 个新状态
 *
 * 关键点：**状态必须逐帧穿线**。每帧的输出状态就是下一帧的输入状态，
 * 漏掉任何一个都会让输出变成噪声（这是流式模型最容易踩的坑）。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ort from 'onnxruntime-node';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 模型放在评测台根目录的 models/（由 tools/fetch_model.py 下载） */
const MODEL_DIR = path.join(HERE, '..', 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'denoiser_model.onnx');
const STATES_PATH = path.join(MODEL_DIR, 'initial_states.npz');

/** 帧长（样本）。由模型决定的固定契约，不是可调参数 */
export const FRAME_SIZE = 512;
/** 采样率 */
export const SAMPLE_RATE = 48000;

/**
 * 解析 DeepFilterNet 的 initial_states.npz。
 *
 * .npz 就是一个 ZIP，里面每个条目是一个 .npy。这里只实现解析所需的最小子集：
 * 读中央目录 → 定位条目 → 读取 npy 头（dtype/shape）→ 取出 float32 数据。
 * 之所以不引依赖：整个评测/移植链路要保持零额外依赖，方便在浏览器侧复用同样的思路。
 */
export async function loadInitialStates(npyBuffer) {
  const buf = Buffer.from(npyBuffer);
  const states = {};

  // ZIP 中央目录结束记录（EOCD）：从尾部往前找签名 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到 EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name.endsWith('.npy')) continue;

    // 本地文件头：签名(4) + 版本(2) + 标志(2) + 压缩(2) + 时间(2) + crc(4)
    //             + 压缩大小(4) + 原始大小(4) + 名字长度(2) + 扩展长度(2)
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;

    // npy 头：magic(6) + 版本(2) + 头长度(2) + 头内容
    const headerLen = buf.readUInt16LE(dataStart + 8);
    const header = buf.subarray(dataStart + 10, dataStart + 10 + headerLen).toString('latin1');
    const dataOffset = dataStart + 10 + headerLen;

    const descrMatch = header.match(/'descr':\s*'([^']+)'/);
    const shapeMatch = header.match(/'shape':\s*\(([^)]*)\)/);
    if (!descrMatch || !shapeMatch) continue;

    const descr = descrMatch[1];
    const shape = shapeMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);

    const size = shape.reduce((a, b) => a * b, 1);
    if (!descr.includes('f4')) throw new Error(`只支持 float32，遇到 ${descr}`);

    // 不能用 `new Float32Array(buffer, offset, size)`：它要求 offset 是 4 的倍数，
    // 而 npy 数据在 zip 里的起始位置只保证 1 字节对齐（实测就会撞上 RangeError）。
    // 所以逐元素读，稳妥且这段只在加载时跑一次。
    const flat = new Float32Array(size);
    for (let k = 0; k < size; k++) {
      flat[k] = buf.readFloatLE(buf.byteOffset + dataOffset + k * 4);
    }
    const key = name.replace(/\.npy$/, '');
    states[key] = { data: flat, shape };
  }
  return states;
}

/** 一个流式降噪会话：持有状态，逐帧进出 */
export class DfnStream {
  constructor(session, initialStates, { inputNames, outputNames }) {
    this.session = session;
    this.inputNames = inputNames;
    this.outputNames = outputNames;
    // 逐帧会改写，所以每个流都持有自己的一份状态副本
    this.states = {};
    for (const [key, value] of Object.entries(initialStates)) {
      this.states[key] = {
        data: Float32Array.from(value.data),
        shape: value.shape,
      };
    }
    this.frames = 0;
  }

  /**
   * 处理一帧（512 样本），返回同样长度的增强音频。
   *
   * 状态穿线：输出里除第一个（音频）以外的张量，按**输入顺序**回填成下一帧的状态。
   * 顺序必须与输入的 `inputNames[1..]` 一致 —— 模型输出的 new_* 顺序与此对应。
   */
  async processFrame(frame) {
    if (frame.length !== FRAME_SIZE) {
      throw new Error(`帧长必须是 ${FRAME_SIZE}，收到 ${frame.length}`);
    }

    const feeds = {};
    feeds[this.inputNames[0]] = new ort.Tensor('float32', frame, [FRAME_SIZE]);
    for (let i = 1; i < this.inputNames.length; i++) {
      const name = this.inputNames[i];
      const st = this.states[name];
      if (!st) throw new Error(`缺少状态 ${name}`);
      feeds[name] = new ort.Tensor('float32', st.data, st.shape);
    }

    // 注意：onnxruntime-node 的 session.run 返回 Promise（onnxruntime-web 也是）。
    // 所以热路径是 async 的 —— 在浏览器 worklet 里要把它放在可 await 的位置，
    // 或者用 WASM 的同步绑定。
    const results = await this.session.run(feeds);

    // 输出顺序与输入对应：第 0 个是音频，其余按 inputNames[1..] 顺序回填状态。
    // 漏掉任何一个状态都会让下一帧的输入不连续 → 输出退化成噪声。
    const audio = results[this.outputNames[0]].data;
    for (let i = 1; i < this.inputNames.length; i++) {
      const name = this.inputNames[i];
      const value = results[this.outputNames[i]];
      if (!value) continue;
      const st = this.states[name];
      // 必须复制：ORT 的输出缓冲在下次 run 时会被复用，直接引用会串帧
      st.data = Float32Array.from(value.data);
      st.shape = value.dims;
    }

    this.frames += 1;
    return audio;
  }

  /**
   * 只跑推理、**不回填状态** —— 仅供性能分解测量用。
   *
   * 语义上这是错的（状态不连续），但由此可以算出「状态回填」这一步占多少开销，
   * 从而判断浏览器端要不要为它专门优化缓冲设计。
   */
  async sessionRunOnly(frame) {
    const feeds = {};
    feeds[this.inputNames[0]] = new ort.Tensor('float32', frame, [FRAME_SIZE]);
    for (let i = 1; i < this.inputNames.length; i++) {
      const name = this.inputNames[i];
      const st = this.states[name];
      feeds[name] = new ort.Tensor('float32', st.data, st.shape);
    }
    return this.session.run(feeds);
  }

  /**
   * 处理整段音频。
   *
   * 模型有 512 样本的固有延迟（STFT 前瞻），所以输出的前 512 个样本对应输入的
   * 起始部分；对齐比较时要带 +FRAME_SIZE 的偏移。
   */
  async processAll(samples) {
    const total = Math.floor(samples.length / FRAME_SIZE);
    const out = new Float32Array(total * FRAME_SIZE);
    for (let i = 0; i < total; i++) {
      const frame = samples.subarray(i * FRAME_SIZE, (i + 1) * FRAME_SIZE);
      out.set(await this.processFrame(frame), i * FRAME_SIZE);
    }
    return out;
  }
}

/** 加载模型（一次），返回可创建多个流的信息 */
export async function loadModel(modelPath = MODEL_PATH, statesPath = STATES_PATH) {
  if (!existsSync(modelPath)) {
    throw new Error(`模型不存在：${modelPath}\n先跑 python tools/fetch_model.py`);
  }
  if (!existsSync(statesPath)) {
    throw new Error(`初始状态不存在：${statesPath}\n先跑 python tools/fetch_model.py`);
  }

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  const npz = await readFile(statesPath);
  const initialStates = await loadInitialStates(npz);

  return {
    session,
    initialStates,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    newStream: () => new DfnStream(session, initialStates, {
      inputNames: session.inputNames,
      outputNames: session.outputNames,
    }),
  };
}
