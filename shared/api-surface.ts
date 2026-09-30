/**
 * API 表面清册 —— 机器可读的接口清单。
 *
 * 作用：给「跨客户端」这件事一个**不会悄悄失配**的锚点。
 * 别人写新客户端时，可以照着这份清单确认自己覆盖了哪些能力；
 * 仓库里也有测试（`scripts/test-client-api.ts`）核对它与 OpenAPI 文档一致。
 *
 * 维护纪律：新增路由时同时改这里和 `docs/openapi.json`，
 * 否则 `npm run test:api` 会失败 —— 这是刻意的，防止文档腐烂。
 *
 * 鉴权等级：
 *   - `public`    无需登录
 *   - `session`   需要客户端会话（Cookie 或 Bearer 都可以）
 *   - `admin`     需要管理员后台会话（`/api/admin/auth/login` 签发的专用 token）
 *   - `adminRole` 客户端会话且 role=admin（保留给未来的分级能力）
 */

export type AuthLevel = 'public' | 'session' | 'admin' | 'adminRole';

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  auth: AuthLevel;
  /** 一句话说明 */
  summary: string;
  /** 是否属于「第三方客户端最少必须实现」的核心闭环 */
  core?: boolean;
}

export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  // ---- 配置与健康 ----
  { method: 'GET', path: '/api/health', auth: 'public', summary: '存活探针', core: true },
  { method: 'GET', path: '/api/auth/config', auth: 'public', summary: '非敏感前端配置', core: true },

  // ---- 鉴权 ----
  { method: 'POST', path: '/api/auth/login', auth: 'public', summary: 'key + 昵称换会话 token', core: true },
  { method: 'POST', path: '/api/auth/refresh', auth: 'session', summary: '会话续期', core: true },
  { method: 'GET', path: '/api/auth/me', auth: 'session', summary: '当前资料与到期时间', core: true },
  { method: 'PATCH', path: '/api/auth/me', auth: 'session', summary: '改昵称 / 头像' },
  { method: 'POST', path: '/api/auth/logout', auth: 'public', summary: '登出（清 Cookie）', core: true },

  // ---- 房间 ----
  { method: 'GET', path: '/api/rooms', auth: 'session', summary: '房间列表（含成员）', core: true },
  { method: 'POST', path: '/api/rooms', auth: 'session', summary: '创建房间' },
  { method: 'PATCH', path: '/api/rooms/{id}', auth: 'session', summary: '改名 / 调上限（房主或管理员）' },
  { method: 'DELETE', path: '/api/rooms/{id}', auth: 'session', summary: '删除房间（房主或管理员）' },
  { method: 'GET', path: '/api/rooms/default', auth: 'session', summary: '取默认房间 home' },
  { method: 'GET', path: '/api/rooms/{id}/snapshot', auth: 'session', summary: '房间快照（权威状态）', core: true },
  { method: 'GET', path: '/api/rooms/{id}/tracks', auth: 'session', summary: '可订阅轨道列表', core: true },
  { method: 'POST', path: '/api/rooms/{id}/join', auth: 'session', summary: '进入房间', core: true },
  { method: 'POST', path: '/api/rooms/{id}/leave', auth: 'session', summary: '离开房间', core: true },
  { method: 'POST', path: '/api/rooms/{id}/heartbeat', auth: 'session', summary: 'HTTP 心跳', core: true },
  { method: 'POST', path: '/api/rooms/{id}/mute', auth: 'session', summary: '上报静音状态' },
  { method: 'POST', path: '/api/rooms/{id}/ws-ticket', auth: 'session', summary: '领 WebSocket 握手票', core: true },

  // ---- SFU 信令 ----
  { method: 'POST', path: '/api/rtc/publish', auth: 'session', summary: '发布本地音频', core: true },
  { method: 'POST', path: '/api/rtc/subscribe', auth: 'session', summary: '订阅单条远端轨道' },
  { method: 'POST', path: '/api/rtc/subscribe-batch', auth: 'session', summary: '批量订阅（推荐）', core: true },
  { method: 'POST', path: '/api/rtc/renegotiate', auth: 'session', summary: '提交 SDP answer', core: true },
  { method: 'POST', path: '/api/rtc/close', auth: 'session', summary: '关闭轨道（按 mid）', core: true },
  { method: 'POST', path: '/api/rtc/usage', auth: 'session', summary: '上报估算流量' },

  // ---- 在线状态 ----
  { method: 'POST', path: '/api/presence/heartbeat', auth: 'session', summary: '登记在线与所在房间' },
  { method: 'POST', path: '/api/presence/poll', auth: 'session', summary: '拉成员名册 + 收邀请' },
  { method: 'POST', path: '/api/presence/leave', auth: 'session', summary: '主动下线' },
  { method: 'POST', path: '/api/presence/invite', auth: 'session', summary: '邀请他人进房间' },
  { method: 'POST', path: '/api/presence/kick', auth: 'adminRole', summary: '踢出服务器（管理员）' },

  // ---- 管理后台（专用 token） ----
  { method: 'POST', path: '/api/admin/auth/login', auth: 'public', summary: '后台登录' },
  { method: 'POST', path: '/api/admin/auth/refresh', auth: 'admin', summary: '后台会话续期' },
  { method: 'POST', path: '/api/admin/auth/logout', auth: 'public', summary: '后台登出' },
  { method: 'GET', path: '/api/admin/auth/me', auth: 'admin', summary: '后台身份' },
  { method: 'GET', path: '/api/admin/overview', auth: 'admin', summary: '实时概览' },
  { method: 'GET', path: '/api/admin/usage', auth: 'admin', summary: '用量看板' },
  { method: 'GET', path: '/api/admin/audit', auth: 'admin', summary: '审计查询' },
  { method: 'GET', path: '/api/admin/audit/export', auth: 'admin', summary: '导出审计 CSV' },
  { method: 'POST', path: '/api/admin/kick', auth: 'admin', summary: '踢出房间成员' },
  { method: 'POST', path: '/api/admin/rooms/{id}/close', auth: 'admin', summary: '关闭房间' },
  { method: 'DELETE', path: '/api/admin/rooms/{id}', auth: 'admin', summary: '彻底删除房间' },
  { method: 'PATCH', path: '/api/admin/rooms/{id}', auth: 'admin', summary: '管理员改名' },
  { method: 'PATCH', path: '/api/admin/rooms/{id}/limit', auth: 'admin', summary: '调人数上限' },
  { method: 'POST', path: '/api/admin/rooms/{id}/rotate-key', auth: 'admin', summary: '轮换房间密钥' },
  { method: 'GET', path: '/api/admin/bans', auth: 'admin', summary: '封禁列表' },
  { method: 'POST', path: '/api/admin/bans', auth: 'admin', summary: '新增封禁' },
  { method: 'DELETE', path: '/api/admin/bans/{id}', auth: 'admin', summary: '解除封禁' },
  { method: 'GET', path: '/api/admin/users', auth: 'admin', summary: '已注册用户' },
  { method: 'DELETE', path: '/api/admin/users/{nickname}', auth: 'admin', summary: '释放昵称' },
  { method: 'POST', path: '/api/admin/flush', auth: 'admin', summary: '手动落库到 D1' },
] as const;

/** 核心闭环：新客户端最少要实现这些才算「能用」 */
export const CORE_ENDPOINTS = API_ENDPOINTS.filter((e) => e.core);

/** WebSocket 端点（不在 HTTP 清册里，单独列出） */
export const WS_ENDPOINTS = [
  {
    path: '/api/rooms/{id}/ws',
    auth: 'ticket',
    summary: '房间事件流；握手需 ?ticket=<一次性票据>（HTTP 领票）',
  },
] as const;

/** 上行 / 下行的 WebSocket 消息类型（客户端必须认得的） */
export const WS_DOWNLINK = [
  'room-changed',
  'member-joined',
  'member-left',
  'key-rotated',
  'kicked',
  'room-closed',
] as const;

export const WS_UPLINK = ['heartbeat', 'mute'] as const;
