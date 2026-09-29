import { SfuSession, captureMicrophone } from './sfu-session';
import { roomsApi, rtcApi, getBaseUrl } from './api';
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

export class RoomController {
  private roomId: string;
  private uid: string;
  private nickname: string;
  private events: RoomControllerEvents;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private localStream: MediaStream | null = null;
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
  private bitrateKbps: number;

  constructor(opts: {
    roomId: string;
    uid: string;
    nickname: string;
    bitrateKbps?: number;
    events: RoomControllerEvents;
  }) {
    this.roomId = opts.roomId;
    this.uid = opts.uid;
    this.nickname = opts.nickname;
    this.bitrateKbps = opts.bitrateKbps ?? 32;
    this.events = opts.events;
  }

  // ==========================================================
  //  启动 / 停止
  // ==========================================================

  async start(): Promise<void> {
    this.events.onConnectionState('connecting');

    // 1. 加入房间（服务端登记成员 + 写审计）
    const { snapshot, keyId } = await roomsApi.join(this.roomId);
    void keyId;
    this.syncMembers(snapshot);
    this.events.onSnapshot(snapshot);

    // 2. 采集麦克风
    try {
      const { stream } = await captureMicrophone();
      this.localStream = stream;
    } catch (err) {
      this.events.onError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝，将以只听模式进入'
          : '无法访问麦克风，将以只听模式进入',
      );
    }

    // 3. 发布自己的音频
    if (this.localStream) {
      await this.publish();
    }

    // 4. 订阅其他人的音频
    await this.subscribeToOthers();

    // 5. 建立 WebSocket
    this.connectWebSocket();

    // 6. 心跳 + 兜底轮询
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.pollTimer = setInterval(() => void this.pollSnapshot(), HEARTBEAT_INTERVAL_MS);

    this.events.onConnectionState('connected');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);

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
          trackNames: [this.localStream?.getAudioTracks()[0]?.id ?? 'mic'],
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

    await this.receiveSession?.close();
    await this.publishSession?.close();
    this.receiveSession = null;
    this.publishSession = null;

    // 停止本地轨道
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;

    // 通知服务端 + 关闭 WS
    try {
      await roomsApi.leave(this.roomId);
    } catch {
      /* 忽略 */
    }

    this.ws?.close(1000, 'client leaving');
    this.ws = null;

    this.events.onConnectionState('disconnected');
  }

  // ==========================================================
  //  发布 / 订阅
  // ==========================================================

  private async publish(): Promise<void> {
    const track = this.localStream!.getAudioTracks()[0];
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
    if (this.stopped || !this.localStream) return;
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
        let stream = this.remoteStreams.get(sub.uid);
        if (!stream) {
          stream = new MediaStream();
          this.remoteStreams.set(sub.uid, stream);
        }
        stream.addTrack(sub.track);
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

  private connectWebSocket(): void {
    const base = getBaseUrl().replace(/^http/, 'ws');
    const url = `${base}/api/rooms/${this.roomId}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.events.onError(err instanceof Error ? err.message : 'WebSocket 连接失败');
      return;
    }

    this.ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let payload: RoomEvent;
      try {
        payload = JSON.parse(event.data) as RoomEvent;
      } catch {
        return;
      }
      void this.handleEvent(payload);
    });

    this.ws.addEventListener('close', () => {
      if (this.stopped) return;
      // 3 秒后重连
      setTimeout(() => {
        if (!this.stopped) this.connectWebSocket();
      }, 3000);
    });

    this.ws.addEventListener('error', () => {
      /* close 事件会跟着来 */
    });
  }

  private async handleEvent(event: RoomEvent): Promise<void> {
    switch (event.type) {
      case 'room-changed':
        await this.pollSnapshot();
        break;
      case 'member-left':
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
      case 'member-joined':
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

      // 新成员：统一走 syncSubscriptions（按轨道表对齐，含重试）
      if (changed.added.some((uid) => uid !== this.uid)) {
        await this.syncSubscriptions();
      }
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
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
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

  async reportUsage(bytes: number): Promise<void> {
    try {
      await rtcApi.reportUsage(bytes);
    } catch {
      /* 忽略 */
    }
  }
}
