/**
 * 跨客户端 HTTP 层。
 *
 * 设计约束（决定了这里的每个选择）：
 *   - **零依赖**：只能 import `shared/` 里的类型与常量。任何平台相关能力
 *     （fetch / WebSocket / 定时器 / 存储）都由调用方注入或做特性检测。
 *   - **不发散**：不做业务逻辑，只负责「带上凭据、解析统一响应、处理 401」。
 *   - **凭据只有一种形态**：`Authorization: Bearer`。
 *     Cookie 是浏览器专属的便利通道，SDK 不依赖它 —— 否则原生客户端就没法用。
 */

import type { ApiResult } from '../../shared/types';
import { ErrorCode } from '../../shared/types';

/** 服务端统一响应体 */
export type { ApiResult };

/**
 * API 错误。`code` 是稳定契约，`message` 只用于展示。
 *
 * 注意：这里刻意**不用构造函数参数属性**（`constructor(readonly code: string)`），
 * 因为 SDK 要能被 Node 的 type-stripping（`--experimental-strip-types`）
 * 直接加载 —— 那个模式只擦除类型，无法生成参数属性所需的赋值代码。
 */
export class ApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, code: string | undefined, status: number, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  /** 需要清理会话并重新登录 */
  get unauthorized(): boolean {
    return this.status === 401;
  }

  /** token 寿命到顶（与 unauthorized 区分：这个不该重试，该回登录页） */
  get sessionExpired(): boolean {
    return this.code === ErrorCode.SESSION_EXPIRED;
  }

  /** 触发限流，可按 Retry-After 重试 */
  get rateLimited(): boolean {
    return this.status === 429 || this.code === ErrorCode.RATE_LIMITED;
  }
}

/** 网络层失败（连不上 / DNS / TLS），与 HTTP 错误区分开 */
export class NetworkError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/** 可插拔的持久化（浏览器默认 localStorage，Node 可换文件或内存） */
export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** 内存实现：测试与非浏览器环境的默认值 */
export class MemoryStorage implements StorageAdapter {
  private map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

/** 浏览器 localStorage（不可用时退回内存） */
export function browserStorage(): StorageAdapter {
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      return {
        get: (k) => globalThis.localStorage.getItem(k),
        set: (k, v) => globalThis.localStorage.setItem(k, v),
        remove: (k) => globalThis.localStorage.removeItem(k),
      };
    }
  } catch {
    /* 隐私模式等场景访问 localStorage 会抛异常 */
  }
  return new MemoryStorage();
}

/** 会话状态 */
export interface SessionState {
  token: string;
  /** token 过期时间（Unix 秒） */
  expiresAt: number;
  /** 会话绝对上限（Unix 秒），到点必须重新用 key 登录 */
  sessionExpiresAt?: number;
  uid?: string;
  nickname?: string;
  role?: 'guest' | 'admin';
}

export interface HttpClientOptions {
  baseUrl: string;
  storage?: StorageAdapter;
  /** 自定义 fetch（某些运行时没有全局 fetch） */
  fetchImpl?: typeof fetch;
  /**
   * 会话失效回调：token 过期且无法续期时触发。
   * 典型实现：清本地状态 + 回到登录界面。
   */
  onSessionExpired?: (reason: 'expired' | 'invalid') => void;
  /** 每次 token 被更新时触发（便于落盘 / 打日志） */
  onSession?: (session: SessionState) => void;
  /** 当前时间（秒），便于测试注入 */
  now?: () => number;
}

const SESSION_KEY = 'cf-teamspeed.session';
/** 提前续期的余量（秒）：剩余寿命低于这个值就主动续 */
const REFRESH_LEAD_SECONDS = 5 * 60;

/**
 * HTTP 客户端：负责 baseUrl、Bearer 凭据、统一响应解析、401 处置。
 *
 * 所有接口方法只做一件事 —— 把 HTTP 语义翻译成类型化的返回值，
 * 不掺业务判断（那是调用方的事）。
 */
export class HttpClient {
  readonly baseUrl: string;
  private storage: StorageAdapter;
  private fetchImpl: typeof fetch;
  private onSessionExpired?: (reason: 'expired' | 'invalid') => void;
  private onSession?: (session: SessionState) => void;
  private now: () => number;
  private session: SessionState | null = null;
  /** 正在进行的续期请求：并发调用只发一次 */
  private refreshing: Promise<SessionState | null> | null = null;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.storage = options.storage ?? browserStorage();
    const fetcher = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetcher !== 'function') {
      throw new Error('当前环境没有 fetch，请通过 fetchImpl 注入');
    }
    // 绑定到 globalThis：某些运行时要求 fetch 以全局身份调用
    this.fetchImpl = fetcher.bind(globalThis) as typeof fetch;
    this.onSessionExpired = options.onSessionExpired;
    this.onSession = options.onSession;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.session = this.loadSession();
  }

  // ------------------------------------------------------------
  //  会话存取
  // ------------------------------------------------------------

  private loadSession(): SessionState | null {
    const raw = this.storage.get(SESSION_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SessionState;
      if (!parsed.token || typeof parsed.expiresAt !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 当前会话（没有则 null） */
  getSession(): SessionState | null {
    return this.session ? { ...this.session } : null;
  }

  /** 写入会话（登录成功后调用） */
  setSession(session: SessionState): void {
    this.session = session;
    this.storage.set(SESSION_KEY, JSON.stringify(session));
    this.onSession?.({ ...session });
  }

  /** 清除会话（登出 / 到期） */
  clearSession(): void {
    this.session = null;
    this.storage.remove(SESSION_KEY);
  }

  get isSignedIn(): boolean {
    return this.session !== null;
  }

  // ------------------------------------------------------------
  //  请求
  // ------------------------------------------------------------

  private headers(init?: HeadersInit): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((init as Record<string, string> | undefined) ?? {}),
    };
    if (this.session?.token) headers.Authorization = `Bearer ${this.session.token}`;
    return headers;
  }

  /** 底层请求：解析统一响应、吸收续期 token、按需抛错 */
  async raw<T>(
    path: string,
    init: RequestInit = {},
    options: { allowRetry?: boolean; guard?: boolean } = {},
  ): Promise<T> {
    const allowRetry = options.allowRetry !== false;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.headers),
      });
    } catch (err) {
      throw new NetworkError(`无法连接 ${this.baseUrl}`, err);
    }

    // 服务端可能在任何鉴权请求上滚动续期，顺手把新 token 收下
    const refreshed = res.headers.get('X-Refreshed-Token');
    if (refreshed && this.session) {
      this.setSession({ ...this.session, token: refreshed });
    }

    const text = await res.text();
    let body: ApiResult<T> | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as ApiResult<T>;
      } catch {
        /* 非 JSON（例如 CSV 导出、网关错误页） */
      }
    }

    if (res.status === 401) {
      // 先尝试静默续期一次：长连接客户端可能只是 token 到期而会话还在。
      // 无论成败都要退出登录态（续期失败说明会话真的没了），
      // 但 onSessionExpired 只在「原本确实登录着」时通知一次 ——
      // 否则一个未登录的客户端会反复收到「你掉线了」。
      const hadSession = this.session !== null;
      const renewed = hadSession && allowRetry ? await this.tryRefresh() : false;
      if (renewed) {
        return this.raw<T>(path, init, { allowRetry: false });
      }

      const code = body && body.ok === false ? body.code : undefined;
      const expired = code === ErrorCode.SESSION_EXPIRED;
      this.clearSession();
      if (hadSession && !options.guard) {
        this.onSessionExpired?.(expired ? 'expired' : 'invalid');
      }

      throw new ApiError(
        (body && body.ok === false && body.error) || '会话已失效，请重新登录',
        code,
        401,
      );
    }

    if (!res.ok || !body || body.ok !== true) {
      const failure = body && body.ok === false ? body : null;
      throw new ApiError(
        failure?.error ?? `请求失败（HTTP ${res.status}）`,
        failure?.code,
        res.status,
        (failure as { detail?: unknown } | null)?.detail,
      );
    }

    // 响应体里带 token 的接口（登录 / 续期 / 改资料）在这里统一吸收
    const data = body.data as T & { token?: string; expiresAt?: number; sessionExpiresAt?: number };
    if (data && typeof data.token === 'string' && typeof data.expiresAt === 'number') {
      this.setSession({
        ...(this.session ?? { token: data.token, expiresAt: data.expiresAt }),
        token: data.token,
        expiresAt: data.expiresAt,
        sessionExpiresAt: data.sessionExpiresAt ?? this.session?.sessionExpiresAt,
      });
    }

    return body.data;
  }

  get<T>(path: string): Promise<T> {
    return this.raw<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.raw<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.raw<T>(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  delete<T>(path: string): Promise<T> {
    return this.raw<T>(path, { method: 'DELETE' });
  }

  /** 取原始响应（CSV 导出这类非 JSON 接口用） */
  async rawResponse(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.headers),
      });
    } catch (err) {
      throw new NetworkError(`无法连接 ${this.baseUrl}`, err);
    }
  }

  // ------------------------------------------------------------
  //  续期
  // ------------------------------------------------------------

  /** 当前 token 是否该续期了 */
  needsRefresh(): boolean {
    if (!this.session) return false;
    return this.session.expiresAt - this.now() < REFRESH_LEAD_SECONDS;
  }

  /**
   * 主动续期。并发调用会合并成一次请求。
   * 返回新会话；无法续期（会话到顶 / 网络失败）返回 null。
   */
  async tryRefresh(): Promise<SessionState | null> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      try {
        const data = await this.raw<{
          token: string;
          expiresAt: number;
          sessionExpiresAt?: number;
          profile?: { uid: string; nickname: string; role: 'guest' | 'admin' };
        }>(
          '/api/auth/refresh',
          { method: 'POST' },
          // guard：续期失败时**不要**自己发 sessionExpired 事件。
          // 调用方（raw 的 401 分支 / ensureFresh）会统一发一次，
          // 否则一次失败会派发两遍，订阅者会重复跳登录页。
          { allowRetry: false, guard: true },
        );
        return this.getSession() ?? {
          token: data.token,
          expiresAt: data.expiresAt,
          sessionExpiresAt: data.sessionExpiresAt,
          uid: data.profile?.uid,
          nickname: data.profile?.nickname,
          role: data.profile?.role,
        };
      } catch {
        return null;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  /** 若临近过期则续期（调用方可以在每次请求前或定时调用） */
  async ensureFresh(): Promise<void> {
    if (this.needsRefresh()) await this.tryRefresh();
  }

  // ------------------------------------------------------------
  //  WebSocket 握手票据
  // ------------------------------------------------------------

  /**
   * 领 WebSocket 握手票据。
   *
   * WebSocket 无法自定义请求头，所以「带 Bearer 的 HTTP 领票 + 查询串握手」
   * 是所有平台通用的唯一方案。
   */
  async wsTicket(roomId: string): Promise<{ ticket: string; wsUrl: string; expiresAt: number }> {
    return this.post(`/api/rooms/${encodeURIComponent(roomId)}/ws-ticket`, {});
  }
}
