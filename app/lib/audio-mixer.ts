import { useEffect, useState, useSyncExternalStore } from 'react';

import { attachDenoise, DENOISE_LATENCY_SAMPLES, detachDenoise, prewarmDenoise, type DenoiseEngine } from './denoise';
import { applyMicInputConstraints } from './sfu-session';
import {
  loadSettings,
  saveSettings,
  DEFAULT_VOICE_GATE,
  type MicInputPrefs,
  type VoiceGatePrefs,
} from './settings';
import { applyVoiceGatePrefs, createVoiceGate, type VoiceGateReport } from './voice-gate';

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
/** 高通截止频率（Hz）：滤掉隆隆声/桌面震动/手持噪声 */
const HIGHPASS_HZ = 120;
/** 软限幅拐点：|x| 超过它才开始饱和，最终不超过 1.0（0dBFS） */
const LIMITER_KNEE = 0.7;

/**
 * 降噪补偿的起点与边界。
 *
 * GTCRN/RNNoise 是谱减模型：噪声底被大幅削掉，语音也会被衰减一部分，
 * 于是「开了降噪声音变小」。补偿量取决于环境和输入电平 —— 安静时衰减少、
 * 嘈杂时衰减多，固定值必然两头不讨好。
 *
 * 所以这里只在自适应尚未测到足够语音时用 FALLBACK 兜底，一旦测出来就由
 * `startDenoiseCompensation()` 实时对齐。FALLBACK 取偏小的值：宁可开头两秒
 * 略轻，也不要在还没测量之前先把残留噪声抬起来。
 */
const DENOISE_MAKEUP_FALLBACK = 1.25;
/** 补偿下限：不低于原始（补偿的语义是「补回来」，不是「调小」） */
const MAKEUP_MIN = 1;
/** 补偿上限：再高就只是把残留噪声和量化噪声一起放大，而且开始逼近限幅拐点 */
const MAKEUP_MAX = 2;

// ---- 补偿环路的测量参数 ----
/** 补偿的调节周期（毫秒）。20Hz 足够跟踪环境变化，没必要跟着 rAF 跑 60Hz */
const MAKEUP_TICK_MS = 50;
/** 语音频段（Hz）。只比这一段，避免低频隆隆声与高频嘶声被算成「语音衰减」 */
const SPEECH_BAND_LOW_HZ = 200;
const SPEECH_BAND_HIGH_HZ = 3400;
/** 噪声底跟踪系数：往下（环境变安静）跟得快，往上（把持续人声当噪声底）极慢 */
const NOISE_FLOOR_FALL = 0.35;
const NOISE_FLOOR_RISE = 0.004;
/** 高于噪声底这么多 dB 才算「有人在说话」，避免拿停顿段去比 */
const SPEECH_MARGIN_DB = 10;
/** 至少累计这么多「有声」帧才开始调整，避免被开口瞬间误导 */
const MAKEUP_MIN_SPEECH_FRAMES = 10;
/** 目标增益与当前值相差小于这个数就不写 AudioParam（省掉无意义的平滑事件） */
const MAKEUP_DEADBAND = 0.03;
/** 收敛速率（每秒）：抬升慢（怕放大噪声）、回落快（怕一直偏响） */
const MAKEUP_RISE_RATE = 0.25;
const MAKEUP_FALL_RATE = 0.6;
/** 连续这么多拍「输入有声、输出恰好全零」→ 判定 worklet 根本没在工作 */
const DEAD_NODE_TICKS = 20;
/**
 * 门限节点的存活检测窗口（毫秒）。
 * worklet 每约 50ms 会上报一次电平；超过这个时间一次都没上报，
 * 说明它在音频线程里没跑起来 —— 摘掉直连，绝不冒「麦克风变哑巴」的风险。
 */
const GATE_WATCHDOG_MS = 2500;
/** 音量写 localStorage 的防抖（毫秒） */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * 软限幅曲线（WaveShaper）。
 *
 * `mic` 最大 2×、补偿最大 2×，理论增益 4 倍 —— 而 Web Audio 的
 * MediaStreamDestination 不会替你限幅，超过 0dBFS 就是硬削波（发破音）。
 * 这里 |x| ≤ KNEE 完全线性，之后用 tanh 平滑饱和到 1.0：与硬削波相比
 * 不产生刺耳的高频谐波，代价只是拐点以上有轻微压缩。
 * 曲线端点是 1.0（除以 tanh(1) 归一化），所以再大的输入也不会超过 0dBFS。
 */
const SOFT_CLIP_CURVE = (() => {
  const n = 2048;
  const curve = new Float32Array(n);
  const span = 1 - LIMITER_KNEE;
  const norm = Math.tanh(1);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] =
      a <= LIMITER_KNEE
        ? x
        : Math.sign(x) * (LIMITER_KNEE + span * (Math.tanh((a - LIMITER_KNEE) / span) / norm));
  }
  return curve;
})();

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
  /**
   * 降噪 worklet「建起来了但没有任何输出」——已自动回退直连。
   * 这是 wasm 在 worklet 内部静默初始化失败的典型表现，必须让用户知道，
   * 否则他会以为降噪开着（而实际发的是原始麦克风）。
   */
  denoiseFailed: boolean;
}

/** 内部音量状态：静音名单与降级标记单独存 */
type VolumeState = { mic: number; master: number; users: Record<string, number> };

const DEFAULT_SNAPSHOT: MixerSnapshot = {
  mic: 1,
  master: 1,
  users: {},
  mutedUsers: [],
  degraded: false,
  denoiseFailed: false,
};

function clamp(v: number, max: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VOLUME;
  return Math.min(max, Math.max(0, v));
}

class AudioMixer {
  private ctx: AudioContext | null = null;

  // ---- 输入链路（录制音量，需要 Web Audio） ----
  private micSource: MediaStreamAudioSourceNode | null = null;
  /** 高通：挂在降噪之前，滤掉隆隆声（顺带让补偿的测量更干净） */
  private micHighpass: BiquadFilterNode | null = null;
  /** 降噪段的输入节点（= 高通）。降级时直接把它接回 gain */
  private micInputNode: AudioNode | null = null;
  private micGain: GainNode | null = null;
  /** 软限幅：保证发出去的信号不超过 0dBFS（Destination 不会替你限幅） */
  private micLimiter: WaveShaperNode | null = null;
  /**
   * 语音门限节点。**常驻链路**：开关只改 AudioParam，不重接线，
   * 所以开关门不会产生任何音频中断。
   */
  private micGate: AudioWorkletNode | null = null;
  /** 门限当前生效的参数（主线程侧留一份，供 debug / 重连后复述） */
  private gatePrefs: VoiceGatePrefs = { ...DEFAULT_VOICE_GATE };
  /** 门限节点上报过数据（没上报过 = 节点没跑起来 → 兜底摘掉） */
  private gateReported = false;
  private gateWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次上报：UI 电平表用 */
  private gateLevelDb = -100;
  private gateOpen = true;
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
  /** 降噪节点「建起来了但没有输出」（wasm 在 worklet 内静默失败）→ 已回退直连 */
  private denoiseFailed = false;

  // ---- 降噪自适应补偿（比较降噪前后的语音电平） ----
  /** 降噪前的分析器（接在延迟后的输入上） */
  private dnPreAnalyser: AnalyserNode | null = null;
  /** 降噪后的分析器（挂在 worklet 输出上） */
  private dnPostAnalyser: AnalyserNode | null = null;
  /**
   * 两个分析器的接入点。断开时必须用 `tap.disconnect(analyser)` ——
   * 对 analyser 调 disconnect() 断的是它的**出边**，而 analyser 是死端、
   * 根本没有出边，那样写等于什么都没做（原实现就是这么写的，只是因为
   * 调用方随后恰好会 `source.disconnect()` 才没暴露出来）。
   */
  private dnPreTap: AudioNode | null = null;
  private dnPostTap: AudioNode | null = null;
  /** 把「降噪前」的测量延迟 worklet 的固有延迟，让两路在时间上对齐 */
  private dnPreDelay: DelayNode | null = null;
  private dnCompTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前补偿增益（自适应结果，1 = 不补偿） */
  private makeupGain = DENOISE_MAKEUP_FALLBACK;
  /** 已经写进 AudioParam 的补偿值（配合死区判断，避免无意义的平滑事件） */
  private dnWrittenGain = DENOISE_MAKEUP_FALLBACK;
  /** 已累计的「有声」帧数（够数才开始调整） */
  private dnSpeechFrames = 0;
  /** 噪声底估计（dBFS）：用来判断「有没有人在说话」 */
  private dnNoiseFloorDb = -100;
  /** 连续多少拍「输入有声而输出恰好全零」 */
  private dnDeadTicks = 0;
  /** 上一拍时间戳（按真实间隔平滑，不假设固定周期） */
  private dnLastTick = 0;
  /** 复用的分析缓冲（每拍 new 两个 Float32Array 是白给 GC 添活） */
  private dnPreBuf: Float32Array<ArrayBuffer> | null = null;
  private dnPostBuf: Float32Array<ArrayBuffer> | null = null;
  private dnTimeBuf: Float32Array<ArrayBuffer> | null = null;

  // ---- 输出链路（播放，只用 <audio>） ----
  /** uid → 播放用的 <audio>（真正出声的东西） */
  private players = new Map<string, HTMLAudioElement>();
  /** 首选输出设备（setSinkId）。空串 = 系统默认 */
  private outputDeviceId = '';
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
      const saved = loadSettings();
      this.outputDeviceId = saved.outputDeviceId ?? '';
      if (saved.volumes) {
        this.volumes = {
          mic: clamp(saved.volumes.mic ?? DEFAULT_VOLUME, MIC_VOLUME_MAX),
          master: clamp(saved.volumes.master ?? DEFAULT_VOLUME, PLAYBACK_VOLUME_MAX),
          users: { ...(saved.volumes.users ?? {}) },
        };
        this.mutedUsers = new Set(saved.volumes.mutedUsers ?? []);
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
    gate: VoiceGatePrefs = DEFAULT_VOICE_GATE,
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

      // 高通：隆隆声/桌面震动/手持噪声既影响听感，又会污染补偿环路的电平测量
      // （GTCRN/RNNoise 对 100Hz 以下几乎没有抑制力，但那段能量会被算进「语音衰减」）
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = HIGHPASS_HZ;
      highpass.Q.value = Math.SQRT1_2;

      const gain = ctx.createGain();
      // 降噪补偿：起始值只是兜底，真正的量由补偿环路实时测出来。
      // 用户可用「录制音量」滑块在其上再微调（两个增益是乘关系）。
      this.denoiseFailed = false;
      this.makeupGain = DENOISE_MAKEUP_FALLBACK;
      this.dnWrittenGain = DENOISE_MAKEUP_FALLBACK;
      this.dnSpeechFrames = 0;
      this.dnNoiseFloorDb = -100;
      this.dnDeadTicks = 0;

      const limiter = ctx.createWaveShaper();
      limiter.curve = SOFT_CLIP_CURVE;
      limiter.oversample = '4x';

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;

      const dest = ctx.createMediaStreamDestination();

      source.connect(highpass);

      // 降噪：highpass → [worklet] → gain。失败自动回退直连，不影响出声。
      // ⚠️ attachDenoise 内部已经把终点接到 gain 了，这里不能再接一次
      // （原实现在后面又 entry.connect(gain) 了一次；Web Audio 对同一对
      // termini 会去重所以不出错，但「这条边归谁管」会变得含糊，
      // 热切换时最容易在这里踩坑）。
      const entry: AudioNode = await attachDenoise(highpass, gain, denoise);

      // ⚠️ 「降噪生效」必须以**真的挂上了 worklet** 为准：初始化失败或采样率
      // 不支持时 attachDenoise 返回的是输入本身（直连）。原实现无条件把
      // micDenoise 置为 true，那种情况下就会平白把增益乘上补偿系数（1.25×），
      // 而且是无声的 —— 音量条看着正常，实际已经过放。
      this.micDenoise = denoise !== 'off' && entry !== highpass;
      this.denoiseFailed = denoise !== 'off' && entry === highpass;
      if (this.denoiseFailed) {
        console.error(`[denoise] ${denoise} 未能生效，当前发送的是原始麦克风`);
      }
      gain.gain.value = this.volumes.mic * (this.micDenoise ? this.makeupGain : 1);

      // 语音门限：常驻链路（gain → gate → limiter）。
      // 检测走**侧链**，直接从 source 取原始麦克风 —— 不经降噪、不经自适应补偿，
      // 所以阈值不会因为补偿量在 1.0–2.0 之间浮动而漂移。
      // ⚠️ 侧链只能挂在 source 上：attachDenoise 换引擎时会 disconnect 高通，
      //    挂在高通上的侧链会被一并断掉；而 source 的出边只有 releaseMic 才清。
      this.gatePrefs = { ...gate };
      this.gateLevelDb = -100;
      this.gateOpen = true;
      this.gateReported = false;
      const gateNode = await createVoiceGate(ctx, gate);
      this.micGate = gateNode;
      if (gateNode) {
        gain.connect(gateNode); // input 0：主链路
        source.connect(gateNode, 0, 1); // input 1：检测侧链
        gateNode.connect(limiter);
        gateNode.port.onmessage = (ev: MessageEvent<VoiceGateReport>) => {
          this.gateReported = true;
          this.gateLevelDb = ev.data.levelDb;
          this.gateOpen = ev.data.open;
        };
        this.gateWatchdog = setTimeout(() => {
          this.gateWatchdog = null;
          if (!this.gateReported) this.bypassVoiceGate('节点没有上报过数据（没跑起来）');
        }, GATE_WATCHDOG_MS);
      } else {
        // worklet 没加载起来：直连。宁可没有门限，也不能没声
        gain.connect(limiter);
      }

      limiter.connect(dest);
      // 电平表接在限幅之后 —— 它读到的就是真正发出去的信号
      limiter.connect(analyser);
      // 刻意不接 ctx.destination —— 否则自己会听到自己

      this.micSource = source;
      this.micHighpass = highpass;
      this.micInputNode = highpass;
      this.micGain = gain;
      this.micLimiter = limiter;
      this.micAnalyser = analyser;
      this.micDest = dest;
      this.micInputTrack = input;
      this.micUid = uid;

      // 降噪生效时启动自适应补偿（对比 worklet 前后的语音电平，动态对齐响度）
      if (this.micDenoise && entry !== highpass) {
        this.attachCompensationAnalysers(ctx, highpass, entry);
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
   * 现在只重新接线 Web Audio 图内部的一段：gain / limiter / analyser / dest /
   * 已发布轨道全程不动，协商层面什么都没发生。
   *
   * 静音窗：attachDenoise 是「先建后切」——新节点在旧链路继续出声的情况下建好，
   * 接线只在一个同步片段里改完，所以对端不会听到可感知的停顿（worklet 自身
   * 有约 13ms 的启动延迟，那一小段仍是静音，但远低于可感知阈值）。
   */
  async swapDenoise(engine: DenoiseEngine): Promise<boolean> {
    const ctx = this.ensureContext();
    const input = this.micInputNode;
    const gain = this.micGain;
    if (!ctx || !input || !gain) return false;

    await this.resume();

    // 补偿分析器**先不动**：attachDenoise 建新节点期间旧链路还在出声，分析器
    // 也还挂在旧链路上，测量不中断；等接线换完再一次性重建。
    const entry = await attachDenoise(input, gain, engine);
    // attachDenoise 在初始化失败/采样率不支持时返回输入本身（= 实际直连）
    const fellBack = engine !== 'off' && entry === input;
    this.micDenoise = engine !== 'off' && !fellBack;
    this.denoiseFailed = fellBack;
    if (fellBack) console.error(`[denoise] ${engine} 未能生效，当前发送的是原始麦克风`);

    // 接线已换完：立刻重建补偿。这几步与上面的接线同处一个同步片段，
    // 中间不会有计时器插进来，所以不会把「新节点刚开始的 13ms 静音」
    // 误判成「节点没有输出」。
    this.stopDenoiseCompensation();

    // 切换引擎后衰减特性会变（GTCRN 与 RNNoise 不同），补偿要重新测量
    this.makeupGain = DENOISE_MAKEUP_FALLBACK;
    this.dnWrittenGain = DENOISE_MAKEUP_FALLBACK;
    this.dnSpeechFrames = 0;
    this.dnNoiseFloorDb = -100;
    this.dnDeadTicks = 0;

    if (this.micDenoise) this.attachCompensationAnalysers(ctx, input, entry);

    // 补偿增益跟随引擎状态（自适应循环随后会把它调到合适值）
    const boost = this.micDenoise ? this.makeupGain : 1;
    gain.gain.setTargetAtTime(this.volumes.mic * boost, ctx.currentTime, GAIN_SMOOTHING);

    // 维持当前的麦克风开关状态（新链路要沿用旧的 enabled）
    this.setMicEnabled(this.micEnabled);
    this.emit();

    // ⚠️ 返回值必须是「请求的引擎是否真的生效」。
    // 原实现写的是 `entry !== null`，而 attachDenoise 从不返回 null，
    // 所以永远返回 true —— 面板于是永远显示「降噪已生效」，
    // 哪怕实际已经回退成原始麦克风。
    return engine === 'off' || entry !== input;
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
   *
   * 这里有两处对原实现的修正，都是让「比值」这个量真正成立的前提：
   *
   *   1. **延迟对齐**。worklet 有 DENOISE_LATENCY_SAMPLES 的固有延迟。原实现
   *      在同一个时刻读两个 512 点（10.7ms）窗，而两组样本实际错开 640 点 ——
   *      两个窗**完全不重叠**，等于拿「现在」和「13ms 前」比。语音在 10ms 尺度
   *      上起伏极大，比值于是在字头/字尾剧烈跳动（听感就是「抽一下」）。
   *      解法：给「降噪前」这一路串一个等长的 DelayNode。
   *   2. **只看语音频段**。宽带 RMS 会把噪声能量算进「降噪前」，使比值系统性
   *      偏大 → 过度补偿 → 反过来把残留噪声抬起来。改用 200–3400Hz 的频段能量。
   */
  private attachCompensationAnalysers(
    ctx: AudioContext,
    pre: AudioNode,
    post: AudioNode,
  ): void {
    this.stopDenoiseCompensation();

    const mk = () => {
      const a = ctx.createAnalyser();
      // 频域分辨率要够切语音频段：2048 点 @48k → 每个 bin 约 23.4Hz
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0;
      return a;
    };
    const preA = mk();
    const postA = mk();

    // 把「降噪前」这一路整体延迟 worklet 的固有延迟，两路才对得上
    const preDelay = ctx.createDelay(0.1);
    preDelay.delayTime.value = DENOISE_LATENCY_SAMPLES / ctx.sampleRate;

    // 分析器是死端：只读取电平，不参与出声
    pre.connect(preDelay);
    preDelay.connect(preA);
    post.connect(postA);

    this.dnPreAnalyser = preA;
    this.dnPostAnalyser = postA;
    this.dnPreTap = pre;
    this.dnPostTap = post;
    this.dnPreDelay = preDelay;

    // 频域缓冲复用：每拍 new 两个 Float32Array（20 次/秒）纯属给 GC 添活
    this.dnPreBuf = new Float32Array(preA.frequencyBinCount);
    this.dnPostBuf = new Float32Array(postA.frequencyBinCount);
    this.dnTimeBuf = new Float32Array(postA.fftSize);

    this.dnLastTick = performance.now();
    // 用 setInterval 而不是 rAF：后台标签页里 rAF 会完全停摆，
    // 而语音通话经常就在后台标签页里跑。setInterval 会被节流到 ~1Hz，
    // 那也够跟踪环境变化了。
    this.dnCompTimer = setInterval(() => this.tickCompensation(), MAKEUP_TICK_MS);
  }

  /** 语音频段的平均功率（dBFS）。返回 -Infinity 表示这一段是数字静音 */
  private bandDb(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
    analyser.getFloatFrequencyData(buf);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const lo = Math.max(1, Math.ceil(SPEECH_BAND_LOW_HZ / binHz));
    const hi = Math.min(buf.length - 1, Math.floor(SPEECH_BAND_HIGH_HZ / binHz));

    let power = 0;
    for (let i = lo; i <= hi; i++) {
      const db = buf[i]!;
      if (Number.isFinite(db)) power += Math.pow(10, db / 10);
    }
    if (power <= 0) return -Infinity;
    return 10 * Math.log10(power / (hi - lo + 1));
  }

  /** 自适应循环：测语音电平 → 求衰减量 → 平滑调整补偿增益 */
  private tickCompensation(): void {
    const preA = this.dnPreAnalyser;
    const postA = this.dnPostAnalyser;
    const gain = this.micGain;
    const ctx = this.ctx;
    const preBuf = this.dnPreBuf;
    const postBuf = this.dnPostBuf;

    if (!preA || !postA || !gain || !ctx || !this.micDenoise || !preBuf || !postBuf) {
      // 注意：不要在这里把计时器清掉 —— 生命周期归 stopDenoiseCompensation 管
      return;
    }

    const preDb = this.bandDb(preA, preBuf);
    const postDb = this.bandDb(postA, postBuf);

    // ---- 噪声底跟踪 ----
    // 向下跟得快（环境变安静要立刻反映），向上极慢 —— 否则一段持续说话会被
    // 当成噪声底，VAD 就再也不触发了。
    if (Number.isFinite(preDb)) {
      if (this.dnNoiseFloorDb <= -99) {
        // 第一拍直接落位。否则从 -100 爬到真实底噪要几十秒
        //（上升系数是 0.004/拍），这期间 VAD 会一直判「有人在说话」。
        // 先假设第一拍是语音、把底噪压在它下面 12dB：若第一拍其实是静音，
        // 下面 postDb 的静音保护会兜住，不会有副作用。
        this.dnNoiseFloorDb = preDb - 12;
      } else {
        const k = preDb < this.dnNoiseFloorDb ? NOISE_FLOOR_FALL : NOISE_FLOOR_RISE;
        this.dnNoiseFloorDb += (preDb - this.dnNoiseFloorDb) * k;
      }
    }
    const speech = Number.isFinite(preDb) && preDb > this.dnNoiseFloorDb + SPEECH_MARGIN_DB;

    // ---- 死节点检测 ----
    // worklet 里的 wasm 没起来时，process() 照样返回 true，但一个样本都不写，
    // 输出是【恰好全零】—— 这和「安静」不一样，安静时输出是极小的非零值。
    // 判据因此是「输入有声 + 输出恰好全零」，连续 DEAD_NODE_TICKS 拍即判定为死。
    if (speech && this.dnTimeBuf) {
      const timeBuf = this.dnTimeBuf;
      postA.getFloatTimeDomainData(timeBuf);
      let peak = 0;
      for (let i = 0; i < timeBuf.length; i++) {
        const v = Math.abs(timeBuf[i]!);
        if (v > peak) peak = v;
      }
      this.dnDeadTicks = peak === 0 ? this.dnDeadTicks + 1 : 0;
      if (this.dnDeadTicks >= DEAD_NODE_TICKS) {
        this.fallbackFromDeadDenoise();
        return;
      }
    } else {
      this.dnDeadTicks = 0;
    }

    // ---- 只在「确实有人在说话」时采样 ----
    // 静音段里模型会把底噪压到接近 0，此时算衰减量会得到虚高的补偿目标
    if (speech && Number.isFinite(postDb) && postDb > -90) {
      this.dnSpeechFrames++;

      // 累计足够帧才动增益：避免开口瞬间就猛调一下（听感同样是「抽一下」）
      if (this.dnSpeechFrames >= MAKEUP_MIN_SPEECH_FRAMES) {
        // 模型在这一段把语音频段压掉了多少 dB → 就补回来多少
        const attenuationDb = Math.max(0, preDb - postDb);
        const target = Math.min(
          MAKEUP_MAX,
          Math.max(MAKEUP_MIN, Math.pow(10, attenuationDb / 20)),
        );

        // 指数平滑（按真实间隔算，不假设固定周期）：抬升慢（怕放大噪声）、
        // 回落快（怕一直偏响）
        const now = performance.now();
        const dt = this.dnLastTick
          ? Math.min(0.5, (now - this.dnLastTick) / 1000)
          : MAKEUP_TICK_MS / 1000;
        const rate = target > this.makeupGain ? MAKEUP_RISE_RATE : MAKEUP_FALL_RATE;
        this.makeupGain += (target - this.makeupGain) * (1 - Math.exp(-rate * dt));
      }
    }

    // 死区：目标值与「已经写进 AudioParam 的值」差得太小就别写 ——
    // 每写一次都会产生一条平滑事件，没必要每秒 20 次都去动它
    if (Math.abs(this.makeupGain - this.dnWrittenGain) >= MAKEUP_DEADBAND) {
      this.dnWrittenGain = this.makeupGain;
      gain.gain.setTargetAtTime(
        this.volumes.mic * this.makeupGain,
        ctx.currentTime,
        GAIN_SMOOTHING,
      );
    }

    this.dnLastTick = performance.now();
  }

  /**
   * 降噪节点「活着但没有输出」→ 回退直连，并让界面知道。
   *
   * 这条兜底路径是必需的：worklet 内部 wasm 初始化失败是**静默**的，
   * 不检测的话用户会一直以为降噪在生效，而实际发出去的是一条全零轨道
   * ——对端什么都听不到。
   */
  private fallbackFromDeadDenoise(): void {
    console.error('[denoise] 降噪节点没有任何输出（wasm 未就绪），已回退原始麦克风');
    const input = this.micInputNode;
    const gain = this.micGain;
    const ctx = this.ctx;

    this.stopDenoiseCompensation();
    detachDenoise();

    this.micDenoise = false;
    this.denoiseFailed = true;
    this.makeupGain = DENOISE_MAKEUP_FALLBACK;
    this.dnWrittenGain = DENOISE_MAKEUP_FALLBACK;

    if (input && gain) {
      try {
        input.disconnect();
      } catch {
        /* 没有出边时会抛，忽略 */
      }
      input.connect(gain);
    }
    if (gain && ctx) {
      gain.gain.setTargetAtTime(this.volumes.mic, ctx.currentTime, GAIN_SMOOTHING);
    }
    this.emit();
  }

  private stopDenoiseCompensation(): void {
    if (this.dnCompTimer) {
      clearInterval(this.dnCompTimer);
      this.dnCompTimer = null;
    }

    // 断开必须从**接入点**这一侧断。对 analyser 调 disconnect() 断的是它的
    // 出边，而 analyser 是死端、根本没有出边 —— 那样写等于什么都没做
    // （原实现就是这么写的，只是因为调用方随后恰好会 source.disconnect()
    // 才没暴露出来；这种隐式依赖一旦被改动就会静默失效）。
    const links: Array<[AudioNode | null, AudioNode | null]> = [
      [this.dnPreTap, this.dnPreDelay],
      [this.dnPreDelay, this.dnPreAnalyser],
      [this.dnPostTap, this.dnPostAnalyser],
    ];
    for (const [from, to] of links) {
      if (!from || !to) continue;
      try {
        from.disconnect(to);
      } catch {
        /* 边已经不在了 */
      }
    }

    this.dnPreAnalyser = null;
    this.dnPostAnalyser = null;
    this.dnPreTap = null;
    this.dnPostTap = null;
    this.dnPreDelay = null;
    this.dnPreBuf = null;
    this.dnPostBuf = null;
    this.dnTimeBuf = null;
    this.dnSpeechFrames = 0;
    this.dnDeadTicks = 0;
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

  /**
   * 当前是否有一条可用的麦克风管线（在房间里且建起来了）。
   * 用来区分「不在房间，等下次进房生效」与「在房间里但操作失败」。
   */
  hasMicPipeline(): boolean {
    return this.micInputNode !== null && this.micGain !== null;
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
    // 门限节点的存活检测计时器与消息回调也要一并清掉，
    // 否则它可能在管线已经拆掉之后触发，去连一堆死节点。
    if (this.gateWatchdog) {
      clearTimeout(this.gateWatchdog);
      this.gateWatchdog = null;
    }
    if (this.micGate) {
      try {
        this.micGate.port.onmessage = null;
      } catch {
        /* ignore */
      }
    }
    // 顺带把降噪 worklet 也摘掉：它不在上面这组引用里（activeNode 在 denoise
    // 模块内部），不摘的话 wasm 状态会一直挂着，直到下一次 attachDenoise
    // 才被顺带释放。
    detachDenoise();
    try {
      this.micSource?.disconnect();
      this.micHighpass?.disconnect();
      this.micGain?.disconnect();
      this.micGate?.disconnect();
      this.micLimiter?.disconnect();
      this.micAnalyser?.disconnect();
      this.micDest?.disconnect();
    } catch {
      /* 忽略 */
    }
    this.micSource = null;
    this.micHighpass = null;
    this.micInputNode = null;
    this.micGain = null;
    this.micGate = null;
    this.micLimiter = null;
    this.micAnalyser = null;
    this.micDest = null;
    this.micInputTrack = null;
    this.micOutputTrack = null;
    this.micUid = null;
    this.gateReported = false;
    this.gateLevelDb = -100;
    this.gateOpen = true;
    // 下次进房默认开麦，避免把上一次的静音状态带过去（界面会显示成已开麦）
    this.micEnabled = true;
    this.micDenoise = false;
    this.denoiseFailed = false;
    this.makeupGain = DENOISE_MAKEUP_FALLBACK;
    this.dnWrittenGain = DENOISE_MAKEUP_FALLBACK;
    this.dnSpeechFrames = 0;
    this.dnNoiseFloorDb = -100;
    this.dnDeadTicks = 0;
    this.micGainAvailable = false;
  }

  /**
   * 预热降噪资源（worklet 模块 + wasm），让后续切换引擎几乎是瞬时的。
   * 失败无副作用：真正要用的时候还会按需加载一遍。
   */
  async prewarmDenoise(engine: DenoiseEngine): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx || engine === 'off') return;
    await prewarmDenoise(ctx, engine);
  }

  /**
   * 【设置面板调用】切换浏览器自带的降噪 / 自动增益。
   *
   * 这两个量作用在采集轨上，不在 Web Audio 图里，所以只能靠 applyConstraints
   * 热改，而且不是所有浏览器都支持。返回 false = 没改成功，调用方应告诉用户
   * 「下次进房生效」，不能假设成功。
   */
  async applyMicInputPrefs(prefs: MicInputPrefs): Promise<boolean> {
    const track = this.micInputTrack;
    if (!track) return false;
    return applyMicInputConstraints(track, prefs);
  }

  // ==========================================================
  //  语音门限（低于阈值不发送；开门时音量精确不变）
  // ==========================================================

  /**
   * 【设置面板调用】开关 / 调整语音门限。
   * 只写 AudioParam，不重接线 —— 立即生效，且不会产生任何音频中断。
   */
  setVoiceGate(prefs: VoiceGatePrefs): void {
    this.gatePrefs = { ...prefs };
    if (this.micGate) applyVoiceGatePrefs(this.micGate, prefs);
  }

  /** 门限的实时状态（给设置面板的电平表用） */
  getVoiceGateState(): {
    available: boolean;
    levelDb: number;
    open: boolean;
    prefs: VoiceGatePrefs;
  } {
    return {
      available: this.micGate !== null,
      levelDb: this.micGate ? this.gateLevelDb : -100,
      open: this.gateOpen,
      prefs: { ...this.gatePrefs },
    };
  }

  /**
   * 把门限从链路里摘出去并直连。
   *
   * 触发场景：节点建起来了但在音频线程里一直没跑（一次上报都没有）。
   * 宁可没有门限，也绝不能因为门限让麦克风变成哑巴 ——
   * 这个教训在降噪 worklet 上已经吃过一次了。
   */
  private bypassVoiceGate(reason: string): void {
    const gate = this.micGate;
    if (!gate) return;
    console.error(`[voice-gate] ${reason}，已摘掉门限改为直连（不影响出声）`);

    if (this.gateWatchdog) {
      clearTimeout(this.gateWatchdog);
      this.gateWatchdog = null;
    }
    try {
      gate.port.onmessage = null;
    } catch {
      /* ignore */
    }
    // 从接入点这一侧断：gain → gate 与 source → gate(侧链)
    try {
      this.micGain?.disconnect(gate);
    } catch {
      /* ignore */
    }
    try {
      this.micSource?.disconnect(gate);
    } catch {
      /* ignore */
    }
    try {
      gate.disconnect();
    } catch {
      /* ignore */
    }

    this.micGate = null;
    this.gateReported = false;
    this.gateLevelDb = -100;
    this.gateOpen = true;

    if (this.micGain && this.micLimiter) {
      try {
        this.micGain.connect(this.micLimiter);
      } catch {
        /* ignore */
      }
    }
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
      // 新建的播放器立刻套用首选输出设备（换设备后新加入的人也要走对扬声器）
      void this.applySinkId(el);
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

  /**
   * 【设置面板调用】切换输出设备。返回是否所有播放器都切换成功。
   * 失败时保持原设备继续出声 —— 绝不能因为选错设备就彻底没声。
   */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    this.outputDeviceId = deviceId;
    let allOk = true;
    for (const el of this.players.values()) {
      if (!(await this.applySinkId(el))) allOk = false;
    }
    return allOk;
  }

  /**
   * 把首选输出设备写到某个 <audio> 上。
   *
   * `setSinkId` 不是所有浏览器都有（Safari/Firefox 没有），所以先探测再调用；
   * 失败就保持默认设备，并返回 false 让调用方如实告诉用户。
   */
  private async applySinkId(el: HTMLMediaElement): Promise<boolean> {
    const fn = (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (typeof fn !== 'function') return false;
    try {
      await fn.call(el, this.outputDeviceId);
      return true;
    } catch (err) {
      console.warn('[audio] 切换输出设备失败，继续用系统默认设备', err);
      return false;
    }
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
      denoiseFailed: this.denoiseFailed,
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
      /** 降噪节点没有输出（wasm 静默失败）→ 已回退直连 */
      denoiseFailed: this.denoiseFailed,
      makeupGain: +this.getMakeupGain().toFixed(3),
      makeupSpeechFrames: this.dnSpeechFrames,
      /** 语音频段的噪声底估计（dBFS）与「连续无输出」计数，排查用 */
      noiseFloorDb: +this.dnNoiseFloorDb.toFixed(1),
      deadTicks: this.dnDeadTicks,
      /** 语音门限：是否可用、当前档位、实时电平、门是开是关 */
      voiceGate: {
        available: this.micGate !== null,
        enabled: this.gatePrefs.enabled,
        thresholdDb: this.gatePrefs.thresholdDb,
        levelDb: +this.gateLevelDb.toFixed(1),
        open: this.gateOpen,
      },
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
