import { SfuSession, captureMicrophone } from './sfu-session';
import { audioMixer } from './audio-mixer';
import { roomsApi, rtcApi, ApiError } from './api';
import { playSound } from './sound';
import { denoiseEngineOf, type DenoiseEngine } from './denoise';
import { loadSettings, micInputPrefsOf, voiceGatePrefsOf } from './settings';
import { HEARTBEAT_INTERVAL_MS } from '@shared/constants';
import type { RoomEvent, RoomMember, RoomSnapshot } from '@shared/types';

/**
 * 房间控制器 —— 客户端连接生命周期的核心。
 *
 * 职责：
 *   1. WebSocket 连接（接收变更信号）
 *   2. 心跳（15s）+ 超时兜底轮询（15s）
 *   3. 发布自己的音频
 *   4. 订阅房间内其他成员的音频
 *   5. 成员出入房间时增量更新订阅
 *
 * 音频播放与音量控制不在本类里：远端流一律交给 `audioMixer`，
 * 由它统一做「每人音量 → 总音量 → 输出」。本类只负责拿到流、交给它。
 */

export interface RoomControllerEvents {
  onSnapshot: (snapshot: RoomSnapshot) => void;
  onConnectionState: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void;
  /** 远端音频流到达（uid → MediaStream） */
  onRemoteStream: (uid: string, stream: MediaStream) => void;
  onRemoteStreamRemoved: (uid: string) => void;
  onError: (message: string) => void;
  onKicked: (reason: string) => void;
}

/**
 * 最近一次启动的控制器（模块级，跨路由实例）。
 *
 * 用途：切房间时，新控制器要先确认上一任已经**彻底停完**（leave 已发出、
 * SFU 会话已关、麦克风已释放），再开始 join 新房间。否则两个房间的
 * 生命周期会交叠 —— 表现为旧房间里还留着你的影子，或新房间订阅到过期轨道。
 *
 * 注意：这里刻意【不在 stop 时置空】。React 的 cleanup 会同步触发 stop()，
 * 若那时就置空，紧接着的新 effect 读到的就是 null，串行化直接失效。
 * 让新控制器在 start() 时接管引用即可（见 start() 开头的交接）。
 */
let lastController: RoomController | null = null;

export class RoomController {
  private roomId: string;
  private uid: string;
  private events: RoomControllerEvents;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** stop() 的完成信号：切房间时靠它串行化 */
  private stopPromise: Promise<void> | null = null;
  /** start() 的进行中 Promise：stop() 要先等它落地，否则会漏清理 */
  private startPromise: Promise<void> | null = null;

  private localStream: MediaStream | null = null;
  /** 实际拿去发布的轨道：经混音器应用录制音量后的版本（管线失败时退回原始轨道） */
  private publishTrack: MediaStreamTrack | null = null;
  private publishSession: SfuSession | null = null;
  private publishSessionId: string | null = null;
  private publishMid: string | null = null;

  /**
   * 单个接收会话承载【所有】远端订阅（官方推荐模型）。
   * 每个 uid 对应的音频流由 `remoteStreams` 持有。
   */
  private receiveSession: SfuSession | null = null;
  private receiveSessionId: string | null = null;
  /** uid → 该成员已订阅的 trackName（用于增量 diff 与清理） */
  private remoteTracks = new Map<string, string>();
  /** uid → 远端音频流 */
  private remoteStreams = new Map<string, MediaStream>();

  private knownMembers = new Map<string, RoomMember>();
  private muted = false;
  private stopped = false;
  /** join 是否成功过（决定离房时是否发音效） */
  private joinedSuccessfully = false;
  /** 重连定时器：stop 时要清掉，否则会留下一个永远在重试的定时器 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 会话已失效：不再重连 WebSocket（继续重试只会无限 401） */
  private sessionDead = false;
  private bitrateKbps: number;
  /** 音频链路从降级升级到 Web Audio 后，用它解除监听 */
  private unsubscribeMicUpgrade: (() => void) | null = null;

  constructor(opts: {
    roomId: string;
    /** 身份主键。昵称/头像是可变元数据，不参与会话生命周期 */
    uid: string;
    bitrateKbps?: number;
    events: RoomControllerEvents;
  }) {
    this.roomId = opts.roomId;
    this.uid = opts.uid;
    this.bitrateKbps = opts.bitrateKbps ?? 32;
    this.events = opts.events;
  }

  // ==========================================================
  //  启动 / 停止
  // ==========================================================

  async start(): Promise<void> {
    // 已被叫停的控制器不允许复活（它对应的是旧房间，复用只会造成状态混乱）
    if (this.stopPromise) return this.stopPromise;
    // 记录进行中的 Promise，供 stop() 等待（见 doStop 的注释）
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.events.onConnectionState('connecting');
    this.stopped = false;
    this.muted = false;

    // ---- 0. 与上一任交接：等它停完再动 ----
    // 切房间时旧控制器的 stop() 里还有一串 await（关 SFU / leave / 停麦克风）。
    // 若这边立刻 join，两个房间的生命周期会交叠：旧房间的 leave 可能晚于新
    // 房间的 join 到达服务端，于是你在旧房间里「阴魂不散」。
    const previous = lastController;
    lastController = this;
    if (previous && previous !== this) {
      try {
        await previous.waitUntilStopped();
      } catch {
        /* 上一任停失败也继续：不能让它卡住新房间的进入 */
      }
      // 等的过程中自己可能已被叫停（用户又切了一次）→ 直接收手
      // 清理由 doStop() 做，这里只负责不再往下走
      if (this.stopped) return;
    }

    // 1. 加入房间（服务端登记成员 + 写审计）
    // 优化：getUserMedia 与 join 无依赖，并行发起 —— getUserMedia 通常 100-500ms，
    // 串行时这段时间是纯等待。
    const joinPromise = roomsApi.join(this.roomId);
    // 采集用用户选定的设备；设备已不可用时 captureMicrophone 会自动回退默认设备
    const micConfig = loadSettings();
    const micPromise = captureMicrophone(
      micInputPrefsOf(micConfig),
      micConfig.inputDeviceId || undefined,
    )
      .then((r) => r.stream)
      .catch((err: unknown) => {
        this.events.onError(
          err instanceof Error && err.name === 'NotAllowedError'
            ? '麦克风权限被拒绝，将以只听模式进入'
            : '无法访问麦克风，将以只听模式进入',
        );
        return null;
      });

    const { snapshot, keyId } = await joinPromise;
    void keyId;
    // start() 途中被 stop()（例如快速切房间）：doStop 会等这条 promise 落地后统一清理，
    // 这里直接返回，不做任何额外的清理动作。
    if (this.stopped) return;
    this.syncMembers(snapshot);
    this.events.onSnapshot(snapshot);
    this.joinedSuccessfully = true;

    // 2. 唤醒 AudioContext（录制音量依赖它；失败也不影响播放）
    //    与「等麦克风」并行 —— resume 与 getUserMedia 互不依赖。
    await Promise.all([audioMixer.resume(), micPromise]);

    if (this.stopped) return;
    this.localStream = await micPromise;

    // 4. 发布自己的音频 + 订阅别人的音频 + 建立 WebSocket —— 三者【并行】。
    //    发布与订阅是两条独立的 PeerConnection（不同 SFU session），
    //    官方只要求「同一 session 内的变更串行」，跨会话并行没有问题；
    //    WebSocket 只是建立连接，更没有依赖。串行时这三段各等各的 RTT，
    //    并行后整段耗时 ≈ 最慢的一段（通常就是发布那条）。
    //    doStart 是 async 任务且下方有 stopped 检查，快速切房间也安全。
    void this.connectWebSocket();

    const publishTask = (async () => {
      if (!this.localStream) return;
      // 降噪引擎从本地设置读取（设置面板切换后，下次进房 / 手动重连生效）
      const cfg = loadSettings();
      const denoise = denoiseEngineOf(cfg);
      const processed = await audioMixer.createMicPipeline(
        this.localStream,
        this.uid,
        denoise,
        voiceGatePrefsOf(cfg),
      );
      if (this.stopped) return;
      this.publishTrack = processed ?? this.localStream.getAudioTracks()[0] ?? null;
      if (this.publishTrack) await this.publish();

      if (!processed) {
        // 录制音量链路没建起来（多半是 AudioContext 还没被手势解锁）：
        // 先用原始轨道保证「一定有声」，等首次交互后再重建管线并重发一次。
        this.bindMicUpgradeRetry();
      } else {
        this.prewarmLikelyEngine(denoise);
      }
    })();

    await Promise.all([publishTask, this.subscribeToOthers()]);

    // 5. 心跳 + 兜底轮询
    if (this.stopped) {
      // start() 期间被叫停：直接返回。
      // 清理由 doStop() 统一做 —— 它会先等 startPromise 落地（也就是这里），
      // 所以这里【绝不能】再调 this.stop()，否则 start↔stop 互相等待会死锁。
      return;
    }
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.pollTimer = setInterval(() => void this.pollSnapshot(), HEARTBEAT_INTERVAL_MS);

    this.events.onConnectionState('connected');

    // 进房音效：【音频链路连通】才算进房 —— join 只是在名册上登记，
    // SFU 会话建好、心跳跑起来才算真的「连上了」，这时响才有意义
    playSound('joinSelf');
  }

  /** 等这个控制器彻底停完（切房间时用） */
  async waitUntilStopped(): Promise<void> {
    await this.stopPromise;
  }

  async stop(): Promise<void> {
    // 幂等 + 并发安全：多次调用（或 stop 与 start 交错）共用同一个 Promise
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    // 若 start() 还在半途，先让它落地（它内部会检测 stopped 并自行收尾）。
    // 否则可能出现「清理跑完了，start 才去 join」→ 房间里留下幽灵成员。
    const startedFully = this.joinedSuccessfully;

    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        /* start 抛错不影响清理继续 */
      }
    }

    this.unsubscribeMicUpgrade?.();
    this.unsubscribeMicUpgrade = null;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.heartbeatTimer = null;
    this.pollTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    // 【先】告诉服务端「我走了」。切房间时新房间的 join 紧随其后，
    // leave 放最后会让服务端有一段时间看到你同时在两个房间里。
    try {
      await roomsApi.leave(this.roomId);
    } catch {
      /* 忽略 */
    }

    // 逐个关闭接收会话上已订阅的轨道（force，无需 SDP 交换）
    if (this.receiveSession && this.receiveSessionId) {
      for (const uid of [...this.remoteTracks.keys()]) {
        try {
          await this.receiveSession.closeReceiveSession(this.roomId, this.receiveSessionId, uid);
        } catch {
          /* 忽略 */
        }
      }
    }
    // 关闭本地发布（用 mid）
    if (this.publishSession && this.publishSessionId && this.publishMid) {
      try {
        await rtcApi.close({
          roomId: this.roomId,
          sessionId: this.publishSessionId,
          trackNames: [this.publishTrack?.id ?? 'mic'],
          mids: [this.publishMid],
          force: true,
        });
      } catch {
        /* 忽略 */
      }
    }

    for (const uid of this.remoteStreams.keys()) {
      this.events.onRemoteStreamRemoved(uid);
    }
    this.remoteStreams.clear();
    this.remoteTracks.clear();

    // 先拆掉 Web Audio 图，再停底层轨道，避免停轨时节点仍挂在已死的流上
    audioMixer.detachAllRemotes();
    audioMixer.releaseMic();

    await this.receiveSession?.close();
    await this.publishSession?.close();
    this.receiveSession = null;
    this.publishSession = null;

    // 停止本地轨道
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.publishTrack = null;

    this.ws?.close(1000, 'client leaving');
    this.ws = null;

    this.events.onConnectionState('disconnected');

    // 离房音效：leave 请求已发出、链路已拆完之后才响 ——
    // 和进房音效对称（连上了才响「进」，断开了才响「出」）。
    // 只对「真正连上过」的情况发（start 中断 / join 失败不算）。
    if (startedFully) playSound('leaveSelf');
  }

  // ==========================================================
  //  发布 / 订阅
  // ==========================================================

  private async publish(): Promise<void> {
    const track = this.publishTrack;
    if (!track) return;

    const { session, sessionId, mid } = await SfuSession.publish({
      roomId: this.roomId,
      track,
      trackName: track.id,
      bitrateKbps: this.bitrateKbps,
    });
    this.publishSession = session;
    this.publishSessionId = sessionId;
    this.publishMid = mid;

    session.onConnectionStateChange((state) => {
      if (state === 'failed' || state === 'disconnected') {
        void this.republish();
      }
    });
  }

  /** 掉线后重发 */
  private async republish(): Promise<void> {
    if (this.stopped || !this.publishTrack) return;
    this.events.onConnectionState('reconnecting');
    try {
      await this.publishSession?.close();
      this.publishSession = null;
      await this.publish();
      this.events.onConnectionState('connected');
    } catch (err) {
      this.events.onError(err instanceof Error ? err.message : '重新发布失败');
      this.events.onConnectionState('disconnected');
    }
  }

  /**
   * 录制音量链路没建起来时，等首次用户交互后再试一次。
   *
   * AudioContext 在无用户手势时是 suspended 的，而 suspended 的 Web Audio
   * 链路输出静音 —— 所以那一刻只能先用原始轨道。手势一到就重建管线并重发。
   */
  private bindMicUpgradeRetry(): void {
    if (this.unsubscribeMicUpgrade || typeof document === 'undefined') return;

    const retry = () => {
      void this.upgradeMicPipeline();
    };
    document.addEventListener('pointerdown', retry, { once: true, capture: true });
    document.addEventListener('keydown', retry, { once: true, capture: true });

    this.unsubscribeMicUpgrade = () => {
      document.removeEventListener('pointerdown', retry, { capture: true });
      document.removeEventListener('keydown', retry, { capture: true });
    };
  }

  /**
   * 后台预热「最可能被切到」的降噪引擎。
   *
   * 最常见的路径是：进房时降噪是关的 → 觉得吵 → 在设置里打开 GTCRN。
   * 提前把 worklet 模块与 wasm 拉进缓存，那次切换就只剩接线，不会出现
   * 几百毫秒的加载停顿。延后几秒再拉，避免和发布抢带宽。
   */
  private prewarmLikelyEngine(current: DenoiseEngine): void {
    if (typeof window === 'undefined') return;
    const target: DenoiseEngine = current === 'gtcrn' ? 'off' : 'gtcrn';
    if (target === 'off') return;
    setTimeout(() => {
      if (!this.stopped) void audioMixer.prewarmDenoise(target);
    }, 3000);
  }

  /**
   * 音频链路就绪后重建麦克风增益链路，并重发轨道。
   * 发布中的轨道无法原地替换，只能换一条重发——代价是一次短暂的音频中断，
   * 换来「录制音量」从此可用。
   */
  private async upgradeMicPipeline(): Promise<void> {
    if (this.stopped || !this.localStream) return;

    // 走的是和首次建管线同一条路径：降噪引擎与语音门限必须一起带上。
    // （原实现这里没传引擎，于是「AudioContext 晚解锁 → 重建管线」会把用户
    // 已经开好的降噪悄悄丢掉，界面却还显示开着。）
    const cfg = loadSettings();
    const denoise = denoiseEngineOf(cfg);
    const processed = await audioMixer.createMicPipeline(
      this.localStream,
      this.uid,
      denoise,
      voiceGatePrefsOf(cfg),
    );
    if (!processed) return;

    this.publishTrack = processed;
    this.unsubscribeMicUpgrade?.();
    this.unsubscribeMicUpgrade = null;
    await this.republish();
  }

  /**
   * 【设置面板调用】立即切换降噪引擎 —— 热切换，不触碰已发布轨道。
   *
   * 只重新接线 Web Audio 图内部（source → [新 worklet] → gain），
   * SFU 发布会话全程不动 → 对端只会听到一次轻微顿挫，协商失败也不会没声。
   */
  async applyDenoise(engine: DenoiseEngine): Promise<boolean> {
    if (this.stopped || !this.localStream) return false;
    return audioMixer.swapDenoise(engine);
  }

  /** 订阅房间内除自己以外的所有人 */
  private async subscribeToOthers(): Promise<void> {
    await this.syncSubscriptions();
  }

  /** 拉取房间内可订阅轨道列表 */
  private async fetchTracks(): Promise<
    Array<{ trackName: string; uid: string; sessionId: string }>
  > {
    try {
      const { tracks } = await roomsApi.tracks(this.roomId);
      return tracks;
    } catch {
      return [];
    }
  }

  /**
   * 把接收会话的订阅状态对齐到当前房间的轨道列表。
   * 只增不减（退房由 member-left 事件单独处理，避免抖动）。
   */
  private async syncSubscriptions(): Promise<void> {
    if (this.stopped) return;

    const tracks = await this.fetchTracks();
    const wanted = tracks.filter((t) => t.uid !== this.uid && !this.remoteTracks.has(t.uid));

    if (wanted.length === 0) return;

    // 懒创建接收会话
    if (!this.receiveSession) {
      this.receiveSession = SfuSession.createReceiver((sub) => {
        if (!sub.uid) return;

        // 每条轨道单独包一个 MediaStream：MediaStreamAudioSourceNode 只认创建时
        // 那条轨道，把新轨道 addTrack 进旧 stream 不会被它看到（重发布后会变哑）。
        const stream = new MediaStream([sub.track]);
        this.remoteStreams.set(sub.uid, stream);

        // 播放与音量统一交给混音器；它会先拆掉该 uid 的旧节点
        void audioMixer.attachRemote(sub.uid, stream);
        this.events.onRemoteStream(sub.uid, stream);
      });
    }

    const session = this.receiveSession;

    try {
      const { sent, sessionId } = await session.addSubscriptions(
        this.roomId,
        this.receiveSessionId ?? '',
        wanted.map((t) => ({
          uid: t.uid,
          publisherSessionId: t.sessionId,
          trackName: t.trackName,
        })),
      );

      // 首次订阅时记录 sessionId（SFU 在响应里返回）
      if (sessionId) this.receiveSessionId = sessionId;

      for (const ref of sent) {
        this.remoteTracks.set(ref.uid, ref.trackName);
      }
    } catch (err) {
      this.events.onError(
        `订阅失败：${err instanceof Error ? err.message : '未知错误'}`,
      );
    }
  }

  /** 成员离开：关闭其在接收会话上的订阅 */
  private async unsubscribeFromMember(uid: string): Promise<void> {
    audioMixer.detachRemote(uid);

    const trackName = this.remoteTracks.get(uid);
    if (!trackName) {
      // 没订阅过也要清掉 UI 状态
      this.remoteStreams.delete(uid);
      this.events.onRemoteStreamRemoved(uid);
      return;
    }

    this.remoteTracks.delete(uid);
    this.remoteStreams.delete(uid);
    this.events.onRemoteStreamRemoved(uid);

    if (this.receiveSession && this.receiveSessionId) {
      try {
        await this.receiveSession.closeReceiveSession(this.roomId, this.receiveSessionId, uid);
      } catch {
        /* 忽略：对端可能已自行关闭 */
      }
    }
  }

  // ==========================================================
  //  WebSocket + 心跳
  // ==========================================================

  private connectWebSocket(): Promise<void> {
    if (this.sessionDead || this.stopped) return Promise.resolve();

    return (async () => {
      // 先领一次性握手票据。
      //
      // 为什么不用 Cookie：WebSocket API 无法自定义请求头，也就没法带
      // `Authorization: Bearer`。领票这一步走的是普通 HTTP（可以带 Bearer），
      // 于是网页 / 原生 App / CLI / 第三方网页都能用同一条路。
      let wsUrl: string;
      try {
        const ticket = await roomsApi.wsTicket(this.roomId);
        wsUrl = ticket.wsUrl;
      } catch (err) {
        if (this.stopped) return;
        // 401 = 会话没了，重连没有意义
        if (err instanceof ApiError && err.isAuthFailure) {
          this.sessionDead = true;
          return;
        }
        this.scheduleReconnect();
        return;
      }

      if (this.stopped) return;

      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch (err) {
        this.events.onError(err instanceof Error ? err.message : 'WebSocket 连接失败');
        this.scheduleReconnect();
        return;
      }
      this.ws = socket;

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let payload: RoomEvent;
        try {
          payload = JSON.parse(event.data) as RoomEvent;
        } catch {
          return;
        }
        void this.handleEvent(payload);
      });

      socket.addEventListener('close', () => {
        if (this.ws === socket) this.ws = null;
        this.scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        /* close 事件会跟着来 */
      });
    })();
  }

  /** 3 秒后重连（只会存在一个待触发的重连定时器） */
  private scheduleReconnect(): void {
    if (this.stopped || this.sessionDead || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWebSocket();
    }, 3000);
  }

  private async handleEvent(event: RoomEvent): Promise<void> {
    switch (event.type) {
      case 'room-changed':
        await this.pollSnapshot();
        break;
      case 'member-left':
        // 音效先行（发通知的时候人还没走完，听感更自然）
        playSound('memberOut');
        this.knownMembers.delete(event.uid);
        await this.unsubscribeFromMember(event.uid);
        break;
      case 'kicked':
        this.events.onKicked(event.reason);
        await this.stop();
        break;
      case 'room-closed':
        this.events.onError(event.reason);
        await this.stop();
        break;
      case 'key-rotated':
        await this.pollSnapshot();
        break;
      case 'member-joined':
        playSound('memberIn');
        await this.pollSnapshot();
        break;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await roomsApi.heartbeat(this.roomId);
    } catch {
      /* 忽略一次性失败 */
    }
  }

  /** 拉取快照并做增量 diff（新成员 → 订阅；离开 → 取消订阅） */
  private async pollSnapshot(): Promise<void> {
    if (this.stopped) return;
    try {
      const snapshot = await roomsApi.snapshot(this.roomId);
      const changed = this.syncMembers(snapshot);
      this.events.onSnapshot(snapshot);

      // 无条件对齐订阅：成员表变化只是「可能有新轨道」的一个信号，
      // 但对方发布完成（track 登记）未必伴随成员变化 —— 只靠 added 判断会漏，
      // 先加入的人就永远订阅不上后加入的人。syncSubscriptions 自身是幂等的。
      await this.syncSubscriptions();

      for (const uid of changed.removed) {
        await this.unsubscribeFromMember(uid);
      }
    } catch {
      /* 忽略 */
    }
  }

  /** 同步成员表，返回新增/移除的 uid */
  private syncMembers(snapshot: RoomSnapshot): { added: string[]; removed: string[] } {
    const next = new Map(snapshot.members.map((m) => [m.uid, m]));
    const added: string[] = [];
    const removed: string[] = [];

    for (const [uid] of next) {
      if (!this.knownMembers.has(uid)) added.push(uid);
    }
    for (const [uid] of this.knownMembers) {
      if (!next.has(uid)) removed.push(uid);
    }

    this.knownMembers = next;
    return { added, removed };
  }

  // ==========================================================
  //  对外操作
  // ==========================================================

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    // 采集轨与发布轨一起开关（发布轨可能经过 Web Audio 增益链路）
    audioMixer.setMicEnabled(!muted);
    try {
      await roomsApi.mute(this.roomId, muted);
    } catch {
      /* 忽略 */
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  hasMicrophone(): boolean {
    return this.localStream !== null;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /** 估算已产生的 SFU 出站流量（用于用量上报） */
  estimateEgressBytes(elapsedMs: number, subscriberCount: number): number {
    // 位率 × 时长 × 订阅者数
    const bitsPerSecond = this.bitrateKbps * 1000;
    return Math.floor((bitsPerSecond * elapsedMs * subscriberCount) / 1000 / 8);
  }

  /**
   * 调试快照：发布/接收会话的真实状态与 RTP 统计。
   * 排查「没声音」时用它判断是「没发出去」还是「没收到」。
   */
  async debugStats(): Promise<Record<string, unknown>> {
    const summarise = async (label: string, session: SfuSession | null) => {
      if (!session) return { [label]: null };

      const pc = session.getPeerConnection();
      const rows: Record<string, unknown>[] = [];
      try {
        const stats = await pc.getStats();
        stats.forEach((r: Record<string, unknown>) => {
          const type = r.type as string;
          if (type === 'outbound-rtp' || type === 'inbound-rtp') {
            rows.push({
              type,
              kind: r.kind,
              bytesSent: r.bytesSent,
              bytesReceived: r.bytesReceived,
              packetsSent: r.packetsSent,
              packetsReceived: r.packetsReceived,
              // 不依赖本机声卡：直接反映这条 RTP 流里有没有真实音频信号
              audioLevel: r.audioLevel,
              totalAudioEnergy: r.totalAudioEnergy,
            });
          }
          if (type === 'transport') {
            rows.push({ type, dtlsState: r.dtlsState, iceState: r.iceState });
          }
        });
      } catch {
        /* 忽略 */
      }

      const describe = (t: MediaStreamTrack | null) =>
        t
          ? { kind: t.kind, enabled: t.enabled, muted: t.muted, readyState: t.readyState }
          : null;

      return {
        [label]: {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          senders: pc.getSenders().map((s) => describe(s.track)),
          receivers: pc.getReceivers().map((r) => describe(r.track)),
          rows,
        },
      };
    };

    return {
      publishTrack: this.publishTrack
        ? {
            id: this.publishTrack.id,
            enabled: this.publishTrack.enabled,
            muted: this.publishTrack.muted,
            readyState: this.publishTrack.readyState,
          }
        : null,
      micTrack: (() => {
        const t = audioMixer.getMicTrack();
        return t ? { id: t.id, enabled: t.enabled, muted: t.muted, readyState: t.readyState } : null;
      })(),
      localStreamTracks: (this.localStream?.getTracks() ?? []).map((t) => ({
        id: t.id,
        kind: t.kind,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
      })),
      ...(await summarise('publish', this.publishSession)),
      ...(await summarise('receive', this.receiveSession)),
    };
  }

  async reportUsage(bytes: number): Promise<void> {
    try {
      await rtcApi.reportUsage(bytes);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 延迟测量（供调试面板/控制台）。
   *
   * 各指标含义：
   *   rtt            往返时延：从 RTT 统计（STUN connectivity check 推算），最能代表网络质量
   *   jitterOut/in   发送/接收方向的抖动（RFC3550 定义，越低越稳）
   *   playoutDelay   接收端抖动缓冲延迟（ms）：为对抗 jitter，浏览器故意延迟播放的量 —— 这是
   *                  「对方说话到你听到」的主要组成部分，WebRTC 会自适应调节
   *   audioLevelOut/in  发送/接收的实时音量（>0 说明链路上有真实音频信号）
   *   packetsLost    丢包数（ receivers 侧）
   */
  async debugLatency(): Promise<Record<string, unknown>> {
    const sample = async (session: SfuSession | null) => {
      if (!session) return null;
      const pc = session.getPeerConnection();
      const out: Record<string, unknown> = {};
      try {
        const stats = await pc.getStats();
        stats.forEach((r: Record<string, unknown>) => {
          const type = r.type as string;
          if (type === 'candidate-pair' && ((r.state as string) === 'succeeded' || (r.state as string) === 'selected')) {
            // 当前使用的候选对：RTT（秒）。
            // Chrome 用 state='succeeded'，Firefox 用 'selected' —— 都接受。
            if (typeof r.currentRoundTripTime === 'number') {
              out.rttMs = Math.round(r.currentRoundTripTime * 1000);
            } else if (
              typeof r.availableOutgoingBitrate === 'number' &&
              typeof r.requestsReceived === 'number'
            ) {
              // 个别浏览器不给 currentRoundTripTime，但 response 的时间戳可以近似
              // 这里不硬算，留空即可（横杠表示该浏览器不提供此指标）
            }
          }
          if (type === 'outbound-rtp' && r.kind === 'audio') {
            out.jitterOutMs = r.jitter != null ? Math.round((r.jitter as number) * 1000) : null;
            out.audioLevelOut = r.audioLevel ?? null;
            out.bytesSent = r.bytesSent;
            out.packetsSent = r.packetsSent;
            out.retransmittedPacketsSent = r.retransmittedPacketsSent;
          }
          if (type === 'inbound-rtp' && r.kind === 'audio') {
            out.jitterInMs = r.jitter != null ? Math.round((r.jitter as number) * 1000) : null;
            out.packetsLost = r.packetsLost;
            out.audioLevelIn = r.audioLevel ?? null;
            out.bytesReceived = r.bytesReceived;
            out.packetsReceived = r.packetsReceived;
            // 抖动缓冲延迟：jitterBufferDelay(秒) / jitterBufferEmittedCount = 平均每帧缓冲延迟
            const delay = r.jitterBufferDelay as number | undefined;
            const emitted = r.jitterBufferEmittedCount as number | undefined;
            if (typeof delay === 'number' && typeof emitted === 'number' && emitted > 0) {
              out.playoutDelayMs = Math.round((delay / emitted) * 1000);
            }
          }
          if (type === 'remote-inbound-rtp') {
            // 对端汇报的它收我们流的 RTT/丢包（更贴近对端体验）
            if (typeof r.roundTripTime === 'number') out.rttRemoteMs = Math.round(r.roundTripTime * 1000);
            if (typeof r.fractionLost === 'number') out.fractionLostRemote = +(r.fractionLost * 100).toFixed(2);
          }
        });
      } catch {
        /* 忽略 */
      }
      return out;
    };

    const [publish, receive] = await Promise.all([
      sample(this.publishSession),
      sample(this.receiveSession),
    ]);

    const pub = (publish ?? {}) as Record<string, unknown>;
    const rec = (receive ?? {}) as Record<string, unknown>;
    const pick = (...vals: unknown[]) => {
      for (const v of vals) {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
      return null;
    };

    // 扁平视图：UI（延迟弹窗 / 设置面板）直接读顶层字段
    const flat = {
      // 网络往返：优先「对端汇报的 RTT」（它反映对端收我们流的体验），
      // 退回本端 candidate-pair 的 RTT
      networkRttMs: pick(rec.rttRemoteMs, pub.rttMs, rec.rttMs),
      playoutDelayMs: pick(rec.playoutDelayMs),
      jitterOutMs: pick(pub.jitterOutMs),
      jitterInMs: pick(rec.jitterInMs),
      packetsLost: pick(rec.packetsLost),
      rttRemoteMs: pick(rec.rttRemoteMs),
    };

    return {
      timestamp: Date.now(),
      ...flat,
      publish,
      receive,
      summary: {
        ...flat,
        note: '端到端 ≈ rtt（发+收两跳）+ 对端播放缓冲；浏览器不再暴露 capture/render 硬件延迟',
      },
    };
  }
}
