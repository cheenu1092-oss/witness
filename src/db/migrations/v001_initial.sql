-- ============================================================
-- Ved Database Schema v001 — Initial
-- File: src/db/migrations/v001_initial.sql
-- ============================================================

-- Note: Pragmas are set on connection, not in migration SQL.

-- ============================================================
-- INBOX — Crash-safe message receipt
-- ============================================================
CREATE TABLE IF NOT EXISTS inbox (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  author_name   TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  attachments   TEXT DEFAULT '[]',
  reply_to      TEXT,
  metadata      TEXT DEFAULT '{}',
  received_at   INTEGER NOT NULL,
  processed     INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  session_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_pending ON inbox(processed) WHERE processed = 0;
CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox(received_at);
CREATE INDEX IF NOT EXISTS idx_inbox_session ON inbox(session_id) WHERE session_id IS NOT NULL;

-- ============================================================
-- SESSIONS — Conversation sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  channel         TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  trust_tier      INTEGER NOT NULL DEFAULT 1,
  started_at      INTEGER NOT NULL,
  last_active     INTEGER NOT NULL,
  working_memory  TEXT DEFAULT '{}',
  token_count     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  closed_at       INTEGER,
  summary         TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_author ON sessions(author_id, channel);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active) WHERE status = 'active';

-- ============================================================
-- AUDIT_LOG — Hash-chained action log (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  timestamp   INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  session_id  TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id) WHERE session_id IS NOT NULL;

-- ============================================================
-- ANCHORS — HMAC integrity checkpoints
-- ============================================================
CREATE TABLE IF NOT EXISTS anchors (
  id              TEXT PRIMARY KEY,
  chain_head_id   TEXT NOT NULL,
  chain_head_hash TEXT NOT NULL,
  chain_length    INTEGER NOT NULL,
  hmac            TEXT NOT NULL,
  algorithm       TEXT NOT NULL DEFAULT 'hmac-sha256',
  timestamp       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_anchors_time ON anchors(timestamp);

-- ============================================================
-- WORK_ORDERS — HITL approval queue
-- ============================================================
CREATE TABLE IF NOT EXISTS work_orders (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  tool_server   TEXT NOT NULL DEFAULT '',
  params        TEXT NOT NULL DEFAULT '{}',
  risk_level    TEXT NOT NULL,
  risk_reasons  TEXT DEFAULT '[]',
  trust_tier    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  result        TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolved_by   TEXT,
  audit_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wo_session ON work_orders(session_id);
CREATE INDEX IF NOT EXISTS idx_wo_expires ON work_orders(expires_at) WHERE status = 'pending';

-- ============================================================
-- TRUST_LEDGER — Identity → trust tier mapping
-- ============================================================
CREATE TABLE IF NOT EXISTS trust_ledger (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  user_name   TEXT NOT NULL DEFAULT '',
  trust_tier  INTEGER NOT NULL,
  granted_by  TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  reason      TEXT DEFAULT '',
  UNIQUE(channel, user_id, revoked_at)
);

CREATE INDEX IF NOT EXISTS idx_trust_active ON trust_ledger(channel, user_id) WHERE revoked_at IS NULL;

-- ============================================================
-- RAG: CHUNKS — Obsidian vault file chunks
-- ============================================================
CREATE TABLE IF NOT EXISTS chunks (
  rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  file_path       TEXT NOT NULL,
  heading         TEXT DEFAULT '',
  heading_level   INTEGER DEFAULT 0,
  content         TEXT NOT NULL,
  frontmatter     TEXT DEFAULT '{}',
  token_count     INTEGER NOT NULL,
  chunk_index     INTEGER NOT NULL DEFAULT 0,
  file_modified_at INTEGER NOT NULL,
  indexed_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_modified ON chunks(file_modified_at);

-- ============================================================
-- RAG: FULL-TEXT SEARCH INDEX (FTS5)
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  file_path,
  heading,
  content=chunks,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- FTS5 sync triggers
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, file_path, heading)
  VALUES (new.rowid, new.content, new.file_path, new.heading);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path, heading)
  VALUES ('delete', old.rowid, old.content, old.file_path, old.heading);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path, heading)
  VALUES ('delete', old.rowid, old.content, old.file_path, old.heading);
  INSERT INTO chunks_fts(rowid, content, file_path, heading)
  VALUES (new.rowid, new.content, new.file_path, new.heading);
END;

-- ============================================================
-- RAG: GRAPH EDGES — Wikilink relationship index
-- ============================================================
CREATE TABLE IF NOT EXISTS graph_edges (
  id          TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  link_text   TEXT NOT NULL,
  context     TEXT DEFAULT '',
  indexed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_file);
CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_file);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_pair ON graph_edges(source_file, target_file, link_text);

-- ============================================================
-- OUTBOX — Outgoing messages (crash-safe send)
-- ============================================================
CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  channel     TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  content     TEXT NOT NULL,
  attachments TEXT DEFAULT '[]',
  reply_to    TEXT,
  metadata    TEXT DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_session ON outbox(session_id);

-- ============================================================
-- LLM_CALLS — LLM request/response log
-- ============================================================
CREATE TABLE IF NOT EXISTS llm_calls (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  audit_id        TEXT,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  system_prompt   TEXT,
  messages        TEXT NOT NULL DEFAULT '[]',
  tools           TEXT DEFAULT '[]',
  response        TEXT NOT NULL DEFAULT '{}',
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL,
  error           TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_session ON llm_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_llm_time ON llm_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_model ON llm_calls(model);

-- ============================================================
-- TOOL_CALLS — MCP tool execution log
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  audit_id        TEXT,
  work_order_id   TEXT,
  server_name     TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  params          TEXT NOT NULL DEFAULT '{}',
  result          TEXT,
  error           TEXT,
  risk_level      TEXT NOT NULL DEFAULT 'low',
  auto_approved   INTEGER NOT NULL DEFAULT 1,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_time ON tool_calls(created_at);

-- ============================================================
-- MCP_SERVERS — Configured MCP server registry
-- ============================================================
CREATE TABLE IF NOT EXISTS mcp_servers (
  name        TEXT PRIMARY KEY,
  transport   TEXT NOT NULL,
  command     TEXT,
  args        TEXT DEFAULT '[]',
  env         TEXT DEFAULT '{}',
  url         TEXT,
  headers     TEXT DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  trust_floor INTEGER NOT NULL DEFAULT 2,
  tool_overrides TEXT DEFAULT '{}',
  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ============================================================
-- CRON_JOBS — Scheduled tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  schedule    TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'cron',
  message     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run    INTEGER,
  next_run    INTEGER,
  run_count   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_next ON cron_jobs(next_run) WHERE enabled = 1;

-- ============================================================
-- SCHEMA VERSION — Migration tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  description TEXT DEFAULT ''
);

INSERT INTO schema_version (version, applied_at, filename, checksum, description)
VALUES (1, strftime('%s','now') * 1000, 'v001_initial.sql', '', 'Initial schema');
