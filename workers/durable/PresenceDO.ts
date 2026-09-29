import { DurableObject } from 'cloudflare:workers';
import { INVITE_TTL_MS, OFFLINE_THRESHOLD_MS } from '@shared/constants';
import type { PresenceInvite, PresenceUser, Profile, Role } from '@shared/types';
import type { Env } from '../env';

/**
 * 服务器在线状态 Durable Object（单实例，`global`）
 *
 * 本应用没有独立的「服务器」实体——一个部署就是一台服务器。
 * 因此这里承担的是「网关」角色：
 *
 *   1. 在线名册：谁保持着心跳（= 连上了这台服务器），以及他在哪个房间
 *   2. 邀请信箱：把「邀请入频道」投递到目标用户，由其轮询取走
 *   3. 离线名册：从 RegistryDO 取「已注册但当前不在线」的人（仅管理员可见）
 *
 * 为什么用轮询而不是 WebSocket：
 *   心跳 + 轮询已经能覆盖在线判定与邀请投递，且不引入每用户一条长连接，
 *   在免费额度下更省心。房间内的实时同步仍然走 RoomDO 的 WebSocket。
 *
 * 与其它 DO 一样：禁止 setInterval（会阻止休眠），超时成员采用「惰性清理」。
 */
export class PresenceDO extends DurableObject<Env> {
  private sql: SqlStorage;

  /** 离线名册缓存（避免每次轮询都穿透到 RegistryDO / AdminDO） */
  private usersCache: { at: number; users: Profile[]; banned: Set<string> } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS presence (
          uid           TEXT PRIMARY KEY,
          nickname      TEXT NOT NULL,
          role          TEXT NOT NULL,
          avatar_id     TEXT,
          avatar_url    TEXT,
          room_id       TEXT,
          room_name     TEXT,
          status        TEXT NOT NULL DEFAULT 'online',
          invitable     INTEGER NOT NULL DEFAULT 1,
          connected_at  INTEGER NOT NULL,
          last_seen     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence(last_seen);
      `);

      // 旧库迁移：补列（已存在时报错忽略）
      try {
        this.sql.exec(`ALTER TABLE presence ADD COLUMN status TEXT NOT NULL DEFAULT 'online'`);
      } catch {
        /* 列已存在 */
      }
      try {
        this.sql.exec(`ALTER TABLE presence ADD COLUMN invitable INTEGER NOT NULL DEFAULT 1`);
      } catch {
        /* 列已存在 */
      }

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS invites (
          id            TEXT PRIMARY KEY,
          to_uid        TEXT NOT NULL,
          from_uid      TEXT NOT NULL,
          from_nickname TEXT NOT NULL,
          room_id       TEXT NOT NULL,
          room_name     TEXT NOT NULL,
          created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_invites_to ON invites(to_uid);
      `);
    });
  }

  // ==========================================================
  //  在线名册
  // ==========================================================

  /** 心跳：登记/刷新在线状态（含当前所在房间、展示状态、可邀请性） */
  async heartbeat(input: {
    uid: string;
    nickname: string;
    role: Role;
    avatarId: string | null;
    avatarUrl: string | null;
    roomId: string | null;
    roomName: string | null;
    status?: 'online' | 'busy' | 'away' | 'invisible';
    invitable?: boolean;
  }): Promise<void> {
    const now = Date.now();
    this.reapStale(now);

    const status = input.status ?? 'online';
    const invitable = input.invitable === false ? 0 : 1;

    this.sql.exec(
      `INSERT INTO presence
         (uid, nickname, role, avatar_id, avatar_url, room_id, room_name, status, invitable, connected_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         nickname = excluded.nickname,
         role = excluded.role,
         avatar_id = excluded.avatar_id,
         avatar_url = excluded.avatar_url,
         room_id = excluded.room_id,
         room_name = excluded.room_name,
         status = excluded.status,
         invitable = excluded.invitable,
         last_seen = excluded.last_seen`,
      input.uid,
      input.nickname,
      input.role,
      input.avatarId,
      input.avatarUrl,
      input.roomId,
      input.roomName,
      status,
      invitable,
      now,
      now,
    );
  }

  /**
   * 资料变更：原地刷新在线名册里的展示信息，并回报该用户当前所在房间。
   * 一次往返完成两件事，避免调用方连开两次 RPC。
   */
  async refreshProfile(input: {
    uid: string;
    nickname: string;
    avatarId: string | null;
    avatarUrl: string | null;
  }): Promise<{ roomId: string | null }> {
    const rows = this.sql
      .exec<{ room_id: string | null }>('SELECT room_id FROM presence WHERE uid = ?', input.uid)
      .toArray();

    this.sql.exec(
      'UPDATE presence SET nickname = ?, avatar_id = ?, avatar_url = ? WHERE uid = ?',
      input.nickname,
      input.avatarId,
      input.avatarUrl,
      input.uid,
    );

    // 展示信息变了，离线名册缓存也一并失效
    this.usersCache = null;
    return { roomId: rows[0]?.room_id ?? null };
  }

  /** 主动下线（登出 / 踢出）。同时让名册缓存失效，保证下次轮询重新计算 */
  async drop(uid: string): Promise<void> {
    this.sql.exec('DELETE FROM presence WHERE uid = ?', uid);
    this.usersCache = null;
  }

  /** 惰性清理超时成员 */
  private reapStale(now = Date.now()): number {
    const cutoff = now - OFFLINE_THRESHOLD_MS;
    const rows = this.sql
      .exec<{ c: number }>('SELECT COUNT(*) AS c FROM presence WHERE last_seen < ?', cutoff)
      .toArray();
    const count = Number(rows[0]?.c ?? 0);
    if (count > 0) {
      this.sql.exec('DELETE FROM presence WHERE last_seen < ?', cutoff);
    }
    // 顺带清理过期邀请
    this.sql.exec('DELETE FROM invites WHERE created_at < ?', now - INVITE_TTL_MS);
    return count;
  }

  /** 在线成员列表 */
  async listOnline(): Promise<PresenceUser[]> {
    const now = Date.now();
    this.reapStale(now);
    const cutoff = now - OFFLINE_THRESHOLD_MS;

    const rows = this.sql
      .exec<{
        uid: string;
        nickname: string;
        role: string;
        avatar_id: string | null;
        avatar_url: string | null;
        room_id: string | null;
        room_name: string | null;
        status: string;
        invitable: number;
        last_seen: number;
      }>(
        `SELECT uid, nickname, role, avatar_id, avatar_url, room_id, room_name, status, invitable, last_seen
         FROM presence WHERE last_seen >= ? ORDER BY connected_at ASC`,
        cutoff,
      )
      .toArray();

    return rows.map((r) => ({
      uid: r.uid,
      nickname: r.nickname,
      role: r.role === 'admin' ? 'admin' : 'guest',
      avatarId: r.avatar_id,
      avatarUrl: r.avatar_url,
      online: true,
      status: (['online', 'busy', 'away', 'invisible'] as const).includes(
        r.status as 'online' | 'busy' | 'away' | 'invisible',
      )
        ? (r.status as 'online' | 'busy' | 'away' | 'invisible')
        : 'online',
      invitable: r.invitable !== 0,
      roomId: r.room_id,
      roomName: r.room_name,
      lastSeen: r.last_seen,
    }));
  }

  /** 某个用户当前的房间（踢人时用来定位） */
  async getRoomOf(uid: string): Promise<string | null> {
    const rows = this.sql
      .exec<{ room_id: string | null }>('SELECT room_id FROM presence WHERE uid = ?', uid)
      .toArray();
    return rows[0]?.room_id ?? null;
  }

  /**
   * 已注册但当前未连接的用户。
   * 从 RegistryDO 取全量注册用户，减去在线名册，再减去已被踢出（封禁）的人——
   * 被踢出的人已经不属于这台服务器，不该继续出现在成员名册里。
   * 带 30s 内存缓存，避免轮询打穿 RegistryDO / AdminDO。
   */
  async listOffline(): Promise<PresenceUser[]> {
    const now = Date.now();
    const onlineUids = new Set((await this.listOnline()).map((u) => u.uid));

    if (!this.usersCache || now - this.usersCache.at > 30_000) {
      const registry = this.env.REGISTRY_DO.get(this.env.REGISTRY_DO.idFromName('global'));
      const admin = this.env.ADMIN_DO.get(this.env.ADMIN_DO.idFromName('global'));
      const [users, bans] = await Promise.all([registry.listUsers(500), admin.listBans()]);

      const banned = new Set(
        bans
          .filter((b) => b.kind === 'nickname' && (b.expiresAt === null || b.expiresAt > now))
          .map((b) => b.value.toLowerCase()),
      );
      this.usersCache = { at: now, users, banned };
    }

    const cache = this.usersCache;
    return cache.users
      .filter((u) => !onlineUids.has(u.uid) && !cache.banned.has(u.nickname.toLowerCase()))
      .map((u) => ({
        uid: u.uid,
        nickname: u.nickname,
        role: u.role,
        avatarId: u.avatarId,
        avatarUrl: u.avatarUrl,
        online: false,
        status: 'offline' as const,
        invitable: false,
        roomId: null,
        roomName: null,
        lastSeen: 0,
      }));
  }

  // ==========================================================
  //  邀请信箱
  // ==========================================================

  /** 投递一条邀请（同一人 + 同一房间的旧邀请会被覆盖） */
  async sendInvite(input: {
    toUid: string;
    fromUid: string;
    fromNickname: string;
    roomId: string;
    roomName: string;
  }): Promise<void> {
    this.sql.exec(
      'DELETE FROM invites WHERE to_uid = ? AND from_uid = ? AND room_id = ?',
      input.toUid,
      input.fromUid,
      input.roomId,
    );
    this.sql.exec(
      `INSERT INTO invites (id, to_uid, from_uid, from_nickname, room_id, room_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      input.toUid,
      input.fromUid,
      input.fromNickname,
      input.roomId,
      input.roomName,
      Date.now(),
    );
  }

  /** 取走并清空某个用户的待处理邀请 */
  async drainInvites(uid: string): Promise<PresenceInvite[]> {
    const rows = this.sql
      .exec<{
        id: string;
        from_uid: string;
        from_nickname: string;
        room_id: string;
        room_name: string;
        created_at: number;
      }>(
        `SELECT id, from_uid, from_nickname, room_id, room_name, created_at
         FROM invites WHERE to_uid = ? ORDER BY created_at ASC`,
        uid,
      )
      .toArray();

    if (rows.length === 0) return [];
    this.sql.exec('DELETE FROM invites WHERE to_uid = ?', uid);

    return rows.map((r) => ({
      id: r.id,
      fromUid: r.from_uid,
      fromNickname: r.from_nickname,
      roomId: r.room_id,
      roomName: r.room_name,
      createdAt: r.created_at,
    }));
  }

  /** 一次性返回服务器成员快照（在线 + 离线 + 新邀请） */
  async getSnapshot(input: { uid: string; isAdmin: boolean }): Promise<{
    online: PresenceUser[];
    offline: PresenceUser[];
    invites: PresenceInvite[];
    serverTime: number;
  }> {
    const online = await this.listOnline();
    const offline = input.isAdmin ? await this.listOffline() : [];
    const invites = await this.drainInvites(input.uid);

    return { online, offline, invites, serverTime: Date.now() };
  }
}
