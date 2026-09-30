/**
 * DFN3 worklet 的**纯逻辑**（不依赖任何 AudioWorklet 全局）。
 *
 * 为什么单独抽出来：浏览器 API 我在这里无法验证，但**帧装配、相位切换、
 * 欠载处理、干湿对齐**这些才是真正容易出错的地方。抽成纯函数之后，
 * 可以用与线程测试台同样的方式在 Node 里验证（喂 128 样本量子，比对输出）。
 *
 * 音频线程的硬约束（决定了这里每个设计）：
 *   1. `process()` 必须同步返回 —— 绝不能 await；
 *   2. **绝不能因为等不到数据就返回空**，否则是爆音/静音；必须有干信号兜底；
 *   3. 不能忙等 —— 会烧满一个核。
 *
 * 相位设计（这是最容易出错的地方）：
 *   模型对同一段音频的输入输出差 512 样本（FRAME_SIZE）。所以「湿信号」
 *   天然比「干信号」晚 512 样本。处理方式：
 *     - 启动期（worker 还没出数据）：把输入延迟 512 样本直接输出（纯干信号）；
 *     - 就绪后：改为输出湿信号 —— 两者时间轴一致，因此**切换点是连续的**，
 *       不需要额外补偿。这一点很关键：如果相位不一致，切换会听到明显跳变，
 *       而且之后所有音频都会与视频/其他成员错位。
 */

export const FRAME_SIZE = 512;
export const RENDER_QUANTUM = 128;

/**
 * 状态机。只操作两个 RingBuffer 接口（write/read/available/closed），
 * 因此可以脱离 SharedArrayBuffer 单测。
 */
export class DfnChannel {
  /**
   * @param {object} opts
   * @param {{write:Function, read:Function, available:number, closed:boolean}} opts.inRing
   * @param {{write:Function, read:Function, available:number, closed:boolean}} opts.outRing
   * @param {number} [opts.frameSize]
   */
  constructor({ inRing, outRing, frameSize = FRAME_SIZE }) {
    this.inRing = inRing;
    this.outRing = outRing;
    this.frameSize = frameSize;
    /** 待喂给推理线程的样本（拼满一帧才能写进 inRing 的语义由我们保证） */
    this.pendingIn = new Float32Array(0);
    /**
     * 干信号延迟线：启动期用它把干信号延迟 frameSize，与湿信号对齐。
     *
     * 初始化为全零 —— 这样**前 frameSize 个样本天然输出零**，
     * 不需要任何"是否已填满"的计数器。
     * （我第一版加了 dryFilled 计数器，当写指针绕回后判断就错了，
     *   会用零覆盖真实历史样本 —— 这是循环缓冲的经典陷阱。）
     */
    this.dryLine = new Float32Array(frameSize);
    this.dryIndex = 0;

    /** 'booting' = 输出延迟后的干信号；'wet' = 输出模型结果 */
    this.phase = 'booting';
    /** 交叉淡入进度（0→1），用于从干切到湿时避免爆音 */
    this.crossfade = 0;
    this.crossfadeSamples = RENDER_QUANTUM;

    /** 统计（由 worklet 定期回传，便于排查） */
    this.stats = { framesFed: 0, underruns: 0, bootedAt: -1 };
    this.samplesProcessed = 0;
  }

  /**
   * 处理一个渲染量子。
   *
   * @param {Float32Array} input 128 样本（多声道时取第 0 声道，调用方负责）
   * @returns {Float32Array} 128 样本输出
   */
  process(input) {
    const n = input.length;
    const out = new Float32Array(n);

    // ---- 1. 把输入攒成整帧喂给推理线程 ----
    this.appendInput(input);

    // ---- 2. 干信号进延迟线（启动期输出用） ----
    const dry = this.pushDry(input);

    // ---- 3. 就绪判定：输出环里已经有一帧以上的成品 ----
    if (this.phase === 'booting' && this.outRing.available >= this.frameSize) {
      this.phase = 'wet';
      this.crossfade = 0;
      this.stats.bootedAt = this.samplesProcessed;
    }

    if (this.phase === 'booting') {
      out.set(dry);
    } else {
      // 湿信号：从输出环保底取 n 个样本
      const wet = this.outRing.read(n);
      if (wet.length < n) {
        // 欠载：推理线程没跟上（或刚开始）。这里**必须**有兜底，
        // 否则会输出一段空洞（听感是周期性断音）。
        // 用干信号补足，并计数 —— 频繁欠载说明推理跟不上，需要降级到更小的模型。
        this.stats.underruns += 1;
        out.set(dry.subarray(0, n));
        if (wet.length > 0) {
          // 前面部分用湿信号，后面用干信号：听起来比整段空洞自然
          out.set(wet, 0);
        }
      } else {
        out.set(wet.subarray(0, n));
      }

      // 从干切湿的交叉淡入（只在切换后的第一个量子内做）
      if (this.crossfade < 1) {
        const step = 1 / this.crossfadeSamples;
        for (let i = 0; i < n; i++) {
          const t = Math.min(1, this.crossfade + i * step);
          out[i] = dry[i] * (1 - t) + out[i] * t;
        }
        this.crossfade = Math.min(1, this.crossfade + n * step);
      }
    }

    this.samplesProcessed += n;
    return out;
  }

  /** 把输入攒进 pendingIn，凑满 frameSize 就写进输入环 */
  appendInput(input) {
    const merged = new Float32Array(this.pendingIn.length + input.length);
    merged.set(this.pendingIn, 0);
    merged.set(input, this.pendingIn.length);
    this.pendingIn = merged;

    const frame = this.frameSize;
    while (this.pendingIn.length >= frame) {
      const chunk = this.pendingIn.subarray(0, frame);
      const wrote = this.inRing.write(chunk);
      if (wrote < frame) {
        // 输入环满：说明推理线程落后。丢弃这一帧比阻塞音频线程好，
        // 但要把没写进去的部分留在 pending 里，等下次再试。
        break;
      }
      this.stats.framesFed += 1;
      this.pendingIn = this.pendingIn.subarray(frame);
    }
  }

  /**
   * 写进干信号延迟线，返回延迟 frameSize 后的样本。
   *
   * 读写**同一个位置**是这段代码的关键：先取出该位置里 frameSize 个样本之前
   * 写入的值，再把当前位置换成新样本。因为缓冲初始为全零，
   * 前 frameSize 个样本自然输出零，无需任何填充状态。
   */
  pushDry(input) {
    const size = this.frameSize;
    const n = input.length;
    const out = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      out[i] = this.dryLine[this.dryIndex];
      this.dryLine[this.dryIndex] = input[i];
      this.dryIndex = (this.dryIndex + 1) % size;
    }
    return out;
  }
}
