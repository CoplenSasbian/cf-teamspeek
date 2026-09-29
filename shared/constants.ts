/** 保留昵称黑名单（小写规范化后比较） */
export const RESERVED_NICKNAMES = new Set([
  'admin',
  'administrator',
  'system',
  'root',
  'owner',
  'official',
  'moderator',
  'mod',
  'guest',
  'anonymous',
  'anon',
  '官方',
  '管理员',
  '系统',
  '版主',
  '客服',
  '匿名',
  '游客',
]);

/** 昵称最长/最短（与 schema 保持一致，注册表侧再做一次防御） */
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 16;

/** 会话 JWT 有效期（小时） */
export const SESSION_TTL_HOURS = 12;

/** 管理后台会话有效期（小时）—— 独立于客户端会话，短一些降低泄露窗口 */
export const ADMIN_SESSION_TTL_HOURS = 4;

/** 管理后台独立 cookie / 登录路径 */
export const ADMIN_SESSION_COOKIE = 'ct_admin_session';

/** 心跳间隔与离线判定（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const OFFLINE_THRESHOLD_MS = 45_000;

/** 客户端兜底轮询间隔（毫秒） */
export const SNAPSHOT_POLL_MS = 15_000;

/**
 * 服务器在线状态（presence）心跳与轮询间隔。
 * 心跳用于判定「在线」，轮询用于拉取成员列表与新收到的邀请。
 */
export const PRESENCE_HEARTBEAT_MS = 15_000;
export const PRESENCE_POLL_MS = 6_000;

/** 邀请记录保留时长（毫秒），过期自动清理 */
export const INVITE_TTL_MS = 10 * 60_000;

/** 登录失败锁定 */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MINUTES = 15;

/** 默认房间 id（无需创建，直接用） */
export const DEFAULT_ROOM_ID = 'home';
export const DEFAULT_ROOM_NAME = '默认房间';

/** 用量 flush 间隔（分钟） */
export const USAGE_FLUSH_INTERVAL_MINUTES = 10;

/** STUN 服务器 */
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** 预设头像 ID 列表（与 assets/avatars/ 一一对应） */
export const PRESET_AVATARS = [
  'bottts-01',
  'bottts-02',
  'pixel-art-01',
  'pixel-art-02',
  'adventurer-01',
  'adventurer-02',
  'lorelei-01',
  'lorelei-02',
  'fun-emoji-01',
  'fun-emoji-02',
  'shapes-01',
  'identicon-01',
] as const;

export type PresetAvatarId = (typeof PRESET_AVATARS)[number];

/** 各预设头像对应的 DiceBear 风格与 seed */
export const PRESET_AVATAR_SPECS: Record<
  PresetAvatarId,
  { style: string; seed: string }
> = {
  'bottts-01': { style: 'bottts', seed: 'Nova' },
  'bottts-02': { style: 'bottts', seed: 'Pixel' },
  'pixel-art-01': { style: 'pixelArt', seed: 'Knight' },
  'pixel-art-02': { style: 'pixelArt', seed: 'Mage' },
  'adventurer-01': { style: 'adventurer', seed: 'Scout' },
  'adventurer-02': { style: 'adventurer', seed: 'Ranger' },
  'lorelei-01': { style: 'lorelei', seed: 'Aria' },
  'lorelei-02': { style: 'lorelei', seed: 'Luna' },
  'fun-emoji-01': { style: 'funEmoji', seed: 'Happy' },
  'fun-emoji-02': { style: 'funEmoji', seed: 'Cool' },
  'shapes-01': { style: 'shapes', seed: 'Geo' },
  'identicon-01': { style: 'identicon', seed: 'Meta' },
};
