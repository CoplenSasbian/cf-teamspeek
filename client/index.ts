/**
 * cf-teamspeed 跨客户端 SDK（核心）。
 *
 * 目标：**同一份逻辑，任何运行时都能用**。
 *   - 浏览器（含 WebView 套壳）
 *   - Node / Bun / Deno（CLI、机器人、自动化测试）
 *   - React Native（注入 fetch 与 WebSocket）
 *   - 其他能发 HTTP 与跑 WebSocket 的语言（本文件同时是**协议参考实现**）
 *
 * 它负责「信令之外的一切」：
 *   登录鉴权、会话续期、房间生命周期、成员快照、在线状态、WebSocket 事件流。
 *
 * 它**不**负责媒体：音频采集、编解码、E2EE 都是平台强相关的，
 * 由调用方提供 `MediaTransport`（见文件末尾的接口定义）。
 * 这样「房间状态机」与「语音实现」可以各自演进，不必绑死。
 *
 * 依赖：仅 `shared/types`、`shared/constants`（纯类型与常量）+ 本目录的 http.ts。
 */

import { DEFAULT_ROOM_ID, HEARTBEAT_INTERVAL_MS, PRESENCE_POLL_MS } from '../shared/constants';
import { ErrorCode } from '../shared/types';
import type {
  ClientConfig,
  PresenceInvite,
  PresenceSnapshot,
  PresenceStatus,
  Profile,
  RoomEvent,
  RoomMember,
  RoomSnapshot,
  RoomSummary,
  RoomWithMembers,
  SessionResult,
} from '../shared/types';
import { ApiError, HttpClient, type SessionState, type StorageAdapter } from './lib/http';

export type { SessionState, StorageAdapter } from './lib/http';
export { ApiError, NetworkError, MemoryStorage, browserStorage } from './lib/http';

// ============================================================
//  事件
// ============================================================

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ClientEvents {
  /** 房间快照变化（成员进出、改名、静音状态…） */
  snapshot: RoomSnapshot;
  /** 连接状态变化 */
  connection: ConnectionState;
  /** 被踢出房间 */
  kicked: { reason: string };
  /** 房间被关闭 */
  roomClosed: { reason: string };
  /** 房间密钥轮换（E2EE 客户端需要重新取密钥） */
  keyRotated: { keyId: string };
  /** 服务器成员 / 邀请更新（每次轮询后触发） */
  presence: PresenceSnapshot;
  /** 收到新邀请 */
  invite: PresenceInvite;
  /** 已被移出服务器（封禁），应清理本地会话 */
  banned: { reason: string };
  /** 会话失效，需要重新登录 */
  sessionExpired: { reason: 'expired' | 'invalid' };
  /** 非致命错误（便于调用方打日志 / 提示） */
  error: { error: unknown; context: string };
}

type Handler<T> = (payload: T) => void;

export interface VoiceRoomClientOptions {
  /** 服务器地址，例如 `https://room.example.com` */
  baseUrl: string;
  /** 持久化实现；浏览器默认 localStorage，其他环境默认内存 */
  storage?: StorageAdapter;
  fetchImpl?: typeof fetch;
  /** 注入 WebSocket 实现（Node < 22 / React Native 需要） */
  webSocketImpl?: typeof WebSocket;
  /**
   * 是否自动轮询服务器在线状态（默认 true）。
   * 纯「进房间说话」的场景可以关掉，省请求。
   */
  presence?: boolean;
  /** 是否自动重连 WebSocket（默认 true） */
  autoReconnect?: boolean;
  /** 心跳间隔（毫秒），默认取 shared/constants 的 15s */
  heartbeatIntervalMs?: number;
  /** 在线状态轮询间隔（毫秒），默认 6s */
  presencePollMs?: number;
}

// ============================================================
//  客户端
// ============================================================

export class VoiceRoomClient {
  readonly http: HttpClient;

  private options: Required<Omit<VoiceRoomClientOptions, 'storage' | 'fetchImpl' | 'webSocketImpl'>>;
  private wsImpl: typeof WebSocket | null;
  private listeners = new Map<keyof ClientEvents, Set<Handler<never>>>();

  // ---- 房间状态 ----
  private roomId: string | null = null;
  private ws: WebSocket | null = null;
  private wsState: ConnectionState = 'disconnected';
  private wsRetry = 0;
  private stopped = false;
  private socketDead = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private cachedProfile: Profile | null = null;
  private cachedConfig: ClientConfig | null = null;
  private lastPresence: PresenceSnapshot | null = null;

  constructor(options: VoiceRoomClientOptions) {
    this.options = {
      baseUrl: options.baseUrl,
      presence: options.presence ?? true,
      autoReconnect: options.autoReconnect ?? true,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      presencePollMs: options.presencePollMs ?? PRESENCE_POLL_MS,
    };

    const ws = options.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    this.wsImpl = ws ?? null;

    this.http = new HttpClient({
      baseUrl: options.baseUrl,
      storage: options.storage,
      fetchImpl: options.fetchImpl,
      onSessionExpired: (reason) => {
        this.socketDead = true;
        this.emit('sessionExpired', { reason });
      },
      onSession: (session) => {
        if (session.nickname) {
          this.cachedProfile = this.cachedProfile
            ? { ...this.cachedProfile, nickname: session.nickname }
            : this.cachedProfile;
        }
      },
    });

    // 页面重新可见 / 进程恢复时补一次续期，覆盖「设备休眠很久」的场景
    const doc = (globalThis as { document?: Document }).document;
    if (doc?.addEventListener) {
      doc.addEventListener('visibilitychange', () => {
        if (!doc.hidden && this.http.isSignedIn) void this.http.ensureFresh();
      });
    }
  }

  // ------------------------------------------------------------
  //  事件订阅
  // ------------------------------------------------------------

  on<K extends keyof ClientEvents>(event: K, handler: Handler<ClientEvents[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as Handler<ClientEvents[K]>)(payload);
      } catch (err) {
        // 订阅者自己的异常不能影响其它订阅者与主流程
        if (event !== 'error') this.emit('error', { error: err, context: `handler:${event}` });
      }
    }
  }

  // ------------------------------------------------------------
  //  鉴权
  // ------------------------------------------------------------

  /** 服务端非敏感配置（应用名、人数上限、是否需要 Turnstile…） */
  async config(force = false): Promise<ClientConfig> {
    if (this.cachedConfig && !force) return this.cachedConfig;
    this.cachedConfig = await this.http.get<ClientConfig>('/api/auth/config');
    return this.cachedConfig;
  }

  /**
   * 登录。
   *
   * **所有身份都需要人机验证**（访客与管理员一视同仁）。
   * 是否需要由 `config().loginTurnstile` 决定（默认 true）：
   *
   * - `true`：必须先渲染 Cloudflare Turnstile 拿到 token 再调用本方法。
   *   无法渲染的客户端（纯 CLI、无浏览器引擎）只能由部署方设
   *   `LOGIN_TURNSTILE=false` 整体关闭，否则无法登录。
   * - `false`：`turnstileToken` 可省略。
   */
  async login(input: {
    key: string;
    nickname: string;
    avatarId?: string | null;
    turnstileToken?: string | null;
  }): Promise<SessionResult> {
    const result = await this.http.post<SessionResult>('/api/auth/login', {
      key: input.key,
      nickname: input.nickname,
      avatarId: input.avatarId ?? null,
      turnstileToken: input.turnstileToken ?? null,
    });

    // HttpClient 已经在响应里吸收了 token，这里补齐身份信息
    this.http.setSession({
      token: result.token,
      expiresAt: result.expiresAt,
      sessionExpiresAt: result.sessionExpiresAt,
      uid: result.profile.uid,
      nickname: result.profile.nickname,
      role: result.role,
    });
    this.cachedProfile = result.profile;
    return result;
  }

  /** 主动续期 */
  async refreshSession(): Promise<SessionState | null> {
    return this.http.tryRefresh();
  }

  /** 当前会话（含 uid / nickname / 到期时间） */
  session(): SessionState | null {
    return this.http.getSession();
  }

  /** 当前用户资料（会缓存；`force` 强制重新拉取） */
  async me(force = false): Promise<Profile> {
    if (this.cachedProfile && !force) return this.cachedProfile;
    const data = await this.http.get<{ profile: Profile }>('/api/auth/me');
    this.cachedProfile = data.profile;
    return data.profile;
  }

  async updateProfile(input: {
    nickname?: string;
    avatarId?: string | null;
    avatarDataUrl?: string | null;
  }): Promise<Profile> {
    const data = await this.http.patch<{ profile: Profile }>('/api/auth/me', input);
    this.cachedProfile = data.profile;
    return data.profile;
  }

  /** 登出：先下线，再清本地凭据 */
  async logout(): Promise<void> {
    await this.http.post('/api/presence/leave', {}).catch(() => undefined);
    await this.http.post('/api/auth/logout', {}).catch(() => undefined);
    this.http.clearSession();
    this.cachedProfile = null;
  }

  // ------------------------------------------------------------
  //  房间
  // ------------------------------------------------------------

  listRooms(): Promise<RoomWithMembers[]> {
    return this.http
      .get<{ rooms: RoomWithMembers[] }>('/api/rooms')
      .then((d) => d.rooms);
  }

  createRoom(input: { name: string; maxMembers?: number }): Promise<RoomSummary> {
    return this.http.post<{ room: RoomSummary }>('/api/rooms', input).then((d) => d.room);
  }

  /**
   * 进入房间。
   *
   * 之后房间状态通过 `snapshot` 事件推送；WebSocket 断了也会自动重连并从
   * 兜底轮询里恢复，所以调用方只需要订阅事件即可。
   */
  async joinRoom(roomId: string = DEFAULT_ROOM_ID): Promise<RoomSnapshot> {
    this.roomId = roomId;
    this.socketDead = false;
    this.stopped = false;

    const data = await this.http.post<{ snapshot: RoomSnapshot; keyId: string }>(
      `/api/rooms/${encodeURIComponent(roomId)}/join`,
    );

    this.emit('snapshot', data.snapshot);
    this.startHeartbeat();
    this.startPresence();
    void this.connectSocket();

    return data.snapshot;
  }

  /** 离开房间（停掉心跳 / 轮询 / WebSocket） */
  async leaveRoom(): Promise<void> {
    const roomId = this.roomId;
    this.roomId = null;
    this.teardownTimers();
    this.closeSocket(1000, 'client leaving');

    if (roomId) {
      await this.http
        .post(`/api/rooms/${encodeURIComponent(roomId)}/leave`, {})
        .catch(() => undefined);
    }
    this.setConnection('disconnected');
  }

  /** 当前房间快照 */
  async snapshot(): Promise<RoomSnapshot | null> {
    if (!this.roomId) return null;
    return this.http.get<RoomSnapshot>(`/api/rooms/${encodeURIComponent(this.roomId)}/snapshot`);
  }

  /** 房间内可订阅的轨道（媒体客户端用它决定订阅谁） */
  listTracks(): Promise<
    Array<{ trackName: string; uid: string; sessionId: string; mid: string | null }>
  > {
    if (!this.roomId) return Promise.resolve([]);
    return this.http
      .get<{ tracks: Array<{ trackName: string; uid: string; sessionId: string; mid: string | null }> }>(
        `/api/rooms/${encodeURIComponent(this.roomId)}/tracks`,
      )
      .then((d) => d.tracks);
  }

  /** 主动上报自己的静音状态（WebSocket 活着时走 socket，省一次 HTTP 请求） */
  setMuted(muted: boolean): Promise<boolean> {
    if (this.sendOverSocket({ type: 'mute', muted })) return Promise.resolve(muted);

    if (!this.roomId) return Promise.resolve(false);
    return this.http
      .post<{ muted: boolean }>(`/api/rooms/${encodeURIComponent(this.roomId)}/mute`, { muted })
      .then((d) => d.muted);
  }

  /** 通过 WebSocket 发送一条控制消息；socket 不可用时返回 false */
  private sendOverSocket(payload: Record<string, unknown>): boolean {
    const socket = this.ws;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** 当前连接状态 */
  get connectionState(): ConnectionState {
    return this.wsState;
  }

  // ------------------------------------------------------------
  //  在线状态
  // ------------------------------------------------------------

  /**
   * 心跳：登记在线状态与所在房间。
   *
   * 返回 `banned: true` 表示已被移出服务器（服务端刻意用成功响应 + 标记，
   * 而不是只抛 403 —— 高频心跳里抛错容易被客户端当成网络抖动忽略掉）。
   */
  async heartbeatPresence(input: {
    roomId?: string | null;
    roomName?: string | null;
    status?: PresenceStatus;
    invitable?: boolean;
  } = {}): Promise<{ alive: boolean; banned?: boolean }> {
    try {
      const result = await this.http.post<{ alive: boolean; banned?: boolean }>(
        '/api/presence/heartbeat',
        input,
      );

      if (result.banned) {
        this.socketDead = true;
        this.teardownTimers();
        this.emit('banned', { reason: '你已被移出本服务器' });
      }
      return result;
    } catch (err) {
      this.emit('error', { error: err, context: 'presence.heartbeat' });
      return { alive: false };
    }
  }

  /** 轮询：服务器成员快照 + 取走新邀请 */
  async pollPresence(): Promise<PresenceSnapshot> {
    const snapshot = await this.http.post<PresenceSnapshot>('/api/presence/poll', {});
    this.lastPresence = snapshot;
    this.emit('presence', snapshot);
    for (const invite of snapshot.invites ?? []) this.emit('invite', invite);
    return snapshot;
  }

  /** 最近一次在线状态快照 */
  presence(): PresenceSnapshot | null {
    return this.lastPresence;
  }

  /** 邀请某人进房间 */
  invite(toUid: string, roomId?: string): Promise<{ sent: boolean; reason?: string }> {
    const target = roomId ?? this.roomId;
    if (!target) throw new Error('未指定房间');
    return this.http.post<{ sent: boolean; reason?: string }>('/api/presence/invite', {
      toUid,
      roomId: target,
    });
  }

  // ------------------------------------------------------------
  //  WebSocket
  // ------------------------------------------------------------

  private setConnection(state: ConnectionState): void {
    if (this.wsState === state) return;
    this.wsState = state;
    this.emit('connection', state);
  }

  private async connectSocket(): Promise<void> {
    if (this.stopped || this.socketDead || !this.roomId) return;
    if (!this.wsImpl) {
      this.emit('error', {
        error: new Error('当前环境没有 WebSocket，请通过 webSocketImpl 注入'),
        context: 'ws',
      });
      return;
    }

    const roomId = this.roomId;
    this.setConnection(this.wsRetry === 0 ? 'connecting' : 'reconnecting');

    let wsUrl: string;
    try {
      const ticket = await this.http.wsTicket(roomId);
      wsUrl = ticket.wsUrl;
    } catch (err) {
      if (err instanceof ApiError && err.unauthorized) {
        this.socketDead = true; // 会话没了，重连没有意义
        return;
      }
      this.scheduleReconnect();
      return;
    }

    // 期间可能已经离开房间
    if (this.stopped || this.roomId !== roomId) return;

    let socket: WebSocket;
    try {
      socket = new this.wsImpl(wsUrl);
    } catch (err) {
      this.emit('error', { error: err, context: 'ws.connect' });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener('open', () => {
      this.wsRetry = 0;
      this.setConnection('connected');
      // 连上后立刻补一次心跳，避免刚重连就被判定离线
      void this.http
        .post(`/api/rooms/${encodeURIComponent(roomId)}/heartbeat`, { roomId })
        .catch(() => undefined);
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let parsed: RoomEvent;
      try {
        parsed = JSON.parse(event.data) as RoomEvent;
      } catch {
        return;
      }
      void this.handleServerEvent(parsed);
    });

    socket.addEventListener('close', () => {
      if (this.ws === socket) this.ws = null;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      /* close 会跟着来 */
    });
  }

  private async handleServerEvent(event: RoomEvent): Promise<void> {
    switch (event.type) {
      case 'room-changed':
      case 'key-rotated': {
        if (event.type === 'key-rotated') this.emit('keyRotated', { keyId: event.keyId });
        const snap = await this.snapshot().catch(() => null);
        if (snap) this.emit('snapshot', snap);
        break;
      }
      case 'member-left': {
        const snap = await this.snapshot().catch(() => null);
        if (snap) this.emit('snapshot', snap);
        break;
      }
      case 'kicked':
        this.socketDead = true;
        this.roomId = null;
        this.teardownTimers();
        this.setConnection('disconnected');
        this.emit('kicked', { reason: event.reason });
        break;
      case 'room-closed':
        this.socketDead = true;
        this.roomId = null;
        this.teardownTimers();
        this.setConnection('disconnected');
        this.emit('roomClosed', { reason: event.reason });
        break;
      default:
        break;
    }
  }

  private scheduleReconnect(): void {
    this.setConnection('disconnected');
    if (this.stopped || this.socketDead || !this.options.autoReconnect || !this.roomId) return;
    if (this.reconnectTimer) return;

    this.wsRetry += 1;
    // 指数退避，上限 30 秒：网络恢复前不要疯狂打服务端
    const delay = Math.min(1000 * 2 ** Math.min(this.wsRetry, 5), 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSocket();
    }, delay);
  }

  private closeSocket(code: number, reason: string): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.ws;
    this.ws = null;
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      /* 已经关了 */
    }
  }

  // ------------------------------------------------------------
  //  定时器
  // ------------------------------------------------------------

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const roomId = this.roomId;
      if (!roomId) return;
      // 优先走 WebSocket（不发 HTTP，省请求额度）；没连上时退回 HTTP
      if (this.sendOverSocket({ type: 'heartbeat' })) return;
      void this.http
        .post(`/api/rooms/${encodeURIComponent(roomId)}/heartbeat`, { roomId })
        .catch(() => undefined);
    }, this.options.heartbeatIntervalMs);
  }

  private startPresence(): void {
    if (!this.options.presence || this.presenceTimer) return;

    const tick = async () => {
      try {
        await this.pollPresence();
      } catch (err) {
        if (err instanceof ApiError && err.code === ErrorCode.BANNED) {
          this.socketDead = true;
          this.teardownTimers();
          this.emit('banned', { reason: err.message });
          return;
        }
        // 401 已由 http 层处理（会触发 sessionExpired）
        if (!(err instanceof ApiError && err.unauthorized)) {
          this.emit('error', { error: err, context: 'presence.poll' });
        }
      }
    };

    void tick();
    this.presenceTimer = setInterval(() => void tick(), this.options.presencePollMs);
  }

  private teardownTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.heartbeatTimer = null;
    this.presenceTimer = null;
  }

  /** 释放全部资源（进程退出前 / 组件卸载时调用） */
  dispose(): void {
    this.stopped = true;
    this.teardownTimers();
    this.closeSocket(1000, 'disposed');
    this.listeners.clear();
  }
}

// ============================================================
//  媒体层接口（不实现，只约定）
// ============================================================

/**
 * 媒体传输接口。
 *
 * SDK 只负责信令与房间状态；真正的音频链路由各平台自己实现：
 *   - 浏览器：`RTCPeerConnection` + `getUserMedia`
 *   - React Native：`react-native-webrtc`
 *   - 原生：平台 WebRTC 库
 *
 * 服务端的 SDP 交换接口是稳定的（`/api/rtc/publish`、`/api/rtc/subscribe-batch`、
 * `/api/rtc/renegotiate`、`/api/rtc/close`），参数与返回值见 `docs/API.md`。
 * 实现要点（踩过的坑都在这儿）：
 *   1. 发布与订阅用**两条独立的 PeerConnection**；
 *   2. 同一个 session 上的变更必须**串行**（一次 SDP 交换完成前不能发起下一次）；
 *   3. 订阅用**一个接收会话**承载所有人，不是每人一条连接；
 *   4. `tracks/close` 只认 mid，不是 trackName；
 *   5. 远端轨道要按 `trackName` 关联回 uid（房间的 tracks 表是权威来源）。
 */
export interface MediaTransport {
  /** 开始发布本地音频，返回 trackName 与 publisherSessionId */
  publish(): Promise<{ trackName: string; sessionId: string }>;
  /** 订阅某个发布者的音频 */
  subscribe(input: { publisherSessionId: string; trackName: string; uid: string }): Promise<void>;
  /** 取消订阅 */
  unsubscribe(uid: string): Promise<void>;
  /** 停止发布并释放本地设备 */
  stopPublish(): Promise<void>;
  /** 远端音频到达 */
  onRemoteTrack(handler: (uid: string, track: unknown) => void): () => void;
  /** 远端音频移除 */
  onRemoteTrackRemoved(handler: (uid: string) => void): () => void;
}

/** 便捷常量：默认房间 id */
export { DEFAULT_ROOM_ID };

/** 类型再导出：调用方只需要 import 这个文件 */
export type {
  ClientConfig,
  PresenceInvite,
  PresenceSnapshot,
  PresenceStatus,
  Profile,
  RoomEvent,
  RoomMember,
  RoomSnapshot,
  RoomSummary,
  RoomWithMembers,
  SessionResult,
};
