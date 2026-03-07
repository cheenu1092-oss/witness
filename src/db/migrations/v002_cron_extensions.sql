-- ============================================================
-- Ved Database Schema v002 — Cron job extensions
-- File: src/db/migrations/v002_cron_extensions.sql
-- ============================================================

-- Add result tracking columns to cron_jobs
ALTER TABLE cron_jobs ADD COLUMN last_result TEXT;     -- 'success' | 'error' | null
ALTER TABLE cron_jobs ADD COLUMN last_error TEXT;      -- error message on failure

-- ============================================================
-- CRON_HISTORY — Execution history for cron jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_history (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  job_name    TEXT NOT NULL,
  job_type    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  success     INTEGER NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  error       TEXT,
  audit_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_hist_job ON cron_history(job_id);
CREATE INDEX IF NOT EXISTS idx_cron_hist_time ON cron_history(started_at);
CREATE INDEX IF NOT EXISTS idx_cron_hist_name ON cron_history(job_name);
