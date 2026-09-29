import { DurableObject } from 'cloudflare:workers';
import { normalizeNickname } from '../lib/crypto';
import { RESERVED_NICKNAMES, USAGE_FLUSH_INTERVAL_MINUTES } from '@shared/constants';
import type { Profile, Role, RoomSummary } from '@shared/types';
import type { Env } from '../env';

/**
 * 全局注册表 Durable Object（单实例）
 *
 * 职责：
 *   1. 昵称全局唯一注册（规范化后主键）
 *   2. 用户资料持久化（昵称 / 头像）
 *   3. 房间目录（各 RoomDO 上报）
 *   4. 用量内存累加 + 定时 flush 到 D1（避开 D1 每日 10 万行写入限制）
 *
 * 注意：本 DO 不使用 setInterval（会阻止休眠）。用量 flush 采用
 * 「每次请求顺带判断时间窗」的惰性策略 + D1 侧的兜底。
 */
export class RegistryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  /** 内存累加器：本次 DO 生命周期内的增量（避免频繁写 D1） */
  private usageBuffer: Record<string, number> = {};
  private lastFlushAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS nicknames (
          norm_key    TEXT PRIMARY KEY,
          nickname    TEXT NOT NULL,
          uid         TEXT NOT NULL UNIQUE,
          avatar_id   TEXT,
          avatar_url  TEXT,
          role        TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nicknames_uid ON nicknames(uid);
      `);

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          owner_uid   TEXT,
          member_count INTEGER NOT NULL DEFAULT 0,
          max_members INTEGER NOT NULL DEFAULT 10,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
      `);

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS usage_buffer (
          metric      TEXT PRIMARY KEY,
          value       REAL NOT NULL DEFAULT 0
        );
      `);

      this.lastFlushAt = Date.now();
    });
  }

  // ==========================================================
  //  昵称注册
  // ==========================================================

  /**
   * 注册昵称。成功返回 { ok: true, uid }；
   * 失败返回 { ok: false, code }。
   */
  async registerNickname(input: {
    nickname: string;
    role: Role;
    avatarId?: string | null;
  }): Promise<
    | { ok: true; uid: string; profile: Profile }
    | { ok: false; code: 'NICKNAME_TAKEN' | 'NICKNAME_RESERVED' | 'NICKNAME_INVALID' }
  > {
    const nickname = input.nickname.trim();
    const norm = normalizeNickname(nickname);

    if (norm.length < 2 || norm.length > 16) {
      return { ok: false, code: 'NICKNAME_INVALID' };
    }
    if (RESERVED_NICKNAMES.has(norm)) {
      return { ok: false, code: 'NICKNAME_RESERVED' };
    }

    const existing = this.sql
      .exec<{ uid: string }>('SELECT uid FROM nicknames WHERE norm_key = ?', norm)
      .toArray();

    if (existing.length > 0) {
      return { ok: false, code: 'NICKNAME_TAKEN' };
    }

    const uid = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO nicknames (norm_key, nickname, uid, avatar_id, avatar_url, role, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      norm,
      nickname,
      uid,
      input.avatarId ?? null,
      input.role,
      now,
    );

    return {
      ok: true,
      uid,
      profile: {
        uid,
        nickname,
        role: input.role,
        avatarId: input.avatarId ?? null,
        avatarUrl: null,
      },
    };
  }

  /** 按规划化键查资料（用于「同名同头像」与重登） */
  async lookupByNickname(nickname: string): Promise<Profile | null> {
    const norm = normalizeNickname(nickname);
    const rows = this.sql
      .exec<{
        uid: string;
        nickname: string;
        avatar_id: string | null;
        avatar_url: string | null;
        role: string;
      }>(
        'SELECT uid, nickname, avatar_id, avatar_url, role FROM nicknames WHERE norm_key = ?',
        norm,
      )
      .toArray();

    const row = rows[0];
    if (!row) return null;
    return {
      uid: row.uid,
      nickname: row.nickname,
      role: row.role === 'admin' ? 'admin' : 'guest',
      avatarId: row.avatar_id,
      avatarUrl: row.avatar_url,
    };
  }

  /** 按 uid 查资料 */
  async lookupByUid(uid: string): Promise<Profile | null> {
    const rows = this.sql
      .exec<{
        uid: string;
        nickname: string;
        avatar_id: string | null;
        avatar_url: string | null;
        role: string;
      }>(
        'SELECT uid, nickname, avatar_id, avatar_url, role FROM nicknames WHERE uid = ?',
        uid,
      )
      .toArray();

    const row = rows[0];
    if (!row) return null;
    return {
      uid: row.uid,
      nickname: row.nickname,
      role: row.role === 'admin' ? 'admin' : 'guest',
      avatarId: row.avatar_id,
      avatarUrl: row.avatar_url,
    };
  }

  /** 更新资料（昵称变更需重新检查唯一性） */
  async updateProfile(input: {
    uid: string;
    nickname?: string;
    avatarId?: string | null;
    avatarUrl?: string | null;
  }): Promise<{ ok: boolean; code?: string; profile?: Profile }> {
    const current = await this.lookupByUid(input.uid);
    if (!current) return { ok: false, code: 'UNAUTHORIZED' };

    let nickname = current.nickname;
    let normKey: string | null = null;

    if (input.nickname !== undefined && input.nickname !== current.nickname) {
      const nn = input.nickname.trim();
      const norm = normalizeNickname(nn);
      if (norm.length < 2 || norm.length > 16) return { ok: false, code: 'NICKNAME_INVALID' };
      if (RESERVED_NICKNAMES.has(norm)) return { ok: false, code: 'NICKNAME_RESERVED' };

      const clash = this.sql
        .exec<{ uid: string }>(
          'SELECT uid FROM nicknames WHERE norm_key = ? AND uid != ?',
          norm,
          input.uid,
        )
        .toArray();
      if (clash.length > 0) return { ok: false, code: 'NICKNAME_TAKEN' };

      nickname = nn;
      normKey = norm;
    }

    const avatarId = input.avatarId === undefined ? current.avatarId : input.avatarId;
    const avatarUrl = input.avatarUrl === undefined ? current.avatarUrl : input.avatarUrl;

    if (normKey) {
      this.sql.exec(
        `UPDATE nicknames SET nickname = ?, norm_key = ?, avatar_id = ?, avatar_url = ?
         WHERE uid = ?`,
        nickname,
        normKey,
        avatarId,
        avatarUrl,
        input.uid,
      );
    } else {
      this.sql.exec(
        `UPDATE nicknames SET avatar_id = ?, avatar_url = ? WHERE uid = ?`,
        avatarId,
        avatarUrl,
        input.uid,
      );
    }

    return {
      ok: true,
      profile: {
        uid: input.uid,
        nickname,
        role: current.role,
        avatarId,
        avatarUrl,
      },
    };
  }

  /** 释放昵称（管理员操作） */
  async releaseNickname(nickname: string): Promise<boolean> {
    const norm = normalizeNickname(nickname);
    const before = this.sql
      .exec<{ uid: string }>('SELECT uid FROM nicknames WHERE norm_key = ?', norm)
      .toArray();
    if (before.length === 0) return false;
    this.sql.exec('DELETE FROM nicknames WHERE norm_key = ?', norm);
    return true;
  }

  /** 列出所有已注册用户（管理员用） */
  async listUsers(limit = 200): Promise<Profile[]> {
    const rows = this.sql
      .exec<{
        uid: string;
        nickname: string;
        avatar_id: string | null;
        avatar_url: string | null;
        role: string;
      }>(
        `SELECT uid, nickname, avatar_id, avatar_url, role FROM nicknames
         ORDER BY created_at DESC LIMIT ?`,
        limit,
      )
      .toArray();
    return rows.map((r) => ({
      uid: r.uid,
      nickname: r.nickname,
      role: r.role === 'admin' ? 'admin' : 'guest',
      avatarId: r.avatar_id,
      avatarUrl: r.avatar_url,
    }));
  }

  // ==========================================================
  //  房间目录
  // ==========================================================

  async upsertRoom(room: RoomSummary): Promise<void> {
    // 防御：房间被删除后 getSummary() 会返回空 id（元信息已清空）。
    // 若不拦住，/leave 之类的收尾请求会把一条 id='' 的幽灵记录写进目录。
    if (!room.id) return;

    this.sql.exec(
      `INSERT INTO rooms (id, name, owner_uid, member_count, max_members, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         member_count = excluded.member_count,
         max_members = excluded.max_members,
         updated_at = excluded.updated_at`,
      room.id,
      room.name,
      room.ownerUid,
      room.memberCount,
      room.maxMembers,
      room.createdAt,
      Date.now(),
    );
  }

  async removeRoom(roomId: string): Promise<void> {
    this.sql.exec('DELETE FROM rooms WHERE id = ?', roomId);
  }

  async listRooms(): Promise<RoomSummary[]> {
    const rows = this.sql
      .exec<{
        id: string;
        name: string;
        owner_uid: string | null;
        member_count: number;
        max_members: number;
        created_at: number;
      }>(
        `SELECT id, name, owner_uid, member_count, max_members, created_at
         FROM rooms WHERE id != '' ORDER BY created_at DESC`,
      )
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerUid: r.owner_uid,
      memberCount: r.member_count,
      maxMembers: r.max_members,
      createdAt: r.created_at,
    }));
  }

  // ==========================================================
  //  用量累加
  // ==========================================================

  /**
   * 累加一个用量指标。只写内存，不写 D1。
   * 由调用方在合适的时机触发 flushUsage()。
   */
  async addUsage(metric: string, delta: number): Promise<void> {
    this.usageBuffer[metric] = (this.usageBuffer[metric] ?? 0) + delta;
  }

  /**
   * 惰性 flush：如果距上次 flush 超过窗口，就把内存增量写入 DO SQLite 缓冲表。
   * 这样即使 DO 被驱逐，数据也在本地持久化，再由 D1 侧的定时任务批量搬运。
   */
  async flushUsageIfDue(): Promise<boolean> {
    const now = Date.now();
    const windowMs = USAGE_FLUSH_INTERVAL_MINUTES * 60_000;
    if (now - this.lastFlushAt < windowMs) return false;

    await this.flushUsage();
    this.lastFlushAt = now;
    return true;
  }

  /** 立即把内存增量落到 DO SQLite 缓冲表 */
  async flushUsage(): Promise<void> {
    const entries = Object.entries(this.usageBuffer);
    if (entries.length === 0) return;

    for (const [metric, value] of entries) {
      this.sql.exec(
        `INSERT INTO usage_buffer (metric, value) VALUES (?, ?)
         ON CONFLICT(metric) DO UPDATE SET value = value + excluded.value`,
        metric,
        value,
      );
    }
    this.usageBuffer = {};
  }

  /** 读取并清空缓冲（供 D1 搬运时调用） */
  async drainUsageBuffer(): Promise<Record<string, number>> {
    await this.flushUsage();
    const rows = this.sql
      .exec<{ metric: string; value: number }>('SELECT metric, value FROM usage_buffer')
      .toArray();
    this.sql.exec('DELETE FROM usage_buffer');
    const out: Record<string, number> = {};
    for (const r of rows) out[r.metric] = r.value;
    return out;
  }

  /** 实时快照（未 flush 的内存增量 + 已缓冲值） */
  async getUsageSnapshot(): Promise<Record<string, number>> {
    const rows = this.sql
      .exec<{ metric: string; value: number }>('SELECT metric, value FROM usage_buffer')
      .toArray();
    const out: Record<string, number> = { ...this.usageBuffer };
    for (const r of rows) out[r.metric] = (out[r.metric] ?? 0) + r.value;
    return out;
  }

  /** 汇总（后台概览用） */
  async getStats(): Promise<{
    roomCount: number;
    totalMembers: number;
    registeredUsers: number;
  }> {
    const rooms = this.sql
      .exec<{ c: number; m: number | null }>(
        'SELECT COUNT(*) AS c, SUM(member_count) AS m FROM rooms',
      )
      .toArray()[0];
    const users = this.sql
      .exec<{ c: number }>('SELECT COUNT(*) AS c FROM nicknames')
      .toArray()[0];

    return {
      roomCount: Number(rooms?.c ?? 0),
      totalMembers: Number(rooms?.m ?? 0),
      registeredUsers: Number(users?.c ?? 0),
    };
  }
}
