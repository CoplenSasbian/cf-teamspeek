import { z } from 'zod';

// ============================================================
//  cf-teamspeed — 共享 Zod schema
//  服务端用 zValidator 校验，客户端复用同一份类型
// ============================================================

/** 全角 → 半角 + 去首尾空白（与 workers/lib/crypto.ts 的规范化保持一致） */
function toHalfWidth(raw: string): string {
  return raw
    .trim()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ');
}

/** 昵称：2–16 字符，中英文数字与 _ - 空格；输入阶段先做全角折叠 */
export const nicknameSchema = z
  .string()
  .transform(toHalfWidth)
  .pipe(
    z
      .string()
      .min(2, '昵称至少 2 个字符')
      .max(16, '昵称最多 16 个字符')
      .regex(/^[\u4e00-\u9fa5a-zA-Z0-9_\- ]+$/u, '昵称只能包含中英文、数字、下划线和短横线'),
  );

/** 登录请求 */
export const loginSchema = z.object({
  key: z.string().min(1, 'key 不能为空'),
  nickname: nicknameSchema,
  avatarId: z.string().max(64).nullable().optional(),
  /** Turnstile token（访客登录可选，管理员强制） */
  turnstileToken: z.string().nullable().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** 更新资料 */
export const updateProfileSchema = z.object({
  nickname: nicknameSchema.optional(),
  avatarId: z.string().max(64).nullable().optional(),
  /** data URL 形式的上传头像（服务端会压缩限制） */
  avatarDataUrl: z
    .string()
    .max(200_000, '头像图片过大')
    .regex(/^data:image\/(png|jpeg|webp);base64,/, '头像格式仅支持 png/jpeg/webp')
    .nullable()
    .optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** 创建房间 */
export const createRoomSchema = z.object({
  name: z.string().trim().min(1, '房间名不能为空').max(24, '房间名最多 24 个字符'),
  maxMembers: z.number().int().min(2).max(50).optional(),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

/** 修改房间（改名 / 调人数上限）；至少给一个字段 */
export const updateRoomSchema = z
  .object({
    name: z.string().trim().min(1, '房间名不能为空').max(24, '房间名最多 24 个字符').optional(),
    maxMembers: z.number().int().min(2, '人数上限至少 2 人').max(50, '人数上限最多 50 人').optional(),
  })
  .refine((v) => v.name !== undefined || v.maxMembers !== undefined, {
    message: '没有要修改的内容',
  });
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

/** SFU 发布请求 */
export const publishSchema = z.object({
  sdp: z.string().min(1),
  /** 客户端生成的 track 名，用于订阅方定位 */
  trackName: z.string().min(1).max(64),
  /** 客户端 transceiver 的 mid（setLocalDescription 之后读取） */
  mid: z.string().max(16).optional(),
  /** 房间密钥轮换 id，用于服务端校验成员资格 */
  roomId: z.string().min(1),
});
export type PublishInput = z.infer<typeof publishSchema>;

/** SFU 订阅请求 */
export const subscribeSchema = z.object({
  roomId: z.string().min(1),
  /** 发布者的 sessionId */
  publisherSessionId: z.string().min(1),
  /** 要拉取的 track 名 */
  trackName: z.string().min(1).max(64),
});
export type SubscribeInput = z.infer<typeof subscribeSchema>;

/**
 * SFU 批量订阅请求：在【同一个接收会话】上一次拉取多条远端轨道。
 * 官方推荐一个接收会话承载所有订阅，避免每人一条 PeerConnection。
 */
export const subscribeBatchSchema = z.object({
  roomId: z.string().min(1),
  /** 接收会话的 sessionId（由 /subscribe-batch/init 或首次请求创建） */
  sessionId: z.string().min(1).optional(),
  tracks: z
    .array(
      z.object({
        publisherSessionId: z.string().min(1),
        trackName: z.string().min(1).max(64),
      }),
    )
    .min(1)
    .max(16),
});
export type SubscribeBatchInput = z.infer<typeof subscribeBatchSchema>;

/** SFU renegotiate 请求 */
export const renegotiateSchema = z.object({
  roomId: z.string().min(1),
  sessionId: z.string().min(1),
  sdp: z.string().min(1),
});
export type RenegotiateInput = z.infer<typeof renegotiateSchema>;

/** 关闭 tracks 请求 */
export const closeTracksSchema = z.object({
  roomId: z.string().min(1),
  sessionId: z.string().min(1),
  trackNames: z.array(z.string()).min(1),
  /**
   * 与 trackNames 一一对应的接收侧 mid（订阅轨道关闭时必填，
   * 因为 SFU 的 tracks/close 只认 mid）。
   */
  mids: z.array(z.string()).optional(),
  /** 默认 true：不等待 SDP 交换，适合清理场景 */
  force: z.boolean().optional(),
});
export type CloseTracksInput = z.infer<typeof closeTracksSchema>;

/** 心跳 */
export const heartbeatSchema = z.object({
  roomId: z.string().min(1),
});
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

/** 管理员：踢人 */
export const kickSchema = z.object({
  roomId: z.string().min(1),
  uid: z.string().min(1),
  reason: z.string().max(100).optional(),
});
export type KickInput = z.infer<typeof kickSchema>;

/** 服务器在线状态：心跳 */
export const presenceHeartbeatSchema = z.object({
  /** 当前所在房间（不在房间传 null / 省略） */
  roomId: z.string().max(64).nullable().optional(),
  roomName: z.string().max(64).nullable().optional(),
  /** 在线状态：online 在线 / busy 忙碌 / away 离开 / invisible 隐身 */
  status: z.enum(['online', 'busy', 'away', 'invisible']).optional(),
  /** 是否允许被邀请进房间（false 时别人发邀请会被拒） */
  invitable: z.boolean().optional(),
});
export type PresenceHeartbeatInput = z.infer<typeof presenceHeartbeatSchema>;

/** 邀请入频道 */
export const inviteSchema = z.object({
  toUid: z.string().min(1),
  roomId: z.string().min(1),
});
export type InviteInput = z.infer<typeof inviteSchema>;

/** 管理员：踢出服务器（断开连接 + 封禁昵称） */
export const serverKickSchema = z.object({
  uid: z.string().min(1),
  reason: z.string().max(100).optional(),
  /** 封禁时长（分钟），不填为永久 */
  durationMinutes: z.number().int().positive().optional(),
});
export type ServerKickInput = z.infer<typeof serverKickSchema>;

/** 管理员：封禁 */
export const banSchema = z.object({
  kind: z.enum(['ip', 'nickname']),
  value: z.string().min(1).max(128),
  reason: z.string().max(200).optional(),
  /** 封禁时长（分钟），不填为永久 */
  durationMinutes: z.number().int().positive().optional(),
});
export type BanInput = z.infer<typeof banSchema>;

/** 审计查询 */
export const auditQuerySchema = z.object({
  nickname: z.string().optional(),
  event: z.string().optional(),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
