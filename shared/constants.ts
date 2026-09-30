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

/**
 * 会话 JWT 有效期（小时）—— **滚动续期窗口**。
 *
 * 含义：token 签发后 12 小时内有效；只要在有效期内发起过任意鉴权请求，
 * 服务端就会顺带换发一个新 token（原始签发时间 `iat` 保持不变），
 * 于是活跃会话自动延长，闲置超过 12 小时才掉线。
 */
export const SESSION_TTL_HOURS = 12;

/**
 * 会话绝对寿命（小时）—— **硬上限，不可续期**。
 *
 * 无论多活跃，从首次登录算起最多存活这么久，之后必须重新用 key 登录。
 * 作用：避免一个泄露的 token 被无限续期成永久通行证。
 */
export const SESSION_ABSOLUTE_TTL_HOURS = 24 * 30;

/** 管理后台会话有效期（小时）—— 独立于客户端会话，短一些降低泄露窗口 */
export const ADMIN_SESSION_TTL_HOURS = 4;

/** 管理后台会话绝对寿命（小时）—— 后台权限大，硬上限给得比客户端短 */
export const ADMIN_SESSION_ABSOLUTE_TTL_HOURS = 24 * 7;

/**
 * WebSocket 握手 ticket 有效期（秒）。
 *
 * 浏览器与原生客户端的 WebSocket API 都**无法自定义请求头**，
 * 因此不能直接带 `Authorization: Bearer`。改为：先用 HTTP（可带 Bearer）
 * 领一张一次性 ticket，再把它放进 WebSocket URL 的查询串里。
 * 握手是紧接着发生的，所以有效期给得很短。
 */
export const WS_TICKET_TTL_SECONDS = 60;

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
