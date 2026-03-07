# Session 57 — `ved cron` — Scheduled Job Engine

**Date:** 2026-03-06
**Phase:** CYCLE (cron scheduler)
**Duration:** ~25 min

## What Was Built

### CronScheduler (`src/core/cron.ts`, ~420 lines)

Full scheduled job engine with:

- **Cron expression parser** — Standard 5-field (min hour dom month dow) + aliases (@hourly, @daily, @weekly, @monthly, @yearly)
- **Expression features** — Wildcards, ranges (1-5), steps (*/15, 1-10/3), comma-separated lists (1,3,5), mixed combinations
- **Next-run calculator** — Computes next valid time from a cron expression, up to 1 year ahead
- **SQLite-backed persistence** — Jobs stored in `cron_jobs` table, execution history in `cron_history` table
- **Built-in job types** — `backup`, `reindex`, `doctor`
- **Tick-based execution** — `tick()` method checks for due jobs, called every 30s from VedApp
- **Manual trigger** — `runNow()` executes a job immediately regardless of schedule
- **Enable/disable** — Toggle jobs without removing them
- **Execution history** — Full history with timing, success/failure, error messages
- **Audit integration** — All operations logged: cron_job_created, cron_job_removed, cron_job_enabled, cron_job_disabled, cron_job_executed
- **Clock drift recovery** — `recalculateAll()` fixes next_run on startup after clock changes

### Database Migration (`v002_cron_extensions.sql`)

- Added `last_result` and `last_error` columns to `cron_jobs`
- New `cron_history` table for execution tracking (7 columns, 3 indexes)

### CLI: `ved cron` (7 subcommands)

- **`ved cron list`** — Display all jobs with status, schedule, last/next run, run count
- **`ved cron add <name> "<schedule>" <type>`** — Create a job (types: backup, reindex, doctor)
  - Flags: `--max-backups <n>`, `--backup-dir <dir>`
- **`ved cron remove <name>`** — Delete a job
- **`ved cron enable <name>`** — Re-enable a paused job
- **`ved cron disable <name>`** — Pause a job (clears next_run)
- **`ved cron run <name>`** — Manual trigger with result display
- **`ved cron history [name] [-n <limit>]`** — View execution log

### App Integration

- CronScheduler wired into VedApp with executor for backup/reindex/doctor
- 30-second tick interval (unref'd — doesn't prevent process exit)
- Startup recalculation of all next_run times
- Cron tick + shutdown integrated into start/stop lifecycle
- Shell completions updated (bash/zsh/fish) for all cron subcommands

### Examples

```bash
# Schedule nightly backup at 2 AM
ved cron add nightly-backup "0 2 * * *" backup

# Weekly reindex on Sundays at 3 AM
ved cron add weekly-reindex "0 3 * * 0" reindex

# Daily health check at midnight
ved cron add daily-doctor "@daily" doctor

# Hourly backup with rotation
ved cron add hourly-backup "0 * * * *" backup --max-backups 24

# Check what's scheduled
ved cron list

# Manually trigger a backup
ved cron run nightly-backup

# View execution history
ved cron history nightly-backup -n 10
```

## New Types Added

- `AuditEventType` extended: `cron_job_created`, `cron_job_removed`, `cron_job_enabled`, `cron_job_disabled`, `cron_job_executed`

## Tests

**51 new tests** in `src/cron.test.ts`:

- **parseCronExpression (14):** wildcard, single values, ranges, steps, range+step, comma lists, combined, @hourly/@daily/@weekly/@monthly, invalid field count, out-of-range, invalid range, invalid step
- **nextRunTime (5):** next minute, next hour, daily at midnight, day-of-week filter, impossible expression (null)
- **CronScheduler.add (4):** correct fields, duplicate name, invalid expression, disabled creation
- **CronScheduler.list (2):** empty, sorted by name
- **CronScheduler.get (3):** by name, by id, missing
- **CronScheduler.remove (2):** existing, nonexistent
- **CronScheduler.toggle (3):** disable (clears nextRun), enable (sets nextRun), nonexistent
- **CronScheduler.tick (5):** executes due, skips disabled, no due jobs, failure result, executor exceptions
- **CronScheduler.runNow (3):** manual trigger, nonexistent, no executor
- **CronScheduler.history (4):** records history, filters by name, empty, limit
- **CronScheduler.recalculateAll (1):** updates all enabled jobs
- **Audit integration (4):** creation, removal, execution, enable/disable

## Stats

- **0 type errors** (TypeScript strict)
- **1127/1127 tests pass** (host + Docker parity)
- **CLI: 15 commands** (was 14)
- **New files:** `src/core/cron.ts`, `src/db/migrations/v002_cron_extensions.sql`, `src/cron.test.ts`
- **Modified:** `src/app.ts`, `src/cli.ts`, `src/types/index.ts`
