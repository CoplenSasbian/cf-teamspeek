import { DurableObject } from 'cloudflare:workers';
import { LOGIN_MAX_FAILURES, LOGIN_LOCK_MINUTES } from '@shared/constants';
import type { Env } from '../env';

/**
 * 管理员侧 Durable Object（单实例）
 *
 * 职责：
 *   1. 封禁名单（IP / 昵称）内存缓存 + 持久化
 *   2. 登录失败计数与 IP 锁定
 *   3. 审计事件写入缓冲（批量落 D1）
 */
export class AdminDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /** 封禁名单内存缓存，避免每次登录都读 SQLite */
  private banCache: { ip: Set<string>; nickname: Set<string> } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS bans (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,
          value       TEXT NOT NULL,
          reason      TEXT,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_bans_lookup ON bans(kind, value);
      `);

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS login_attempts (
          scope       TEXT PRIMARY KEY,
          failures    INTEGER NOT NULL DEFAULT 0,
          locked_until INTEGER,
          last_at     INTEGER NOT NULL
        );
      `);

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_buffer (
          id          TEXT PRIMARY KEY,
          uid         TEXT,
          nickname    TEXT,
          role        TEXT,
          room_id     TEXT,
          event       TEXT NOT NULL,
          ip_hash     TEXT,
          ip_prefix   TEXT,
          country     TEXT,
          city        TEXT,
          user_agent  TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_buffer_created ON audit_buffer(created_at DESC);
      `);
    });
  }

  // ==========================================================
  //  封禁
  // ==========================================================

  private loadBans(): { ip: Set<string>; nickname: Set<string> } {
    if (this.banCache) return this.banCache;

    const ip = new Set<string>();
    const nickname = new Set<string>();
    const now = Date.now();

    const rows = this.sql
      .exec<{ kind: string; value: string; expires_at: number | null }>(
        'SELECT kind, value, expires_at FROM bans',
      )
      .toArray();

    for (const r of rows) {
      if (r.expires_at !== null && r.expires_at < now) continue; // 已过期，跳过
      if (r.kind === 'ip') ip.add(r.value);
      else if (r.kind === 'nickname') nickname.add(r.value.toLowerCase());
    }

    this.banCache = { ip, nickname };
    return this.banCache;
  }

  async isBanned(input: { ipHash?: string | null; nickname?: string | null }): Promise<boolean> {
    const bans = this.loadBans();
    if (input.ipHash && bans.ip.has(input.ipHash)) return true;
    if (input.nickname && bans.nickname.has(input.nickname.toLowerCase())) return true;
    return false;
  }

  async addBan(input: {
    kind: 'ip' | 'nickname';
    value: string;
    reason?: string;
    durationMinutes?: number;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = input.durationMinutes
      ? now + input.durationMinutes * 60_000
      : null;

    this.sql.exec(
      `INSERT INTO bans (id, kind, value, reason, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.value,
      input.reason ?? null,
      now,
      expiresAt,
    );

    this.banCache = null; // 失效缓存
    return { id };
  }

  async removeBan(id: string): Promise<boolean> {
    const before = this.sql
      .exec<{ id: string }>('SELECT id FROM bans WHERE id = ?', id)
      .toArray();
    if (before.length === 0) return false;
    this.sql.exec('DELETE FROM bans WHERE id = ?', id);
    this.banCache = null;
    return true;
  }

  async listBans(): Promise<
    Array<{
      id: string;
      kind: string;
      value: string;
      reason: string | null;
      createdAt: number;
      expiresAt: number | null;
    }>
  > {
    const rows = this.sql
      .exec<{
        id: string;
        kind: string;
        value: string;
        reason: string | null;
        created_at: number;
        expires_at: number | null;
      }>('SELECT id, kind, value, reason, created_at, expires_at FROM bans ORDER BY created_at DESC')
      .toArray();

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      value: r.value,
      reason: r.reason,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  /** 清理过期封禁 */
  async pruneExpired(): Promise<number> {
    const now = Date.now();
    const expired = this.sql
      .exec<{ id: string }>(
        'SELECT id FROM bans WHERE expires_at IS NOT NULL AND expires_at < ?',
        now,
      )
      .toArray();
    if (expired.length > 0) {
      this.sql.exec('DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at < ?', now);
      this.banCache = null;
    }
    return expired.length;
  }

  // ==========================================================
  //  登录失败计数 / 锁定
  // ==========================================================

  async checkLock(scope: string): Promise<{ locked: boolean; retryAfterMs: number }> {
    const rows = this.sql
      .exec<{ failures: number; locked_until: number | null }>(
        'SELECT failures, locked_until FROM login_attempts WHERE scope = ?',
        scope,
      )
      .toArray();

    const row = rows[0];
    if (!row?.locked_until) return { locked: false, retryAfterMs: 0 };

    const now = Date.now();
    if (row.locked_until > now) {
      return { locked: true, retryAfterMs: row.locked_until - now };
    }
    // 锁已过期，清零
    this.sql.exec('DELETE FROM login_attempts WHERE scope = ?', scope);
    return { locked: false, retryAfterMs: 0 };
  }

  async recordFailure(scope: string): Promise<{ failures: number; locked: boolean }> {
    const now = Date.now();
    const rows = this.sql
      .exec<{ failures: number }>('SELECT failures FROM login_attempts WHERE scope = ?', scope)
      .toArray();

    const failures = (rows[0]?.failures ?? 0) + 1;
    const locked = failures >= LOGIN_MAX_FAILURES;
    const lockedUntil = locked ? now + LOGIN_LOCK_MINUTES * 60_000 : null;

    this.sql.exec(
      `INSERT INTO login_attempts (scope, failures, locked_until, last_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         failures = excluded.failures,
         locked_until = excluded.locked_until,
         last_at = excluded.last_at`,
      scope,
      locked ? 0 : failures,
      lockedUntil,
      now,
    );

    return { failures, locked };
  }

  async recordSuccess(scope: string): Promise<void> {
    this.sql.exec('DELETE FROM login_attempts WHERE scope = ?', scope);
  }

  // ==========================================================
  //  审计缓冲
  // ==========================================================

  async pushAudit(entry: {
    uid?: string | null;
    nickname?: string | null;
    role?: string | null;
    roomId?: string | null;
    event: string;
    ipHash?: string | null;
    ipPrefix?: string | null;
    country?: string | null;
    city?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    this.sql.exec(
      `INSERT INTO audit_buffer
         (id, uid, nickname, role, room_id, event, ip_hash, ip_prefix, country, city, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      entry.uid ?? null,
      entry.nickname ?? null,
      entry.role ?? null,
      entry.roomId ?? null,
      entry.event,
      entry.ipHash ?? null,
      entry.ipPrefix ?? null,
      entry.country ?? null,
      entry.city ?? null,
      entry.userAgent ? entry.userAgent.slice(0, 300) : null,
      Date.now(),
    );
  }

  /** 取出并清空审计缓冲（供 D1 批量搬运） */
  async drainAudit(limit = 500): Promise<
    Array<{
      id: string;
      uid: string | null;
      nickname: string | null;
      role: string | null;
      roomId: string | null;
      event: string;
      ipHash: string | null;
      ipPrefix: string | null;
      country: string | null;
      city: string | null;
      userAgent: string | null;
      createdAt: number;
    }>
  > {
    const rows = this.sql
      .exec<{
        id: string;
        uid: string | null;
        nickname: string | null;
        role: string | null;
        room_id: string | null;
        event: string;
        ip_hash: string | null;
        ip_prefix: string | null;
        country: string | null;
        city: string | null;
        user_agent: string | null;
        created_at: number;
      }>(
        `SELECT id, uid, nickname, role, room_id, event, ip_hash, ip_prefix,
                country, city, user_agent, created_at
         FROM audit_buffer ORDER BY created_at ASC LIMIT ?`,
        limit,
      )
      .toArray();

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      this.sql.exec(
        `DELETE FROM audit_buffer WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      );
    }

    return rows.map((r) => ({
      id: r.id,
      uid: r.uid,
      nickname: r.nickname,
      role: r.role,
      roomId: r.room_id,
      event: r.event,
      ipHash: r.ip_hash,
      ipPrefix: r.ip_prefix,
      country: r.country,
      city: r.city,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    }));
  }

  /** 审计缓冲积压条数（后台监控用） */
  async getAuditBacklog(): Promise<number> {
    const row = this.sql
      .exec<{ c: number }>('SELECT COUNT(*) AS c FROM audit_buffer')
      .toArray()[0];
    return Number(row?.c ?? 0);
  }
}
