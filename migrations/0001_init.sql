-- ============================================================
--  cf-teamspeed — D1 初始化迁移
--  0001_init.sql
-- ============================================================
--  设计要点：
--    1. 只存「聚合后」的数据，避免触到每日 10 万行写入限制
--    2. 审计流水的 id 在 DO 侧生成（UUID），这里用 INSERT OR REPLACE 保证幂等
--    3. 用量按 (day, metric) 主键累加，每天每指标一行
-- ============================================================

-- 会话 / 事件流水（审计）
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  uid           TEXT,
  nickname      TEXT,
  role          TEXT,                    -- guest | admin
  room_id       TEXT,
  event         TEXT NOT NULL,           -- login_ok | login_fail | join | leave | kick | ban | timeout
  ip_hash       TEXT,
  ip_prefix     TEXT,
  country       TEXT,
  city          TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_created  ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_nickname ON sessions(nickname);
CREATE INDEX IF NOT EXISTS idx_sessions_event    ON sessions(event);

-- 房间记录
CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_uid     TEXT,
  max_members   INTEGER NOT NULL DEFAULT 10,
  peak_members  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER
);

-- 用量日聚合（每类每天一行）
CREATE TABLE IF NOT EXISTS usage_daily (
  day           TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  metric        TEXT NOT NULL,           -- sfu_egress_bytes | publish_count | subscribe_count | ...
  value         REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_daily(day DESC);

-- 封禁名单（D1 侧留档，DO 侧是权威）
CREATE TABLE IF NOT EXISTS bans (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,           -- ip | nickname
  value         TEXT NOT NULL,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bans_lookup ON bans(kind, value);

-- 应用配置（管理员在后台可改的项）
CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 默认配置
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('max_room_members', '10', 0),
  ('e2ee_enabled', 'true', 0),
  ('audio_bitrate_kbps', '32', 0);
