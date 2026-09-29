import { DurableObject } from 'cloudflare:workers';
import { OFFLINE_THRESHOLD_MS } from '@shared/constants';
import type { RoomEvent, RoomMember, RoomSnapshot, RoomSummary } from '@shared/types';
import type { Env } from '../env';

/** 每个 WebSocket 连接上序列化的成员身份 */
interface ConnState {
  uid: string;
  sessionId: string | null;
}

/**
 * 房间 Durable Object（每房间一个实例）
 *
 * 职责：
 *   1. 成员表与生命周期（加入 / 离开 / 心跳 / 超时回收）
 *   2. WebSocket 广播（Hibernation API，空闲不计时长费）
 *   3. track 发现表（谁发布了哪些 track）
 *   4. 房间密钥管理与轮换
 *
 * 关键约束：
 *   - 禁止 setInterval（会阻止 DO 休眠 → 产生时长费）
 *   - 离线判定改为「惰性」：任何一次请求/消息时顺带清理超时成员
 *   - 使用 serializeAttachment 持久化连接身份，DO 驱逐重建后不丢状态
 */
export class RoomDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS members (
          uid         TEXT PRIMARY KEY,
          nickname    TEXT NOT NULL,
          avatar_id   TEXT,
          avatar_url  TEXT,
          role        TEXT NOT NULL,
          muted       INTEGER NOT NULL DEFAULT 0,
          joined_at   INTEGER NOT NULL,
          last_seen   INTEGER NOT NULL
        );
      `);

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
          track_name  TEXT PRIMARY KEY,
          uid         TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          mid         TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tracks_uid ON tracks(uid);
      `);

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });

    // WebSocket 自动响应 ping/pong（Hibernation 兼容）
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  // ==========================================================
  //  元信息
  // ==========================================================

  private getMeta(key: string): string | null {
    const rows = this.sql
      .exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  /**
   * 初始化房间（首次创建时由 Worker 调用）。
   *
   * ⚠️ 只在【首次创建】时写入元信息。已存在的房间一律不动 —— 因为
   * `/join` 路径传进来的 name 是占位符 `房间 ${id}`，如果在这里覆盖，
   * 用户自己起的房间名会在**每次进房时被冲掉**（表现为房间名莫名其妙
   * 变成「房间 + 随机 id」）。
   *
   * 改名 / 调上限走 `update()`，语义明确、只写指定字段。
   */
  async init(input: { id: string; name: string; ownerUid: string | null; maxMembers: number }): Promise<void> {
    if (this.getMeta('id')) return; // 已存在：保持现有名字 / 房主 / 上限

    this.setMeta('id', input.id);
    this.setMeta('name', input.name);
    this.setMeta('owner_uid', input.ownerUid ?? '');
    this.setMeta('max_members', String(input.maxMembers));
    this.setMeta('created_at', String(Date.now()));
    this.setMeta('version', '0');
    this.setMeta('key_id', crypto.randomUUID());
  }

  /**
   * 局部更新房间元信息（改名 / 调人数上限）。
   * 只写传入的字段，避免像 init() 那样顺手覆盖 owner / 上限。
   */
  async update(input: {
    name?: string;
    maxMembers?: number;
  }): Promise<{ ok: boolean; code?: 'ROOM_NOT_FOUND'; summary: RoomSummary }> {
    if (!this.getMeta('id')) {
      return { ok: false, code: 'ROOM_NOT_FOUND', summary: await this.getSummary() };
    }

    if (input.name !== undefined) this.setMeta('name', input.name);
    if (input.maxMembers !== undefined) this.setMeta('max_members', String(input.maxMembers));

    const version = this.bumpVersion();
    this.broadcast({ type: 'room-changed', version });

    return { ok: true, summary: await this.getSummary() };
  }

  private bumpVersion(): number {
    const v = Number(this.getMeta('version') ?? '0') + 1;
    this.setMeta('version', String(v));
    return v;
  }

  async getSummary(): Promise<RoomSummary> {
    const memberCount = this.countMembers();
    return {
      id: this.getMeta('id') ?? '',
      name: this.getMeta('name') ?? '未命名房间',
      ownerUid: this.getMeta('owner_uid') || null,
      memberCount,
      maxMembers: Number(this.getMeta('max_members') ?? '10'),
      createdAt: Number(this.getMeta('created_at') ?? '0'),
    };
  }

  private countMembers(): number {
    const row = this.sql
      .exec<{ c: number }>('SELECT COUNT(*) AS c FROM members')
      .toArray()[0];
    return Number(row?.c ?? 0);
  }

  // ==========================================================
  //  成员管理
  // ==========================================================

  /** 加入房间。返回是否成功（满员则失败） */
  async join(input: {
    uid: string;
    nickname: string;
    avatarId: string | null;
    avatarUrl: string | null;
    role: 'guest' | 'admin';
  }): Promise<{ ok: boolean; code?: 'ROOM_FULL'; version: number }> {
    this.reapOffline();

    const existing = this.sql
      .exec<{ uid: string }>('SELECT uid FROM members WHERE uid = ?', input.uid)
      .toArray();

    const now = Date.now();

    if (existing.length === 0) {
      const max = Number(this.getMeta('max_members') ?? '10');
      if (this.countMembers() >= max) {
        return { ok: false, code: 'ROOM_FULL', version: Number(this.getMeta('version') ?? '0') };
      }
      this.sql.exec(
        `INSERT INTO members (uid, nickname, avatar_id, avatar_url, role, muted, joined_at, last_seen)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        input.uid,
        input.nickname,
        input.avatarId,
        input.avatarUrl,
        input.role,
        now,
        now,
      );
    } else {
      // 重连：刷新资料与时间戳
      this.sql.exec(
        `UPDATE members SET nickname = ?, avatar_id = ?, avatar_url = ?, role = ?, last_seen = ?
         WHERE uid = ?`,
        input.nickname,
        input.avatarId,
        input.avatarUrl,
        input.role,
        now,
        input.uid,
      );
    }

    const version = this.bumpVersion();
    this.broadcast({ type: 'room-changed', version });
    return { ok: true, version };
  }

  /** 主动离开 */
  async leave(uid: string): Promise<{ version: number }> {
    this.sql.exec('DELETE FROM tracks WHERE uid = ?', uid);
    this.sql.exec('DELETE FROM members WHERE uid = ?', uid);
    const version = this.bumpVersion();
    this.broadcast({ type: 'member-left', uid });
    this.broadcast({ type: 'room-changed', version });
    return { version };
  }

  /** 心跳 */
  async heartbeat(uid: string): Promise<{ version: number; reaped: number }> {
    const now = Date.now();
    this.sql.exec('UPDATE members SET last_seen = ? WHERE uid = ?', now, uid);
    const reaped = this.reapOffline();
    return { version: Number(this.getMeta('version') ?? '0'), reaped };
  }

  /** 更新麦克风状态 */
  async setMuted(uid: string, muted: boolean): Promise<void> {
    this.sql.exec('UPDATE members SET muted = ? WHERE uid = ?', muted ? 1 : 0, uid);
    const version = this.bumpVersion();
    this.broadcast({ type: 'room-changed', version });
  }

  /**
   * 资料变更（改昵称 / 换头像）——原地更新成员行。
   *
   * 身份主键是 uid，昵称与头像只是元数据。所以改名不应该等价于「退出再进入」：
   * 这里只更新展示字段并广播一次 room-changed，成员关系、track、心跳都不受影响。
   */
  async updateMemberProfile(input: {
    uid: string;
    nickname: string;
    avatarId: string | null;
    avatarUrl: string | null;
  }): Promise<{ updated: boolean }> {
    const exists = this.sql
      .exec<{ uid: string }>('SELECT uid FROM members WHERE uid = ?', input.uid)
      .toArray();
    if (exists.length === 0) return { updated: false };

    this.sql.exec(
      'UPDATE members SET nickname = ?, avatar_id = ?, avatar_url = ? WHERE uid = ?',
      input.nickname,
      input.avatarId,
      input.avatarUrl,
      input.uid,
    );

    const version = this.bumpVersion();
    this.broadcast({ type: 'room-changed', version });
    return { updated: true };
  }

  /**
   * 惰性清理超时成员。
   * 没有 setInterval，所以每次交互时顺带扫一遍。
   */
  private reapOffline(): number {
    const cutoff = Date.now() - OFFLINE_THRESHOLD_MS;
    const stale = this.sql
      .exec<{ uid: string }>('SELECT uid FROM members WHERE last_seen < ?', cutoff)
      .toArray();

    if (stale.length === 0) return 0;

    for (const { uid } of stale) {
      this.sql.exec('DELETE FROM tracks WHERE uid = ?', uid);
      this.sql.exec('DELETE FROM members WHERE uid = ?', uid);
      this.broadcast({ type: 'member-left', uid });
    }

    const version = this.bumpVersion();
    this.broadcast({ type: 'room-changed', version });
    return stale.length;
  }

  /** 管理员踢人 */
  async kick(uid: string, reason: string): Promise<{ ok: boolean }> {
    const exists = this.sql
      .exec<{ uid: string }>('SELECT uid FROM members WHERE uid = ?', uid)
      .toArray();
    if (exists.length === 0) return { ok: false };

    // 先通知该成员（在他自己的 socket 上）
    this.notifyUid(uid, { type: 'kicked', reason });

    this.sql.exec('DELETE FROM tracks WHERE uid = ?', uid);
    this.sql.exec('DELETE FROM members WHERE uid = ?', uid);
    const version = this.bumpVersion();
    this.broadcast({ type: 'room-changed', version });
    return { ok: true };
  }

  /** 关闭整个房间 */
  async close(reason: string): Promise<void> {
    this.broadcast({ type: 'room-closed', reason } as RoomEvent);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'room closed');
      } catch {
        /* ignore */
      }
    }
    this.sql.exec('DELETE FROM tracks');
    this.sql.exec('DELETE FROM members');
    this.setMeta('closed', '1');
    this.bumpVersion();
  }

  /**
   * 彻底删除房间：广播 room-closed、断开所有连接、清空成员/轨道/元信息。
   * 与 close() 的区别：close() 只清人（房间还在，可再次加入）；
   * destroy() 连元信息一起删掉，之后 getSummary().id 为空 —— 即「房间不存在」。
   */
  async destroy(reason: string): Promise<{ destroyed: boolean; disconnected: number }> {
    this.broadcast({ type: 'room-closed', reason } as RoomEvent);

    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.close(1000, 'room deleted');
      } catch {
        /* ignore */
      }
    }

    this.sql.exec('DELETE FROM tracks');
    this.sql.exec('DELETE FROM members');
    this.sql.exec('DELETE FROM meta');

    return { destroyed: true, disconnected: sockets.length };
  }

  /** 轮换房间密钥 */
  async rotateKey(): Promise<{ keyId: string }> {
    const keyId = crypto.randomUUID();
    this.setMeta('key_id', keyId);
    this.broadcast({ type: 'key-rotated', keyId });
    return { keyId };
  }

  /** 房间密钥 id（客户端用它派生 E2EE 密钥，真实密钥材料由 Worker 下发） */
  async getKeyId(): Promise<string> {
    return this.getMeta('key_id') ?? '';
  }

  // ==========================================================
  //  Track 发现表
  // ==========================================================

  async registerTrack(input: {
    trackName: string;
    uid: string;
    sessionId: string;
    mid?: string | null;
  }): Promise<void> {
    this.sql.exec(
      `INSERT INTO tracks (track_name, uid, session_id, mid, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(track_name) DO UPDATE SET
         uid = excluded.uid,
         session_id = excluded.session_id,
         mid = excluded.mid`,
      input.trackName,
      input.uid,
      input.sessionId,
      input.mid ?? null,
      Date.now(),
    );

    // 必须广播：订阅方是「先查轨道表、再决定订阅」的。
    // 若只靠成员进出事件唤醒，先加入的人会在对方还没发布完时查一次空表，
    // 之后再无通知 —— 于是永远订阅不上后加入的人（表现为听不到对方）。
    const version = this.bumpVersion();
    this.broadcast({ type: 'room-changed', version });
  }

  async unregisterTrack(trackName: string): Promise<void> {
    this.sql.exec('DELETE FROM tracks WHERE track_name = ?', trackName);
    const version = this.bumpVersion();
    this.broadcast({ type: 'room-changed', version });
  }

  /** 按 trackName 查 mid（关闭轨道时必须用 mid） */
  async getTrackMid(trackName: string): Promise<string | null> {
    const rows = this.sql
      .exec<{ mid: string | null }>('SELECT mid FROM tracks WHERE track_name = ?', trackName)
      .toArray();
    return rows[0]?.mid ?? null;
  }

  async listTracks(): Promise<
    Array<{ trackName: string; uid: string; sessionId: string; mid: string | null }>
  > {
    const rows = this.sql
      .exec<{ track_name: string; uid: string; session_id: string; mid: string | null }>(
        'SELECT track_name, uid, session_id, mid FROM tracks',
      )
      .toArray();
    return rows.map((r) => ({
      trackName: r.track_name,
      uid: r.uid,
      sessionId: r.session_id,
      mid: r.mid,
    }));
  }

  /** 校验某个 track 是否属于某个用户（防越权） */
  async ownsTrack(uid: string, trackName: string): Promise<boolean> {
    const rows = this.sql
      .exec<{ uid: string }>(
        'SELECT uid FROM tracks WHERE track_name = ? AND uid = ?',
        trackName,
        uid,
      )
      .toArray();
    return rows.length > 0;
  }

  // ==========================================================
  //  快照
  // ==========================================================

  async getSnapshot(): Promise<RoomSnapshot> {
    this.reapOffline();
    const rows = this.sql
      .exec<{
        uid: string;
        nickname: string;
        avatar_id: string | null;
        avatar_url: string | null;
        role: string;
        muted: number;
        joined_at: number;
        last_seen: number;
      }>(
        `SELECT uid, nickname, avatar_id, avatar_url, role, muted, joined_at, last_seen
         FROM members ORDER BY joined_at ASC`,
      )
      .toArray();

    const members: RoomMember[] = rows.map((r) => ({
      uid: r.uid,
      nickname: r.nickname,
      avatarId: r.avatar_id,
      avatarUrl: r.avatar_url,
      role: r.role === 'admin' ? 'admin' : 'guest',
      muted: r.muted === 1,
      joinedAt: r.joined_at,
      lastSeen: r.last_seen,
    }));

    return {
      room: await this.getSummary(),
      members,
      version: Number(this.getMeta('version') ?? '0'),
    };
  }

  // ==========================================================
  //  WebSocket（Hibernation API）
  // ==========================================================

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const uid = url.searchParams.get('uid') ?? '';
      const sessionId = url.searchParams.get('sid');

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // Hibernation API：把身份序列化挂在连接上
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ uid, sessionId } satisfies ConnState);

      const version = Number(this.getMeta('version') ?? '0');
      server.send(JSON.stringify({ type: 'room-changed', version }));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/snapshot')) {
      return Response.json(await this.getSnapshot());
    }

    return new Response('Not found', { status: 404 });
  }

  /** 收到客户端消息 */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let parsed: { type?: string; muted?: boolean };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    const att = ws.deserializeAttachment() as ConnState | null;
    if (!att?.uid) return;

    this.sql.exec('UPDATE members SET last_seen = ? WHERE uid = ?', Date.now(), att.uid);

    if (parsed.type === 'mute') {
      this.sql.exec(
        'UPDATE members SET muted = ? WHERE uid = ?',
        parsed.muted ? 1 : 0,
        att.uid,
      );
      const version = this.bumpVersion();
      this.broadcast({ type: 'room-changed', version });
    } else if (parsed.type === 'heartbeat') {
      this.reapOffline();
    }
  }

  /** 连接关闭 —— 不立即移除成员，交给心跳超时兜底（容忍短暂断网） */
  override async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as ConnState | null;
    if (!att?.uid) return;
    // 立即标记为「可能离线」：把 last_seen 提前，加速回收
    const stale = Date.now() - OFFLINE_THRESHOLD_MS + 5_000;
    this.sql.exec('UPDATE members SET last_seen = ? WHERE uid = ?', stale, att.uid);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as ConnState | null;
    if (!att?.uid) return;
    const stale = Date.now() - OFFLINE_THRESHOLD_MS + 5_000;
    this.sql.exec('UPDATE members SET last_seen = ? WHERE uid = ?', stale, att.uid);
  }

  /** 向所有连接广播 */
  private broadcast(event: RoomEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* 连接已断，忽略 */
      }
    }
  }

  /** 只通知某个 uid 的所有连接 */
  private notifyUid(uid: string, event: RoomEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as ConnState | null;
      if (att?.uid === uid) {
        try {
          ws.send(payload);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
