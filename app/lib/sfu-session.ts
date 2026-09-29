import { rtcApi } from './api';
import { STUN_SERVERS } from '@shared/constants';

/**
 * SFU 会话封装（对齐 Cloudflare 官方 connection-patterns / negotiation 文档）。
 *
 * 架构（官方推荐）：
 *   - **发布会话**：1 个 PC，sendonly，只发布自己的音频。
 *     流程：client offer → tracks/new → 应用 SFU answer。**无需 renegotiate**。
 *   - **接收会话**：1 个 PC，承载【所有】远端订阅。
 *     流程：tracks/new(remote) → SFU 返回 offer → answer → PUT renegotiate。
 *     一次 tracks/new 可批量订阅多人的轨道，之后增量增删。
 *
 * 硬约束：**同一 session 上的所有变更必须串行化**。
 * 官方原文："Serialize mutations that target the same SFU session... When event
 * handlers, timers, or UI actions can overlap, use one shared queue per session."
 * 否则第二个请求可能在前一个 SDP 交换完成前到达 → SFU 返回 HTTP 406。
 */

export type SfuRole = 'publisher' | 'subscriber';

interface PublishOptions {
  roomId: string;
  track: MediaStreamTrack;
  /** 用于 SFU 侧定位的轨道名（通常用 track.id） */
  trackName: string;
  /** Opus 码率上限（kbps） */
  bitrateKbps?: number;
}

/** 一条待订阅的远端轨道描述 */
export interface RemoteTrackRef {
  uid: string;
  publisherSessionId: string;
  trackName: string;
}

/** 远端音频 track 到达时的回调载荷 */
export interface IncomingSubscription {
  uid: string;
  trackName: string;
  mid: string | null;
  track: MediaStreamTrack;
}

/** 简单的串行队列：保证同 session 的请求按序执行 */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class SfuSession {
  readonly role: SfuRole;
  private pc: RTCPeerConnection;
  /**
   * 注意：队列在实例内，但 `publish()` 是静态工厂，创建时的初次交换
   * 也在队列里跑，保证与后续变更同序。
   */
  private queue = new SerialQueue();
  private closed = false;
  private remoteTracks: MediaStreamTrack[] = [];

  private constructor(role: SfuRole, pc: RTCPeerConnection) {
    this.role = role;
    this.pc = pc;
  }

  private static createPeerConnection(): RTCPeerConnection {
    return new RTCPeerConnection({
      iceServers: STUN_SERVERS,
      bundlePolicy: 'max-bundle',
    });
  }

  // ==========================================================
  //  发布会话
  // ==========================================================

  /**
   * 建立发布会话并发布一条音频轨道。
   * 返回时已完成 setRemoteDescription(answer)。
   */
  static async publish(opts: PublishOptions): Promise<{
    session: SfuSession;
    sessionId: string;
    mid: string;
  }> {
    const pc = SfuSession.createPeerConnection();
    const session = new SfuSession('publisher', pc);

    // sendonly transceiver（发布方向：只有一条轨道）
    const transceiver = pc.addTransceiver(opts.track, {
      direction: 'sendonly',
      streams: [new MediaStream([opts.track])],
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // 等 ICE 收集完成（SFU 需要完整候选）
    await session.waitForIceGathering();

    // mid 必须在 setLocalDescription 之后读取（见官方 connection-patterns）
    const mid = transceiver.mid ?? '0';
    const localSdp = pc.localDescription?.sdp ?? '';

    const result = await rtcApi.publish({
      roomId: opts.roomId,
      sdp: localSdp,
      trackName: opts.trackName,
      mid,
    });

    // 发布方向不需要 renegotiate：直接应用 answer
    await session.queue.run(async () => {
      await pc.setRemoteDescription(result.sessionDescription);
    });

    // 应用码率约束
    await applyBitrate(pc, opts.track, opts.bitrateKbps ?? 32);

    return { session, sessionId: result.sessionId, mid };
  }

  // ==========================================================
  //  接收会话
  // ==========================================================

  /**
   * 创建一个空的接收会话（尚未有本地 offer）。
   * 首次 `addSubscriptions()` 时由 SFU 下发 offer。
   */
  static createReceiver(onRemoteTrack: (sub: IncomingSubscription) => void): SfuSession {
    const pc = SfuSession.createPeerConnection();
    const session = new SfuSession('subscriber', pc);

    pc.addEventListener('track', (event) => {
      const track = event.track;
      session.remoteTracks.push(track);
      const mid = event.transceiver.mid ?? null;
      // 从 session 里查回这条 mid 对应的订阅描述
      const meta = session.pendingMids.get(mid ?? '') ?? null;
      onRemoteTrack({
        uid: meta?.uid ?? '',
        trackName: meta?.trackName ?? '',
        mid,
        track,
      });
    });

    return session;
  }

  /** mid → 订阅元数据（track 事件到达时反查 uid） */
  private pendingMids = new Map<string, { uid: string; trackName: string }>();

  /** uid → 该 uid 在接收会话上占用的 mid（关闭轨道时用） */
  private uidMids = new Map<string, string>();

  /** 查某个 uid 在接收会话上的 mid */
  getMidFor(uid: string): string | undefined {
    return this.uidMids.get(uid);
  }

  /**
   * 增量订阅一批远端轨道（同一会话内可多次调用，自动串行）。
   *
   * 音频 track 会通过构造时的 `onRemoteTrack` 回调异步送达（携带 uid）。
   * 返回本次实际发起的 refs 与（首次创建时的）sessionId。
   */
  async addSubscriptions(
    roomId: string,
    sessionId: string,
    refs: RemoteTrackRef[],
  ): Promise<{ sent: RemoteTrackRef[]; sessionId: string }> {
    const fresh = refs.filter((r) => !this.subscribedKeys.has(`${r.uid}:${r.trackName}`));
    if (fresh.length === 0) return { sent: [], sessionId };

    return this.queue.run(async () => {
      const offer = await rtcApi.subscribeBatch({
        roomId,
        // 空字符串 = 首次订阅，由服务端新建接收会话
        ...(sessionId ? { sessionId } : {}),
        tracks: fresh.map((r) => ({
          publisherSessionId: r.publisherSessionId,
          trackName: r.trackName,
        })),
      });

      if (!offer.sessionDescription) {
        throw new Error('SFU 未返回订阅 offer');
      }

      // ⚠️ 必须在 setRemoteDescription 之前登记 mid→元数据，
      // 否则 track 事件触发时反查不到 uid。
      for (const t of offer.tracks ?? []) {
        const ref = fresh.find((r) => r.trackName === t.trackName);
        if (ref && t.mid) {
          this.pendingMids.set(t.mid, { uid: ref.uid, trackName: ref.trackName });
          this.uidMids.set(ref.uid, t.mid);
        }
      }

      // SFU offer → 本地 answer
      await this.pc.setRemoteDescription(offer.sessionDescription);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.waitForIceGathering();

      for (const r of fresh) {
        this.subscribedKeys.add(`${r.uid}:${r.trackName}`);
      }

      // 提交 answer，完成交换
      await rtcApi.renegotiate({
        roomId,
        sessionId: offer.sessionId,
        sdp: this.pc.localDescription?.sdp ?? '',
      });

      return { sent: fresh, sessionId: offer.sessionId };
    });
  }

  private subscribedKeys = new Set<string>();

  /** 关闭接收会话上的订阅（会话级清理，force=true 不需要 SDP 交换） */
  async closeReceiveSession(roomId: string, sessionId: string, uid: string): Promise<void> {
    const mid = this.uidMids.get(uid);
    const key = [...this.subscribedKeys].find((k) => k.startsWith(`${uid}:`));
    const trackName = key?.slice(uid.length + 1);

    this.subscribedKeys.delete(key ?? '');
    this.uidMids.delete(uid);

    if (!mid) return; // 没有 mid 说明没真正订阅成功，跳过

    await this.queue.run(async () => {
      await rtcApi.close({
        roomId,
        sessionId,
        trackNames: [trackName ?? uid],
        mids: [mid],
        force: true,
      });
    });
  }

  // ==========================================================
  //  公共
  // ==========================================================

  /** 等待 ICE 收集完成（或超时 2s，避免卡死卡） */
  private waitForIceGathering(timeoutMs = 2000): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();

    return new Promise((resolve) => {
      const done = () => {
        this.pc.removeEventListener('icegatheringstatechange', onChange);
        clearTimeout(timer);
        resolve();
      };
      const onChange = () => {
        if (this.pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const track of this.remoteTracks) {
      track.stop();
    }
    this.remoteTracks = [];
    this.pendingMids.clear();
    this.subscribedKeys.clear();

    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }

  getPeerConnection(): RTCPeerConnection {
    return this.pc;
  }

  /** 在队列上执行一个自定义任务（保证与其它变更串行） */
  run<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.run(task);
  }

  onConnectionStateChange(cb: (state: RTCPeerConnectionState) => void): () => void {
    const handler = () => cb(this.pc.connectionState);
    this.pc.addEventListener('connectionstatechange', handler);
    return () => this.pc.removeEventListener('connectionstatechange', handler);
  }
}

/**
 * 发布前的媒体采集。
 * 音频参数偏向语音优化：回声消除 + 降噪 + 自动增益 + 单声道。
 */
export async function captureMicrophone(): Promise<{
  stream: MediaStream;
  track: MediaStreamTrack;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });

  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('未获取到音频轨道');

  return { stream, track };
}

/**
 * 应用码率限制到 sender（需要在 addTrack 之后调用）。
 */
export async function applyBitrate(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  bitrateKbps: number,
): Promise<void> {
  const sender = pc.getSenders().find((s) => s.track === track);
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  params.encodings[0]!.maxBitrate = bitrateKbps * 1000;
  try {
    await sender.setParameters(params);
  } catch {
    /* 忽略 */
  }
}
