/**
 * 本地设置持久化（localStorage）。
 * 浏览器直开时 baseUrl 默认取 window.location.origin，
 * WebView 套壳可通过 window.__CF_VOICE_BASE_URL__ 覆盖。
 */

export interface Settings {
  baseUrl: string;
  key: string;
  nickname: string;
  avatarId: string | null;
  /**
   * 会话 token（Bearer）。
   *
   * 浏览器端本来靠 HttpOnly Cookie 就够了，这里再存一份的原因：
   * 服务端支持「Cookie 与 Bearer 并存」，而 Bearer 是**跨客户端通用**的形态。
   * 网页端也走同一条路，可以保证「网页能跑 = 别的客户端也能跑」，
   * 少一类只在浏览器里出现的诡异问题（比如 Safari 的 ITP 清掉 cookie）。
   *
   * 代价：token 落在 localStorage 里，XSS 能读到（原本 HttpOnly 能挡住）。
   * 这是本项目愿意接受的取舍 —— 单个部署、私人使用，且同时保留 cookie 通路，
   * 真被清了也还能继续用。
   */
  sessionToken?: string;
  /** token 绝对过期时间（Unix 秒），用于提前续期 */
  sessionExpiresAt?: number;
  /** 会话绝对上限（Unix 秒），到点必须重新登录 */
  sessionHardExpiresAt?: number;
  /** 音量偏好（按 uid 记住每个人，重启浏览器仍在） */
  volumes?: {
    /** 自己的录制音量 */
    mic: number;
    /** 总播放音量 */
    master: number;
    /** uid → 该成员播放音量 */
    users: Record<string, number>;
    /** 被我单独静音的 uid */
    mutedUsers: string[];
  };
  /** 界面音效（进/出房、新消息、被邀请），默认开 */
  soundEffects?: boolean;
  /** 麦克风降噪（浏览器端 Web Audio 降噪），默认关 */
  denoise?: {
    /** off | gtcrn | rnnoise | dfn3 */
    engine: 'off' | 'gtcrn' | 'rnnoise' | 'dfn3';
  };
  /**
   * 浏览器自带的麦克风处理。
   *
   * 它们作用在 getUserMedia 那一层，**在**我们的降噪 worklet 之前，
   * 所以和 GTCRN 是串联关系：两个降噪叠在一起容易出水声/抽吸感，
   * AGC 又和本地的响度补偿在做同一件事。是否划算只能在具体设备上试听，
   * 因此做成开关，默认全开（与历史行为一致）。
   */
  input?: {
    /** 浏览器自带降噪（noiseSuppression），默认开 */
    noiseSuppression?: boolean;
    /** 浏览器自带自动增益（autoGainControl），默认开 */
    autoGainControl?: boolean;
    /** 语音门限：低于阈值不发送，默认关 */
    gate?: {
      enabled?: boolean;
      /** 开门阈值（dBFS，-100..0） */
      thresholdDb?: number;
    };
  };
  /** 在线状态（presence 展示给别人看的） */
  presenceStatus?: 'online' | 'busy' | 'away' | 'invisible';
  /** 是否允许别人邀请我进房间 */
  invitable?: boolean;
  /** 首选输入设备（MediaDeviceInfo.deviceId） */
  inputDeviceId?: string;
  /** 首选输出设备（MediaDeviceInfo.deviceId） */
  outputDeviceId?: string;
}

const STORAGE_KEY = 'cf-teamspeed.settings';

/** 浏览器自带麦克风处理的开关键（见 Settings.input） */
export interface MicInputPrefs {
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_MIC_INPUT_PREFS: MicInputPrefs = {
  noiseSuppression: true,
  autoGainControl: true,
};

/** 从设置里读浏览器自带处理开关（缺省 = 全开，兼容老版本存的设置） */
export function micInputPrefsOf(settings: Settings | undefined): MicInputPrefs {
  return {
    noiseSuppression: settings?.input?.noiseSuppression !== false,
    autoGainControl: settings?.input?.autoGainControl !== false,
  };
}

/**
 * 语音门限偏好。
 *
 * 语义：门检测电平**低于阈值**时整段不发送（增益归零）；
 * 高于阈值时逐样本原样通过（增益精确等于 1），所以它不会改变说话的音量。
 *
 * 默认关 —— 它会在你不说话时把麦克风彻底切断，是个有存在感的开关，
 * 不该由我们替用户默认打开。
 */
export interface VoiceGatePrefs {
  enabled: boolean;
  /** 阈值（dBFS，-100..0）。越接近 0 越激进（更容易切断） */
  thresholdDb: number;
}

export const DEFAULT_VOICE_GATE: VoiceGatePrefs = {
  enabled: false,
  /** -45dBFS：比常见说话电平低一截，先保证不误伤说话，再由用户按电平表收紧 */
  thresholdDb: -45,
};

export function voiceGatePrefsOf(settings: Settings | undefined): VoiceGatePrefs {
  const g = settings?.input?.gate;
  const raw = g?.thresholdDb;
  return {
    enabled: g?.enabled === true,
    thresholdDb:
      typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(0, Math.max(-100, raw))
        : DEFAULT_VOICE_GATE.thresholdDb,
  };
}

declare global {
  interface Window {
    __CF_VOICE_BASE_URL__?: string;
  }
}

/** 解析 baseUrl 优先级：注入变量 > 默认当前 origin */
export function resolveBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  if (window.__CF_VOICE_BASE_URL__) {
    return window.__CF_VOICE_BASE_URL__.replace(/\/$/, '');
  }
  return window.location.origin;
}

export function loadSettings(): Settings {
  const fallback: Settings = {
    baseUrl: resolveBaseUrl(),
    key: '',
    nickname: '',
    avatarId: null,
  };
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      baseUrl: parsed.baseUrl || fallback.baseUrl,
      key: parsed.key ?? '',
      nickname: parsed.nickname ?? '',
      avatarId: parsed.avatarId ?? null,
      sessionToken: parsed.sessionToken,
      sessionExpiresAt: parsed.sessionExpiresAt,
      sessionHardExpiresAt: parsed.sessionHardExpiresAt,
      volumes: parsed.volumes,
      soundEffects: parsed.soundEffects,
      denoise: parsed.denoise,
      input: parsed.input,
      presenceStatus: parsed.presenceStatus,
      invitable: parsed.invitable,
      inputDeviceId: parsed.inputDeviceId,
      outputDeviceId: parsed.outputDeviceId,
    };
  } catch {
    return fallback;
  }
}

export function saveSettings(settings: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...settings };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

export function clearSettings(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

// ============================================================
//  会话 token
// ============================================================

/** 记下服务端新签发的 token 与到期时间 */
export function saveSession(
  token: string,
  expiresAt: number,
  hardExpiresAt?: number,
): void {
  saveSettings({
    sessionToken: token,
    sessionExpiresAt: expiresAt,
    ...(hardExpiresAt !== undefined ? { sessionHardExpiresAt: hardExpiresAt } : {}),
  });
}

/** 读当前 token（没有则 null） */
export function getSessionToken(): string | null {
  const s = loadSettings();
  return s.sessionToken ?? null;
}

/**
 * 清掉会话凭据（登出 / 会话到期）。
 * 刻意保留 baseUrl / nickname / key，方便用户直接重新登录。
 */
export function clearSession(): void {
  if (typeof window === 'undefined') return;
  const current = loadSettings();
  const next: Settings = { ...current };
  delete next.sessionToken;
  delete next.sessionExpiresAt;
  delete next.sessionHardExpiresAt;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

// ============================================================
//  邀请链接
// ============================================================

/**
 * 邀请链接：把服务器地址 + key 编码进 URL，别人打开自动填好，
 * 只需填昵称、选头像即可进入。
 *
 * 形如：https://your-worker.workers.dev/login?key=xxx
 *   - key     访问 key（访客 key 或管理员 key）
 *   - server  服务器地址（跨部署邀请时用；本地直开时可省略）
 *
 * 管理员 key 也能生成链接，但链接里明文携带凭据——只发给信得过的人。
 */
export function buildInviteUrl(opts: { baseUrl: string; key: string }): string {
  const base = (opts.baseUrl || (typeof window !== 'undefined' ? window.location.origin : '')).replace(
    /\/$/,
    '',
  );
  const url = new URL(`${base}/login`);

  if (opts.key.trim()) url.searchParams.set('key', opts.key.trim());

  // 只有当邀请的服务器与链接自身的来源不同时才带 server 参数，
  // 避免同一部署内生成又长又冗余的链接
  try {
    if (base && base !== window.location.origin) {
      url.searchParams.set('server', base);
    }
  } catch {
    /* 非浏览器环境：忽略 */
  }

  return url.toString();
}

/** 从当前 URL 读取邀请参数（无则返回 null） */
export function readInviteParams(): { key: string | null; server: string | null } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const key = params.get('key');
  const server = params.get('server');
  if (!key && !server) return null;
  return { key, server };
}
