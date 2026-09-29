/**
 * 语音门限（voice gate）—— 低于阈值不发送，高于阈值原样通过。
 *
 * ============================================================
 *  三条硬约束（对应需求：阈值门控 + 不能影响声音大小）
 * ============================================================
 *
 * 1. 【开门时增益必须精确等于 1】
 *    主链路上只做一次乘法，不做压缩、不做增益补偿、不做任何滤波。
 *    滤波只作用在**检测支路**上。所以说话时输出与输入逐样本相同，
 *    音量一丝一毫都不变。
 *
 * 2. 【检测走侧链】input[1] 接原始麦克风。
 *    如果把检测放在主链路上，它看到的是经过自适应补偿的信号 ——
 *    补偿量在 1.0–2.0 之间浮动（最多 6dB），阈值就会跟着漂，
 *    用户设一次之后行为不可预期。
 *
 * 3. 【不能依赖 JS 定时器】
 *    后台标签页里 requestAnimationFrame 完全停摆、setInterval 被节流到 1Hz。
 *    语音通话经常就在后台标签页里跑，那样麦克风会永久哑掉。
 *    门控必须采样级地跑在音频线程里 —— 这就是本文件存在的理由。
 *
 * ============================================================
 *  为什么这样能在"不说话时"挡住键盘声
 * ============================================================
 * 键盘敲击只有 5–30ms，而检测包络的快起时间常数是 10ms ——
 * 一声孤立的敲击几乎抬不起包络，而人声是持续的，轻松越过阈值。
 * 这也是为什么包络不能取得太快。
 *
 * 残余的已知边界：**边说话边敲键盘**时门是开着的，敲击会照原样通过。
 * 这是任何门控的固有限制，不是实现问题。
 *
 * 参数（k-rate，随时可改，不需要重接线）：
 *   enabled      0/1
 *   thresholdDb  开门阈值（dBFS）。关阈值 = 阈值 - 6dB（迟滞）
 */

/** 检测包络：快起 */
const ENV_ATTACK_S = 0.012;
/** 检测包络：慢落（避免字与字之间门抖动） */
const ENV_RELEASE_S = 0.06;
/** 开门淡入（太快会有咔哒声，太慢会削掉字头） */
const GAIN_ATTACK_S = 0.002;
/** 关门淡出。不能太慢：慢了多少会漏掉"说完话紧接着敲的那几下" */
const GAIN_RELEASE_S = 0.06;
/** 低于关阈值之后还要保持开多久（秒）：词间停顿不该关门 */
const HOLD_S = 0.18;
/** 迟滞：关阈值比开阈值低这么多 dB，防止临界电平上反复开关 */
const HYSTERESIS_DB = 6;
/**
 * 检测支路的带通中心与 Q —— 这是整个文件里最要紧的一个选择。
 *
 * 键盘敲击是**宽带瞬态，能量集中在中高频**；而浊音（元音、绝大多数音节）
 * 有很强的基频周期性，能量集中在 80–250Hz 及其低次谐波。
 * 所以检测只取基频这一段，能同时做到两件事：
 *   - 说话时电平高（浊音在这里能量最集中）
 *   - 敲击时电平低（它的能量大多在 2–8kHz，落在这个带里的比例很小）
 *
 * ⚠️ 反过来的做法（高通、只看高频）会专挑敲击声最响的频段来检测 ——
 *    那等于把门做成「键盘一响就开」。
 *
 * 代价：清辅音（/s/ /f/）在这个带里能量很少，纯气声说话时门可能不开 ——
 * 靠 HOLD_S 的保持和前后浊音兜住。
 *
 * 单位说明：阈值比较的是**这个带通之后**的电平，不是麦克风的宽带 dBFS。
 * 界面上的电平表和阈值用的是同一个量，所以照样可以对着调。
 */
const DETECT_BAND_HZ = 260;
const DETECT_BAND_Q = 1.1;
/**
 * 前瞻：把主信号整体推迟这么多秒。
 * 检测支路不延迟，于是「门开」可以发生在声音到达输出之前 ——
 * 字头不会被削掉。代价是麦克风链路多出这几毫秒延迟（降噪 worklet 本来
 * 就有 13ms，这点无所谓）。
 */
const LOOKAHEAD_S = 0.004;

/** 关闭时的残余增益。0 = 完全不发送 */
const CLOSED_GAIN = 0;

class VoiceGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      {
        name: 'thresholdDb',
        defaultValue: -45,
        minValue: -100,
        maxValue: 0,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    const coef = (seconds) => 1 - Math.exp(-1 / Math.max(1, sr * seconds));

    this.envAtk = coef(ENV_ATTACK_S);
    this.envRel = coef(ENV_RELEASE_S);
    this.gainAtk = coef(GAIN_ATTACK_S);
    this.gainRel = coef(GAIN_RELEASE_S);
    this.holdMax = Math.max(1, Math.round(HOLD_S * sr));

    // 检测带通：RBJ biquad，峰值增益归一化到 0dB
    const w0 = (2 * Math.PI * DETECT_BAND_HZ) / sr;
    const alpha = Math.sin(w0) / (2 * DETECT_BAND_Q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;

    // 初值就是「开门 + 增益 1」：门的存在绝不能让开头缺一截
    this.env = 0;
    this.gain = 1;
    this.open = true;
    this.below = 0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;

    this.look = Math.max(1, Math.round(LOOKAHEAD_S * sr));
    this.delayBufs = null;
    this.pos = 0;

    // 每约 50ms 向主线程报一次电平/状态（UI 电平表 + 存活检测用）
    this.reportEvery = Math.max(1, Math.round((0.05 * sr) / 128));
    this.reportCount = 0;
  }

  /** 上报给主线程：UI 电平表、以及「这个节点到底活着没有」 */
  report() {
    this.reportCount++;
    if (this.reportCount < this.reportEvery) return;
    this.reportCount = 0;
    this.port.postMessage({
      levelDb: 20 * Math.log10(this.env + 1e-10),
      open: this.open,
      gain: this.gain,
    });
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;

    const frames = out[0].length;
    const main = inputs[0];
    const side = inputs[1];

    // 主输入没接上：输出静音，但继续上报 —— 主线程靠上报判断节点是否活着
    if (!main || main.length === 0 || !main[0]) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      this.report();
      return true;
    }

    if (!this.delayBufs || this.delayBufs.length !== out.length) {
      this.delayBufs = [];
      for (let c = 0; c < out.length; c++) this.delayBufs.push(new Float32Array(this.look));
    }

    // 侧链缺失时退化成用主输入检测（行为略差，但不会彻底失效）
    const probe = side && side.length > 0 && side[0] ? side[0] : main[0];

    const thresholdDb = params.thresholdDb[0];
    const enabled = params.enabled[0] > 0.5;
    // 比较在线性域做：省掉每样本一次 log10（48000 次/秒）
    const openLin = Math.pow(10, thresholdDb / 20);
    const closeLin = Math.pow(10, (thresholdDb - HYSTERESIS_DB) / 20);

    for (let i = 0; i < frames; i++) {
      // ---- 检测：始终运行（门没开时 UI 电平表也要有读数）----
      // 先过带通（只看语音基频那一段），再取包络
      const px = probe[i] !== undefined ? probe[i] : 0;
      const y =
        this.b0 * px + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = px;
      this.y2 = this.y1;
      this.y1 = y;
      const abs = y < 0 ? -y : y;
      this.env += (abs - this.env) * (abs > this.env ? this.envAtk : this.envRel);

      // ---- 门状态：迟滞 + 保持 ----
      if (!enabled) {
        // 关闭时精确直通：不碰增益，也不改样本
        this.open = true;
        this.below = 0;
        this.gain = 1;
      } else {
        if (this.env > openLin) {
          this.open = true;
          this.below = 0;
        } else if (this.open) {
          if (this.env < closeLin) {
            this.below++;
            if (this.below >= this.holdMax) this.open = false;
          } else {
            // 迟滞带内：维持现状（不算「低于关阈值」，保持计时清零）
            this.below = 0;
          }
        }

        const target = this.open ? 1 : CLOSED_GAIN;
        this.gain += (target - this.gain) * (target > this.gain ? this.gainAtk : this.gainRel);
        // 开门后**精确**落到 1：这是「不影响音量」的落地方式
        if (this.open && this.gain > 0.9999) this.gain = 1;
        if (!this.open && this.gain < 1e-4) this.gain = 0;
      }

      // ---- 前瞻延迟线 ----
      // 声音推迟 look 个样本，增益用**当前**这一拍的。
      // 于是「开门」这个决定作用在 look 个样本**之前**的声音上 ——
      // 相当于门提前知道了要开门，字头不会被削掉。
      // ⚠️ 增益千万不能跟着一起延迟：那样就只是把整段声音平移，
      //    等于完全没有前瞻（写错过一次，记在这里）。
      const pos = this.pos;
      for (let c = 0; c < out.length; c++) {
        const ch = main[c] || main[0];
        const buf = this.delayBufs[c];
        const delayed = buf[pos];
        buf[pos] = ch[i];
        out[c][i] = delayed * this.gain;
      }
      this.pos = (pos + 1) % this.look;
    }

    this.report();
    return true;
  }
}

registerProcessor('cf-voice-gate', VoiceGateProcessor);
