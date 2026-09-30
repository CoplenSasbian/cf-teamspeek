/**
 * 单生产者单消费者环形缓冲（基于 SharedArrayBuffer）。
 *
 * 为什么自己写而不是用现成库：
 *   - 音频线程与推理线程之间要传的是 float32 样本流，协议极简单；
 *   - **必须能同时在 Node（worker_threads）与浏览器（AudioWorklet + Worker）里跑**，
 *     这样才能在 Node 里把线程逻辑验证透，只把浏览器 API 的薄胶水层留到最后；
 *   - 原子索引 + Atomics.wait 的用法必须自己控制，否则很容易写出忙等把音频线程烧死。
 *
 * 布局（Int32 头 + float32 数据）：
 *   [0] writeIndex   生产者写入位置（样本计数，单调递增）
 *   [1] readIndex    消费者读取位置
 *   [2] capacity     容量（样本数，非 2 的幂时用取模）
 *   [3] closed       生产者是否已结束
 *  数据区从 byteOffset 16 开始。
 *
 * 关键约束：**只有生产者写 writeIndex，只有消费者写 readIndex**，
 * 这样单生产者单消费者场景不需要加锁。
 */

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;

export class RingBuffer {
  /**
   * @param {SharedArrayBuffer} sab
   * @param {{producer?: boolean}} [opts]
   */
  constructor(sab, opts = {}) {
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.data = new Float32Array(sab, HEADER_BYTES);
    this.capacity = this.header[2] || this.data.length;
    this.isProducer = opts.producer === true;
  }

  /** 分配一个够用的 SharedArrayBuffer */
  static allocate(capacitySamples) {
    const bytes = HEADER_BYTES + capacitySamples * 4;
    const sab = new SharedArrayBuffer(bytes);
    const header = new Int32Array(sab, 0, HEADER_INTS);
    header[0] = 0; // writeIndex
    header[1] = 0; // readIndex
    header[2] = capacitySamples;
    header[3] = 0; // closed
    return sab;
  }

  get writeIndex() {
    return Atomics.load(this.header, 0);
  }

  get readIndex() {
    return Atomics.load(this.header, 1);
  }

  /** 可读样本数 */
  get available() {
    return this.writeIndex - this.readIndex;
  }

  /** 可写样本数 */
  get free() {
    return this.capacity - this.available;
  }

  get closed() {
    return Atomics.load(this.header, 3) === 1;
  }

  close() {
    Atomics.store(this.header, 3, 1);
    Atomics.notify(this.header, 3);
  }

  /**
   * 写入样本（生产者）。空间不足时**只写能写下的部分**，返回实际写入数。
   *
   * 刻意不做阻塞等待：音频线程绝不能因为缓冲满而卡住。
   */
  write(samples) {
    const free = this.free;
    const n = Math.min(samples.length, free);
    if (n <= 0) return 0;

    const w = this.writeIndex;
    const cap = this.capacity;
    const start = w % cap;
    const first = Math.min(n, cap - start);
    this.data.set(samples.subarray(0, first), start);
    if (n > first) this.data.set(samples.subarray(first, n), 0);

    Atomics.store(this.header, 0, w + n);
    Atomics.notify(this.header, 0);
    return n;
  }

  /**
   * 读取样本（消费者）。不足时返回实际读到的数量。
   */
  read(count) {
    const avail = this.available;
    const n = Math.min(count, avail);
    if (n <= 0) return new Float32Array(0);

    const r = this.readIndex;
    const cap = this.capacity;
    const start = r % cap;
    const first = Math.min(n, cap - start);
    const out = new Float32Array(n);
    out.set(this.data.subarray(start, start + first), 0);
    if (n > first) out.set(this.data.subarray(0, n - first), first);

    Atomics.store(this.header, 1, r + n);
    return out;
  }

  /**
   * 等待数据（消费者侧）。
   *
   * 用 Atomics.wait 而不是忙等 —— 忙等会把一个核心跑满，在音频线程上尤其致命。
   * 超时是必需的：等待方可能永远等不到数据（生产者崩了），必须能自己醒来看 closed。
   *
   * @returns true 表示等到了数据，false 表示超时或已关闭
   */
  waitForData(minAvailable, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.available >= minAvailable) return true;
      if (this.closed) return this.available > 0;
      const remain = deadline - Date.now();
      if (remain <= 0) return false;
      // Atomics.wait 返回 'timed-out' | 'ok' | 'not-equal'，任何一种都继续循环判断
      Atomics.wait(this.header, 0, this.writeIndex, Math.min(remain, 20));
    }
  }

  /** 等待空间（生产者侧，非实时路径用） */
  waitForSpace(minFree, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.free >= minFree) return true;
      if (this.closed) return false;
      const remain = deadline - Date.now();
      if (remain <= 0) return false;
      Atomics.wait(this.header, 1, this.readIndex, Math.min(remain, 20));
    }
  }
}

export { HEADER_BYTES };
