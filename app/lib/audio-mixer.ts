import { useEffect, useState, useSyncExternalStore } from 'react';

import { attachDenoise, detachDenoise, type DenoiseEngine } from './denoise';
import { loadSettings, saveSettings } from './settings';

/**
 * 音频混音器。
 *
 * ============================================================
 *  设计原则：出声用原生能力，处理用 Web Audio
 * ============================================================
 * 两类事情分开做，因为它们的可靠性完全不同：
 *
 *   1. 【出声】远端播放：每个成员一个 <audio srcObject>，音量直接写
 *      `el.volume`。这是浏览器原生能力，和最早能正常出声的实现完全一致，
 *      不依赖 AudioContext 状态、不依赖 Web Audio 图能否被渲染。
 *
 *   2. 【处理】自己的录制音量：`麦克风 → micGain → MediaStreamDestination
 *      → 拿去发布的轨道`。发布中的轨道无法用别的方式改音量，只能用 Web Audio；
 *      且必须保证 AudioContext 在运行（suspended 时它会输出静音），
 *      否则退回原始轨道——宁可没有录制音量，也不能变成哑巴。
 *
 *   3. 【显示】电平表：Web Audio analyser 挂在增益之后（死端 + 零增益拉取，
 *      不影响出声）。它只驱动说话光圈和音量条；万一某个环境读不到信号，
 *      也只是画面不亮，**绝不会影响声音**。
 *
 * 为什么要这样拆：Cloudflare Realtime SFU 是转发器，转发编码后的 Opus 包，
 * 协议层面没有音量概念（官方 OpenAPI 全文搜 volume/gain 零命中），
 * 音量只能在接收端本地做。而「本地做」最稳的载体就是 <audio>.volume。
 */

/** 播放音量上限：HTMLMediaElement.volume 的取值范围就是 0–1 */
export const PLAYBACK_VOLUME_MAX = 1;
/** 录制音量上限（Web Audio 增益，>1 会放大量化噪声，语音场景 2 倍足够） */
export const MIC_VOLUME_MAX = 2;
/** 说话判定阈值（0–1） */
export const SPEAKING_THRESHOLD = 0.08;

const DEFAULT_VOLUME = 1;
/** 增益平滑时间常数（秒）：避免拖动滑块时出现「咔哒」爆音 */
const GAIN_SMOOTHING = 0.015;
/**
 * 降噪补偿的起点与边界。
 *
 * GTCRN/RNNoise 是谱减模型：噪声底被大幅削掉，语音也会被衰减一部分，
 * 于是「开了降噪声音变小」。补偿量取决于环境和输入电平 —— 安静时衰减少、
 * 嘈杂时衰减多，固定值必然两头不讨好。
 *
 * 所以这里只在自适应尚未测到足够语音时用 FALLBACK 兜底，
 * 一旦测出来就由 `startDenoiseCompensation()` 实时对齐。
 */
const DENOISE_MAKEUP_FALLBACK = 1.6;
/** 补偿下限：不低于原始（补偿的语义是「补回来」，不是「调小」） */
const MAKEUP_MIN = 1;
/** 补偿上限：防止把残留噪声 + 量化噪声一起放大成嘶嘶声 */
const MAKEUP_MAX = 2.6;
/** 自适应收敛速度（每秒向目标靠拢的比例） */
const MAKEUP_ADAPT_RATE = 0.5;
/** 至少累计这么多「有声」帧才开始调整，避免被静音段底噪误导 */
const MAKEUP_MIN_SPEECH_FRAMES = 10;
/** 音量写 localStorage 的防抖（毫秒） */
const PERSIST_DEBOUNCE_MS = 400;

export interface MixerSnapshot {
  /** 自己的录制音量（0–2） */
  mic: number;
  /** 总播放音量（0–1） */
  master: number;
  /** uid → 该成员播放音量（0–1） */
  users: Record<string, number>;
  /** 被我单独静音的 uid */
  mutedUsers: string[];
  /** 录制音量链路不可用（对方听到的是原始麦克风） */
  degraded: boolean;
}

/** 内部音量状态：静音名单与降级标记单独存 */
type VolumeState = { mic: number; master: number; users: Record<string, number> };

const DEFAULT_SNAPSHOT: MixerSnapshot = {
  mic: 1,
  master: 1,
  users: {},
  mutedUsers: [],
  degraded: false,
};

function clamp(v: number, max: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VOLUME;
  return Math.min(max, Math.max(0, v));
}

class AudioMixer {
  private ctx: AudioContext | null = null;

  // ---- 输入链路（录制音量，需要 Web Audio） ----
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micDest: MediaStreamAudioDestinationNode | null = null;
  private micInputTrack: MediaStreamTrack | null = null;
  private micOutputTrack: MediaStreamTrack | null = null;
  private micUid: string | null = null;
  private micEnabled = true;
  /** 录制音量链路是否可用 */
  private micGainAvailable = false;
  /** 当前管线是否启用了降噪（决定补偿增益） */
  private micDenoise = false;

  // ---- 降噪自适应补偿（比较降噪前后的语音电平） ----
  /** 降噪前的分析器（挂在 source 上） */
  private dnPreAnalyser: AnalyserNode | null = null;
  /** 降噪后的分析器（挂在 worklet 输出上） */
  private dnPostAnalyser: AnalyserNode | null = null;
  private dnCompRaf = 0;
  /** 当前补偿增益（自适应结果，1 = 不补偿） */
  private makeupGain = DENOISE_MAKEUP_FALLBACK;
  /** 已累计的「有声」帧数（够数才开始调整） */
  private dnSpeechFrames = 0;
  /** 上一帧时间戳（按真实帧间隔平滑，不假设 60fps） */
  private dnLastTick = 0;

  // ---- 输出链路（播放，只用 <audio>） ----
  /** uid → 播放用的 <audio>（真正出声的东西） */
  private players = new Map<string, HTMLAudioElement>();
  /** uid → 远端流 */
  private streams = new Map<string, MediaStream>();
  /** uid → 仅用于电平显示的分析器（死端，绝不影响出声） */
  private meters = new Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode }>();
  /** 零增益汇点：把 analyser 拉进渲染图但不出声 */
  private silentSink: GainNode | null = null;

  // ---- 状态 ----
  private volumes: VolumeState = { mic: DEFAULT_VOLUME, master: DEFAULT_VOLUME, users: {} };
  private mutedUsers = new Set<string>();
  private snapshot: MixerSnapshot = DEFAULT_SNAPSHOT;
  private listeners = new Set<() => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      const saved = loadSettings().volumes;
      if (saved) {
        this.volumes = {
          mic: clamp(saved.mic ?? DEFAULT_VOLUME, MIC_VOLUME_MAX),
          master: clamp(saved.master ?? DEFAULT_VOLUME, PLAYBACK_VOLUME_MAX),
          users: { ...(saved.users ?? {}) },
        };
        this.mutedUsers = new Set(saved.mutedUsers ?? []);
      }
      this.snapshot = this.buildSnapshot();
    }
  }

  // ==========================================================
  //  AudioContext（只服务于「录制音量」与「电平显示」）
  // ==========================================================

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (this.ctx) return this.ctx;

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;

    // 固定 48kHz：GTCRN worklet 只支持 16k/48k，而 AudioContext 默认采样率
    // 跟随系统（可能是 44.1k），会让降噪模型初始化失败 → 发布一条静音轨道。
    // 48k 也是绝大多数输入设备的原生采样率，重采样成本最低。
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: 48000 });
    } catch {
      ctx = new Ctor();
    }
    this.ctx = ctx;

    // 零增益汇点：让「只做电平显示」的分析器能被渲染，但绝不发出声音
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    this.silentSink = sink;

    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    });

    return ctx;
  }

  /** 主动恢复（有用户手势时调用最稳） */
  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      await ctx.resume();
    } catch {
      /* 无用户手势时会被拒绝，交给手势兜底重试 */
    }
  }

  /**
   * 同步解锁：只应在**用户手势的回调里**调用。
   * 浏览器要求 AudioContext 在手势中创建/恢复，否则一直 suspended，
   * 而 suspended 的 context 输出的是静音 —— 录制音量会变成「对方听不到我」。
   */
  unlock(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    void ctx.resume().catch(() => undefined);
  }

  // ==========================================================
  //  输入链路：自己的录制音量
  // ==========================================================

  /**
   * 为麦克风建立增益链路。
   * 返回**应当拿去发布**的轨道（已应用录制音量）；
   * 返回 null 时调用方必须退回原始轨道（没有录制音量，但一定有声）。
   */
  async createMicPipeline(
    stream: MediaStream,
    uid: string,
    denoise: DenoiseEngine = 'off',
  ): Promise<MediaStreamTrack | null> {
    const ctx = this.ensureContext();
    const input = stream.getAudioTracks()[0];
    if (!ctx || !input) {
      this.setMicGainAvailable(false);
      return null;
    }

    await this.resume();
    if (ctx.state !== 'running') {
      // suspended 的 Web Audio 链路输出静音 → 绝不能拿它去发布
      this.setMicGainAvailable(false);
      return null;
    }

    this.releaseMic();

    try {
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      // 降噪补偿：起始值只是兜底，真正的量由 startDenoiseCompensation() 实时测出来。
      // 用户可用「录制音量」滑块在其上再微调（两个增益是乘关系）。
      this.micDenoise = denoise !== 'off';
      this.makeupGain = DENOISE_MAKEUP_FALLBACK;
      this.dnSpeechFrames = 0;
      gain.gain.value = this.volumes.mic * (this.micDenoise ? this.makeupGain : 1);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;

      const dest = ctx.createMediaStreamDestination();

      // 降噪：source → [worklet] → gain。失败自动回退直连，不影响出声
      const entry: AudioNode = await attachDenoise(source, gain, denoise);

      // 电平表接在 gain 之后（反映降噪后的真实输出）
      entry.connect(gain);
      gain.connect(analyser);
      gain.connect(dest);
      // 刻意不接 ctx.destination —— 否则自己会听到自己

      this.micSource = source;
      this.micGain = gain;
      this.micAnalyser = analyser;
      this.micDest = dest;
      this.micInputTrack = input;
      this.micUid = uid;

      // 降噪生效时启动自适应补偿（对比 worklet 前后的语音电平，动态对齐响度）
      if (this.micDenoise && entry !== source) {
        this.attachCompensationAnalysers(ctx, source, entry as AudioNode);
      }

      const outTrack = dest.stream.getAudioTracks()[0] ?? null;
      if (!outTrack) {
        this.releaseMic();
        this.setMicGainAvailable(false);
        return null;
      }

      this.micOutputTrack = outTrack;
      this.setMicEnabled(this.micEnabled);
      this.setMicGainAvailable(true);
      return outTrack;
    } catch {
      this.releaseMic();
      this.setMicGainAvailable(false);
      return null;
    }
  }

  /**
   * 【热切换】在不触碰已发布轨道的前提下更换降噪引擎。
   *
   * 原实现（applyDenoise → 重建整条管线 + republish）有个致命窗口：
   * republish 要关掉旧发布 session、跟 SFU 重新 SDP/ICE 协商——
   * 这个过程一旦失败（ICE 超时 / SFU 报错），麦克风就彻底没声了。
   *
   * 现在只重新接线 Web Audio 图内部的一段：
   *   断开 source→gain 的旧路径（含旧 worklet）
   *   → 新 worklet 建好并接到 gain 之后，才把 source 接过去
   *   → gain / analyser / dest / 已发布轨道全程不动
   * 对端的感知只是一瞬间的静音，协商层面什么都没发生。
   */
  async swapDenoise(engine: DenoiseEngine): Promise<boolean> {
    const ctx = this.ensureContext();
    const source = this.micSource;
    const gain = this.micGain;
    if (!ctx || !source || !gain) return false;

    await this.resume();

    // 先摘掉自适应分析器（它挂在 source 上，下一个步骤会清掉 source 的所有出边）
    this.stopDenoiseCompensation();

    // 重新接线：attachDenoise 内部会先断开 source 的全部旧出边，
    // 再按目标引擎建一条全新的路径（关键——否则每次切换都会叠加一条边）
    const entry = await attachDenoise(source, gain, engine);
    this.micDenoise = engine !== 'off';

    // 切换引擎后衰减特性会变（GTCRN 与 RNNoise 不同），补偿要重新测量
    this.makeupGain = DENOISE_MAKEUP_FALLBACK;
    this.dnSpeechFrames = 0;

    if (this.micDenoise && entry !== source) {
      this.attachCompensationAnalysers(ctx, source, entry);
    }

    // 补偿增益跟随引擎状态（自适应循环随后会把它调到合适值）
    const boost = this.micDenoise ? this.makeupGain : 1;
    gain.gain.setTargetAtTime(this.volumes.mic * boost, ctx.currentTime, GAIN_SMOOTHING);

    // 维持当前的麦克风开关状态（新链路要沿用旧的 enabled）
    this.setMicEnabled(this.micEnabled);

    // gain 的输出（analyser / dest / 已发布轨道）全程不动，所以不需要重新发布
    return entry !== null;
  }

  // ==========================================================
  //  降噪自适应补偿
  // ==========================================================

  /**
   * 在降噪前后各挂一个分析器，实时比较语音电平。
   *
   * 为什么需要：谱减模型的衰减量随环境变化 —— 安静房间里语音几乎不衰减，
   * 嘈杂环境里为了压住噪声会把语音也削掉一截。固定增益要么补偿不足
   * （嘈杂时声音仍偏小），要么过度（安静时底噪被放大）。
   */
  private attachCompensationAnalysers(
    ctx: AudioContext,
    pre: AudioNode,
    post: AudioNode,
  ): void {
    this.stopDenoiseCompensation();

    const mk = () => {
      const a = ctx.createAnalyser();
      a.fftSize = 512;
      a.smoothingTimeConstant = 0;
      return a;
    };
    const preA = mk();
    const postA = mk();
    // 分析器是死端：只读取电平，不参与出声
    pre.connect(preA);
    post.connect(postA);
    this.dnPreAnalyser = preA;
    this.dnPostAnalyser = postA;

    this.dnCompRaf = requestAnimationFrame(() => this.tickCompensation());
  }

  /** 自适应循环：测语音电平 → 求比值 → 平滑调整补偿增益 */
  private tickCompensation(): void {
    const preA = this.dnPreAnalyser;
    const postA = this.dnPostAnalyser;
    const gain = this.micGain;
    const ctx = this.ctx;

    if (!preA || !postA || !gain || !ctx || !this.micDenoise) {
      this.dnCompRaf = 0;
      return;
    }

    const bufLen = preA.fftSize;
    const preBuf = new Float32Array(bufLen);
    const postBuf = new Float32Array(bufLen);
    preA.getFloatTimeDomainData(preBuf);
    postA.getFloatTimeDomainData(postBuf);

    const rms = (b: Float32Array) => {
      let s = 0;
      for (let i = 0; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / b.length);
    };
    const rawRms = rms(preBuf);
    const postRms = rms(postBuf);

    // 只在「确实有人在说话」时采样：
    // 静音段里 models 会把底噪压到接近 0，此时算比值会得到虚高的补偿目标
    const SPEECH_FLOOR = 0.02;
    if (rawRms > SPEECH_FLOOR && postRms > 0.0005) {
      this.dnSpeechFrames++;

      // 累计足够帧才动增益：避免开口瞬间就猛调一下（听感是"抽一下"）
      if (this.dnSpeechFrames >= MAKEUP_MIN_SPEECH_FRAMES) {
        // 目标：补偿后的人声与原始人声等响
        const target = Math.min(MAKEUP_MAX, Math.max(MAKEUP_MIN, rawRms / postRms));

        // 指数平滑（按真实帧间隔计算，不假设 60fps）
        const now = performance.now();
        const dt = this.dnLastTick ? Math.min(0.2, (now - this.dnLastTick) / 1000) : 1 / 60;
        const k = 1 - Math.exp(-MAKEUP_ADAPT_RATE * dt);
        this.makeupGain += (target - this.makeupGain) * k;

        gain.gain.setTargetAtTime(
          this.volumes.mic * this.makeupGain,
          ctx.currentTime,
          GAIN_SMOOTHING,
        );
      }
    }
    this.dnLastTick = performance.now();

    this.dnCompRaf = requestAnimationFrame(() => this.tickCompensation());
  }

  private stopDenoiseCompensation(): void {
    if (this.dnCompRaf) {
      cancelAnimationFrame(this.dnCompRaf);
      this.dnCompRaf = 0;
    }
    for (const a of [this.dnPreAnalyser, this.dnPostAnalyser]) {
      try {
        a?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.dnPreAnalyser = null;
    this.dnPostAnalyser = null;
  }

  /** 当前自适应补偿增益（调试 / 展示用） */
  getMakeupGain(): number {
    return this.micDenoise ? this.makeupGain : 1;
  }

  private setMicGainAvailable(available: boolean): void {
    if (this.micGainAvailable === available) return;
    this.micGainAvailable = available;
    this.emit();
  }

  getMicTrack(): MediaStreamTrack | null {
    return this.micOutputTrack;
  }

  /** 麦克风开关：同时作用于采集轨与发布轨，避免两条链路不一致 */
  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled;
    if (this.micInputTrack) this.micInputTrack.enabled = enabled;
    if (this.micOutputTrack) this.micOutputTrack.enabled = enabled;
  }

  setMicVolume(v: number): void {
    this.volumes = { ...this.volumes, mic: clamp(v, MIC_VOLUME_MAX) };
    if (this.micGain && this.ctx) {
      // 用当前自适应出来的补偿值（而非固定常量）
      const boost = this.micDenoise ? this.makeupGain : 1;
      this.micGain.gain.setTargetAtTime(
        this.volumes.mic * boost,
        this.ctx.currentTime,
        GAIN_SMOOTHING,
      );
    }
    this.persist();
    this.emit();
  }

  releaseMic(): void {
    this.stopDenoiseCompensation();
    try {
      this.micSource?.disconnect();
      this.micGain?.disconnect();
      this.micAnalyser?.disconnect();
      this.micDest?.disconnect();
    } catch {
      /* 忽略 */
    }
    this.micSource = null;
    this.micGain = null;
    this.micAnalyser = null;
    this.micDest = null;
    this.micInputTrack = null;
    this.micOutputTrack = null;
    this.micUid = null;
    // 下次进房默认开麦，避免把上一次的静音状态带过去（界面会显示成已开麦）
    this.micEnabled = true;
    this.micDenoise = false;
    this.makeupGain = DENOISE_MAKEUP_FALLBACK;
    this.dnSpeechFrames = 0;
    this.micGainAvailable = false;
  }

  // ==========================================================
  //  输出链路：每个远端成员一个 <audio>，音量 = 总音量 × 该成员音量
  // ==========================================================

  async attachRemote(uid: string, stream: MediaStream): Promise<void> {
    if (stream.getAudioTracks().length === 0) return;

    this.streams.set(uid, stream);
    this.play(uid, stream);
    this.attachMeter(uid, stream);
  }

  private play(uid: string, stream: MediaStream): void {
    let el = this.players.get(uid);
    if (!el) {
      el = new Audio();
      el.autoplay = true;
      this.players.set(uid, el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    this.applyOutputGain(uid);

    void el.play().catch(() => {
      // 自动播放被拦截时，等首次用户交互再试
      const retry = () => {
        void el?.play().catch(() => undefined);
        document.removeEventListener('click', retry);
        document.removeEventListener('pointerdown', retry);
      };
      document.addEventListener('click', retry);
      document.addEventListener('pointerdown', retry);
    });
  }

  /** 把「总音量 × 该成员音量」写进 <audio>.volume —— 这就是全部的输出音量控制 */
  private applyOutputGain(uid: string): void {
    const el = this.players.get(uid);
    if (!el) return;
    const user = this.mutedUsers.has(uid)
      ? 0
      : clamp(this.volumes.users[uid] ?? DEFAULT_VOLUME, PLAYBACK_VOLUME_MAX);
    el.volume = clamp(user * clamp(this.volumes.master, PLAYBACK_VOLUME_MAX), PLAYBACK_VOLUME_MAX);
  }

  /** 电平显示：分析器接在零增益汇点上，被渲染但不出声 */
  private attachMeter(uid: string, stream: MediaStream): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    this.detachMeter(uid);
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyser.connect(this.silentSink ?? ctx.destination);
      this.meters.set(uid, { source, analyser });
    } catch {
      // 只影响说话光圈 / 音量条，绝不影响声音
    }
  }

  private detachMeter(uid: string): void {
    const meter = this.meters.get(uid);
    if (!meter) return;
    try {
      meter.source.disconnect();
      meter.analyser.disconnect();
    } catch {
      /* 忽略 */
    }
    this.meters.delete(uid);
  }

  detachRemote(uid: string): void {
    this.streams.delete(uid);
    this.detachMeter(uid);

    const el = this.players.get(uid);
    if (el) {
      el.srcObject = null;
      el.pause();
      this.players.delete(uid);
    }
  }

  detachAllRemotes(): void {
    for (const uid of [...this.streams.keys()]) this.detachRemote(uid);
    // 兜底：清掉任何残留的播放器
    for (const uid of [...this.players.keys()]) this.detachRemote(uid);
  }

  hasRemote(uid: string): boolean {
    return this.players.has(uid);
  }

  /** uid → AnalyserNode（远端 + 自己），供电平读取 */
  getAnalysers(): Map<string, AnalyserNode> {
    const map = new Map<string, AnalyserNode>();
    if (this.micUid && this.micAnalyser) map.set(this.micUid, this.micAnalyser);
    for (const [uid, meter] of this.meters) map.set(uid, meter.analyser);
    return map;
  }

  /** 自己的麦克风电平（0–1，读一次分析器）。没建管线时为 0 */
  getMicLevel(): number {
    const analyser = this.micAnalyser;
    if (!analyser) return 0;

    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i]! - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }

  /**
   * 拿到【正在运行】的 AudioContext（给界面音效用）。
   * 没解锁 / 不存在时返回 null —— 音效宁可不发，也不能把 context 拉成 suspended。
   */
  getContextIfRunning(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    return ctx;
  }

  setUserVolume(uid: string, v: number): void {
    const next = clamp(v, PLAYBACK_VOLUME_MAX);
    this.volumes = { ...this.volumes, users: { ...this.volumes.users, [uid]: next } };
    // 调大音量视为取消静音，符合直觉
    if (next > 0 && this.mutedUsers.has(uid)) {
      this.mutedUsers = new Set(this.mutedUsers);
      this.mutedUsers.delete(uid);
    }
    this.applyOutputGain(uid);
    this.persist();
    this.emit();
  }

  setUserMuted(uid: string, muted: boolean): void {
    const next = new Set(this.mutedUsers);
    if (muted) next.add(uid);
    else next.delete(uid);
    this.mutedUsers = next;
    this.applyOutputGain(uid);
    this.persist();
    this.emit();
  }

  setMasterVolume(v: number): void {
    this.volumes = { ...this.volumes, master: clamp(v, PLAYBACK_VOLUME_MAX) };
    // 总音量是乘数，影响所有人 → 逐个重算
    for (const uid of this.players.keys()) this.applyOutputGain(uid);
    this.persist();
    this.emit();
  }

  // ==========================================================
  //  状态订阅（React）
  // ==========================================================

  private buildSnapshot(): MixerSnapshot {
    return {
      mic: this.volumes.mic,
      master: this.volumes.master,
      users: { ...this.volumes.users },
      mutedUsers: [...this.mutedUsers],
      degraded: !this.micGainAvailable,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MixerSnapshot => this.snapshot;

  getServerSnapshot = (): MixerSnapshot => DEFAULT_SNAPSHOT;

  private persist(): void {
    if (typeof window === 'undefined') return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      saveSettings({
        volumes: {
          mic: this.volumes.mic,
          master: this.volumes.master,
          users: this.volumes.users,
          mutedUsers: [...this.mutedUsers],
        },
      });
    }, PERSIST_DEBOUNCE_MS);
  }

  /** 调试快照：控制台执行 `__cfAudioMixer.debugState()` */
  debugState(): Record<string, unknown> {
    const el = [...this.players.values()][0];
    return {
      contextState: this.ctx?.state ?? 'none',
      micGainAvailable: this.micGainAvailable,
      micVolume: this.volumes.mic,
      masterVolume: this.volumes.master,
      micPipelineReady: !!this.micOutputTrack,
      micInputEnabled: this.micInputTrack?.enabled ?? null,
      micOutputEnabled: this.micOutputTrack?.enabled ?? null,
      /** 降噪开关与自适应补偿（1 = 不补偿；越大说明降噪削掉的电平越多） */
      denoiseActive: this.micDenoise,
      makeupGain: +this.getMakeupGain().toFixed(3),
      makeupSpeechFrames: this.dnSpeechFrames,
      effectiveMicGain: this.micGain
        ? +(this.micGain.gain.value).toFixed(3)
        : null,
      playerUids: [...this.players.keys()],
      meterUids: [...this.meters.keys()],
      streamUids: [...this.streams.keys()],
      samplePlayerVolume: el ? el.volume : null,
      samplePlayerPaused: el ? el.paused : null,
      userVolumes: { ...this.volumes.users },
      mutedUsers: [...this.mutedUsers],
    };
  }

  /** 调试用：读一次各路的实时电平（0–1） */
  debugLevels(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [uid, analyser] of this.getAnalysers()) {
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      out[uid] = Math.sqrt(sum / buf.length);
    }
    return out;
  }
}

/** 全应用唯一实例 */
export const audioMixer = new AudioMixer();

// 调试入口：控制台执行 `__cfAudioMixer.debugState()` / `.debugLevels()`
declare global {
  interface Window {
    __cfAudioMixer?: AudioMixer;
  }
}
if (typeof window !== 'undefined') {
  window.__cfAudioMixer = audioMixer;
}

// 第一次点击（捕获阶段，先于 React 处理器）就把 AudioContext 点着。
// 这是浏览器自动播放策略下唯一可靠的解锁时机 —— 进房链路隔着网络请求与
// 麦克风授权两次 await，到那时手势早就用不上了。
if (typeof document !== 'undefined') {
  const unlockOnce = () => {
    audioMixer.unlock();
    document.removeEventListener('pointerdown', unlockOnce, true);
    document.removeEventListener('keydown', unlockOnce, true);
  };
  document.addEventListener('pointerdown', unlockOnce, true);
  document.addEventListener('keydown', unlockOnce, true);
}

// ============================================================
//  React 绑定
// ============================================================

export function useMixerVolumes(): MixerSnapshot {
  return useSyncExternalStore(
    audioMixer.subscribe,
    audioMixer.getSnapshot,
    audioMixer.getServerSnapshot,
  );
}

/**
 * 说话判定 —— 迟滞（hysteresis）+ 保持（hold）。
 *
 * 单阈值会在临界电平上一秒内亮灭多次（表现为图标「闪」），所以拆成两个阈值：
 *   - 电平升过 ON    → 立刻亮（快攻）
 *   - 电平低于 OFF   → 还要持续 HOLD_MS 才灭（慢放，钉住一会儿）
 *   - 两者之间的迟滞带 → 维持现状
 */
export const SPEAKING_ON_THRESHOLD = 0.1;
export const SPEAKING_OFF_THRESHOLD = 0.05;
export const SPEAKING_HOLD_MS = 350;

/**
 * 「谁在说话」—— 只在【成员集合变化时】才触发重渲染。
 *
 * 自带 rAF 循环直读分析器，不经过「每帧 setState 电平表」那一层，
 * 所以订阅它的组件不会因为电平抖动而高频重渲染。
 */
export function useSpeakingSet(enabled = true): Set<string> {
  const [set, setSet] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!enabled) {
      setSet((prev) => (prev.size === 0 ? prev : new Set<string>()));
      return;
    }

    let stopped = false;
    let raf = 0;
    let buf = new Uint8Array(512);
    /** uid → 说话状态（迟滞 + 保持） */
    const state = new Map<string, { on: boolean; belowSince: number | null }>();

    const tick = () => {
      if (stopped) return;

      const now = performance.now();
      const next = new Set<string>();
      const seen = new Set<string>();

      for (const [uid, analyser] of audioMixer.getAnalysers()) {
        seen.add(uid);
        if (buf.length !== analyser.fftSize) buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);

        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);

        const st = state.get(uid) ?? { on: false, belowSince: null };
        if (level >= SPEAKING_ON_THRESHOLD) {
          st.on = true;
          st.belowSince = null;
        } else if (level < SPEAKING_OFF_THRESHOLD) {
          if (st.on) {
            if (st.belowSince === null) st.belowSince = now;
            else if (now - st.belowSince >= SPEAKING_HOLD_MS) {
              st.on = false;
              st.belowSince = null;
            }
          }
        } else {
          // 迟滞带：维持现状
          st.belowSince = null;
        }
        state.set(uid, st);
        if (st.on) next.add(uid);
      }

      // 离开房间 / 轨道关闭的人直接清掉
      for (const uid of [...state.keys()]) {
        if (!seen.has(uid)) state.delete(uid);
      }

      setSet((prev) => {
        if (prev.size === next.size && [...next].every((u) => prev.has(u))) return prev;
        return next;
      });

      raf = requestAnimationFrame(tick);
    };

    tick();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [enabled]);

  return set;
}
