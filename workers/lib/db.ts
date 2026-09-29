import type { Env } from '../env';

/** 把 AdminDO 的审计缓冲批量搬进 D1 */
export async function flushAuditToD1(env: Env, limit = 500): Promise<number> {
  const stub = env.ADMIN_DO.get(env.ADMIN_DO.idFromName('global'));
  const rows = await stub.drainAudit(limit);
  if (rows.length === 0) return 0;

  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, uid, nickname, role, room_id, event, ip_hash, ip_prefix, country, city, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const batch = rows.map((r) =>
    stmt.bind(
      r.id,
      r.uid,
      r.nickname,
      r.role,
      r.roomId,
      r.event,
      r.ipHash,
      r.ipPrefix,
      r.country,
      r.city,
      r.userAgent,
      r.createdAt,
    ),
  );

  await env.DB.batch(batch);
  return rows.length;
}

/** 把 RegistryDO 的用量缓冲批量写进 usage_daily */
export async function flushUsageToD1(env: Env): Promise<Record<string, number>> {
  const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName('global'));
  const drained = await stub.drainUsageBuffer();

  const entries = Object.entries(drained);
  if (entries.length === 0) return {};

  const day = new Date().toISOString().slice(0, 10);
  const stmt = env.DB.prepare(
    `INSERT INTO usage_daily (day, metric, value) VALUES (?, ?, ?)
     ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value`,
  );

  await env.DB.batch(entries.map(([metric, value]) => stmt.bind(day, metric, value)));
  return drained;
}

/** 记录一次房间到 D1（进房时调用，频率低） */
export async function upsertRoomToD1(
  env: Env,
  room: { id: string; name: string; ownerUid: string | null; maxMembers: number; createdAt: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rooms (id, name, owner_uid, max_members, created_at, peak_members)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, max_members = excluded.max_members`,
  )
    .bind(room.id, room.name, room.ownerUid, room.maxMembers, room.createdAt)
    .run();
}

/** 更新房间峰值人数与关闭时间 */
export async function touchRoomPeak(
  env: Env,
  roomId: string,
  memberCount: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE rooms SET peak_members = MAX(peak_members, ?) WHERE id = ?`,
  )
    .bind(memberCount, roomId)
    .run();
}

/** 读取近 N 天的用量聚合 */
export async function readUsageDaily(
  env: Env,
  days: number,
): Promise<Array<{ day: string; metric: string; value: number }>> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT day, metric, value FROM usage_daily WHERE day >= ? ORDER BY day ASC`,
  )
    .bind(since)
    .all<{ day: string; metric: string; value: number }>();
  return results ?? [];
}

/** 查询审计流水（分页 + 筛选） */
export async function queryAudit(
  env: Env,
  opts: {
    nickname?: string;
    event?: string;
    from?: number;
    to?: number;
    page: number;
    pageSize: number;
  },
): Promise<{ rows: unknown[]; total: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (opts.nickname) {
    where.push('nickname LIKE ?');
    binds.push(`%${opts.nickname}%`);
  }
  if (opts.event) {
    where.push('event = ?');
    binds.push(opts.event);
  }
  if (opts.from) {
    where.push('created_at >= ?');
    binds.push(opts.from);
  }
  if (opts.to) {
    where.push('created_at <= ?');
    binds.push(opts.to);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM sessions ${clause}`)
    .bind(...binds)
    .first<{ c: number }>();

  const offset = (opts.page - 1) * opts.pageSize;
  const { results } = await env.DB.prepare(
    `SELECT * FROM sessions ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, opts.pageSize, offset)
    .all();

  return { rows: results ?? [], total: Number(countRow?.c ?? 0) };
}

/** 清理过期审计（保留 N 天） */
export async function pruneAudit(env: Env, retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const res = await env.DB.prepare(`DELETE FROM sessions WHERE created_at < ?`)
    .bind(cutoff)
    .run();
  return res.meta.changes ?? 0;
}
