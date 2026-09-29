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
