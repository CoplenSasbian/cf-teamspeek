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
    /** off | gtcrn | rnnoise */
    engine: 'off' | 'gtcrn' | 'rnnoise';
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
      volumes: parsed.volumes,
      soundEffects: parsed.soundEffects,
      denoise: parsed.denoise,
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
