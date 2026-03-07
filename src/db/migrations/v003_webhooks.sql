-- ============================================================
-- Ved Database Schema v003 — Webhooks
-- File: src/db/migrations/v003_webhooks.sql
-- ============================================================

-- ============================================================
-- WEBHOOKS — Registered webhook endpoints
-- ============================================================
CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  url         TEXT NOT NULL,
  secret      TEXT,                          -- HMAC-SHA256 signing secret (optional)
  event_types TEXT NOT NULL DEFAULT '*',     -- comma-separated event types or '*' for all
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  metadata    TEXT DEFAULT '{}'              -- JSON: custom headers, notes, etc.
);

CREATE INDEX IF NOT EXISTS idx_webhooks_name ON webhooks(name);
CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled);

-- ============================================================
-- WEBHOOK_DELIVERIES — Delivery log (attempts + results)
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            TEXT PRIMARY KEY,
  webhook_id    TEXT NOT NULL,
  event_id      TEXT NOT NULL,               -- audit entry ID that triggered this
  event_type    TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | success | failed | dead
  status_code   INTEGER,                     -- HTTP response status code
  request_body  TEXT NOT NULL,               -- JSON payload sent
  response_body TEXT,                        -- first 4KB of response
  error         TEXT,                        -- error message on failure
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  duration_ms   INTEGER,
  next_retry_at INTEGER                      -- when to retry (null = no retry)
);

CREATE INDEX IF NOT EXISTS idx_wh_del_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_wh_del_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_wh_del_retry ON webhook_deliveries(next_retry_at) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_wh_del_event ON webhook_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_wh_del_time ON webhook_deliveries(started_at);
