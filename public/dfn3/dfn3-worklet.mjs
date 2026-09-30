/**
 * DFN3 降噪的 AudioWorkletProcessor。
 *
 * 这个文件刻意保持**极薄**：全部容易出错的逻辑（帧装配、相位切换、欠载兜底、
 * 干湿对齐）都在 `channel.mjs` 的 `DfnChannel` 里，而那部分已经在 Node 中
 * 用确定性测试验证过（`js/test-channel.mjs`，10/10 通过）。
 * 这里只留「浏览器 API → 纯逻辑」的绑定代码。
 *
 * 线程结构：
 *   AudioWorklet（本文件，音频线程，必须同步）
 *      ↕ SharedArrayBuffer 环形缓冲
 *   Web Worker（inference-worker.mjs，跑 ONNX 推理，可以 await）
 *
 * 为什么必须分线程：`AudioWorkletProcessor.process()` **必须同步返回**，
 * 而 ONNX Runtime 的 `session.run()` 返回 Promise。把推理放进音频线程会
 * 直接卡死音频。
 *
 * 消息协议（主线程 ↔ worklet）：
 *   主线程 → worklet: { type:'init', sabIn, sabOut, frameSize }
 *   主线程 → worklet: { type:'stop' }
 *   worklet → 主线程: { type:'stats', framesFed, underruns, phase, dropped }
 *                     { type:'underrun' }（首次欠载时提示，便于主线程降级）
 */

import { DfnChannel, FRAME_SIZE, RENDER_QUANTUM } from './channel.mjs';
import { RingBuffer } from './ring-buffer.mjs';

class Dfn3Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channel = null;
    this.reportedUnderrun = false;
    this.lastReportAt = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg?.type === 'init') {
        try {
          this.channel = new DfnChannel({
            inRing: new RingBuffer(msg.sabIn),
            outRing: new RingBuffer(msg.sabOut),
            frameSize: msg.frameSize ?? FRAME_SIZE,
          });
          this.port.postMessage({ type: 'ready' });
        } catch (err) {
          this.port.postMessage({ type: 'error', message: String(err?.message ?? err) });
        }
      } else if (msg?.type === 'stop') {
        this.channel = null;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  /**
   * 音频线程热路径。
   *
   * ⚠️ 绝不允许：await、分配大对象、忙等、抛异常。
   * 任何一样都会造成可听见的故障（爆音/断音/整条轨道静音）。
   */
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // 没有输入（例如上游还没接上）：输出静音并保持存活
    if (!output || output.length === 0) return true;

    if (!this.channel || !input || input.length === 0 || !input[0]) {
      // 还没 init（主线程还在建 worker / 下载模型）：直通，
      // 让用户至少能正常说话，而不是整条轨道静音。
      for (let c = 0; c < output.length; c++) {
        const src = input?.[c];
        if (src) output[c].set(src.subarray(0, output[c].length));
        else output[c].fill(0);
      }
      return true;
    }

    // DfnChannel 处理单声道（语音室是单声道麦克风）。多声道时逐声道跑独立实例
    // 会成倍消耗推理预算，所以这里只处理第 0 声道并复制到其余声道。
    const mono = this.channel.process(input[0]);
    for (let c = 0; c < output.length; c++) output[c].set(mono);

    // 首次欠载时主动上报一次：主线程据此决定是否降级到更轻的引擎
    if (!this.reportedUnderrun && this.channel.stats.underruns > 0) {
      this.reportedUnderrun = true;
      this.port.postMessage({ type: 'underrun', underruns: this.channel.stats.underruns });
    }

    // 定期回报统计（约每秒一次）。currentTime 是音频时钟，不受主线程卡顿影响。
    if (currentTime - this.lastReportAt > 1) {
      this.lastReportAt = currentTime;
      this.port.postMessage({
        type: 'stats',
        framesFed: this.channel.stats.framesFed,
        underruns: this.channel.stats.underruns,
        phase: this.channel.phase,
      });
    }

    return true;
  }
}

registerProcessor('cf-dfn3', Dfn3Processor);
