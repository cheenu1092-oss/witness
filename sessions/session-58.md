# Session 58 — `ved upgrade` + `ved watch`

**Date:** 2026-03-06
**Phase:** CYCLE
**Duration:** ~20 min

## What Was Built

### 1. `ved upgrade` — Database Migration Management CLI

Full migration lifecycle management with 4 subcommands:

- **`ved upgrade status`** — Shows current schema version, available migrations, pending count, and DB path
- **`ved upgrade run`** — Auto-creates a backup before applying pending migrations. Shows before/after version. Provides recovery instructions on failure.
- **`ved upgrade verify`** — Checks integrity of applied migrations against on-disk SQL files (checksum comparison). Detects tampering.
- **`ved upgrade history`** — Lists all applied migrations with version, filename, applied date, and checksum preview.

**App methods added to VedApp:**
- `getUpgradeStatus()` — Returns current version, available count, pending count, DB path
- `verifyMigrations()` — Delegates to `db/migrate.ts` integrity checker
- `runMigrations()` — Explicit migration trigger
- `getAppliedMigrations()` — Full details from `schema_version` table

### 2. `ved watch` — Standalone Vault Watcher

Watches the Obsidian vault for file changes and triggers automatic RAG re-indexing — without starting the full event loop, channels, or LLM pipeline.

- Initializes modules + indexes vault on startup
- Auto-commits dirty git files before indexing
- Runs filesystem watcher with 10s drain loop for re-indexing
- Blocks until SIGINT/SIGTERM
- Shows vault stats on startup

**App method:** `runWatch()` — Init → auto-commit → index → watch → block

### 3. Shell Completions Updated

All three completion generators (bash/zsh/fish) now include:
- `upgrade` with subcommands: `status`, `run`, `verify`, `history`
- `watch` as a top-level command

CLI now has **17 commands**.

## Tests

**22 new tests:**
- Upgrade status (3): version reporting, available count, pending count
- Upgrade verify (1): integrity check returns clean
- Upgrade history (3): applied migrations data, ordering, checksum validity
- Upgrade run (2): idempotent when no pending, status after run
- Watch mode (3): method exists, channels not auto-started, vault watcher capability
- Completions (6): bash/zsh/fish include upgrade+watch, subcommands present
- Edge cases (4): dbPath, idempotent migrations, idempotent verify, consistent history

## Results

- **0 type errors** (tsc --noEmit clean)
- **1149/1149 tests pass** (Docker parity)
- **2 pre-existing timezone cron test failures** (host only, UTC-dependent)
- Docker image builds clean

## Files Changed

- `src/app.ts` — Added upgrade methods, watch method, completions updates (+115 lines)
- `src/cli.ts` — Added `upgrade()` and `watch()` CLI functions (+195 lines)
- `src/tests/session-58-upgrade-watch.test.ts` — New test file (312 lines)
