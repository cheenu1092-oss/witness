# Session 59 — Dedup + GC/Plugin Test Coverage

**Date:** 2026-03-06
**Phase:** CYCLE
**Duration:** ~15 min

## What Was Done

### 1. Fixed Code Duplication (Critical Bug Fix)

Session 58 introduced duplicate method definitions across 3 files:

**`src/app.ts`** — `pluginList`, `pluginTools`, `pluginTest`, `pluginAdd`, `pluginRemove`, `gcStatus`, `gcRun` all defined twice (lines ~710 and ~1250). Two different implementations with different return types and property names. The second set used `gc_run` audit event type that wasn't in the `AuditEventType` union, and used inline types instead of proper named interfaces.

**`src/cli.ts`** — `plugin()` and `gc()` functions each defined twice (lines ~1519 and ~1932). The first CLI `gc` used property names (`staleAuditEntries`, `dbSizeBytes`) from the second app.ts set. The second CLI `gc` correctly used property names from the first app.ts set (`oldAuditEntries`, `auditWarning`).

**`src/mcp/client.ts`** — `addServer()` and `removeServer()` defined twice (lines ~247 and ~305). Second set used invalid `MCP_DUPLICATE_SERVER` error code.

**Resolution:** Kept the first (properly typed) set in `app.ts`, the second (correctly wired) set in `cli.ts`, and the first set in `mcp/client.ts`. Removed all duplicates. Also removed duplicate `case` statements in CLI `main()`.

**Impact:** 14 `TS2393` errors + 4 property mismatch errors eliminated. Previous session claimed "0 type errors" but there were 28.

### 2. Test Coverage for GC + Plugin

Created `src/tests/session-59-dedup-gc-plugin.test.ts` — **24 tests** across 7 describe blocks:

**gcStatus (5 tests):**
- Zero counts on fresh database
- Detects stale sessions by `last_active` timestamp
- Ignores recent sessions
- Detects old audit entries with warning message
- Custom day thresholds (30d vs 7d)

**gcRun (6 tests):**
- Closes stale sessions (UPDATE status → 'closed')
- Does not delete audit entries without `auditForce`
- Deletes audit entries with `auditForce`
- VACUUM always runs
- Logs `gc_sessions_cleaned` + `gc_vacuum` audit events
- Handles empty database gracefully

**pluginList (2 tests):**
- Empty array with no servers
- Returns server info after adding

**pluginTools (2 tests):**
- Empty array with no tools
- Filters by server name

**pluginAdd + pluginRemove (3 tests):**
- Add and remove lifecycle
- Returns false for nonexistent
- Rejects duplicate server names

**pluginTest (1 test):**
- Returns error for nonexistent server

**Dedup verification (5 tests):**
- VedApp has exactly one pluginList, gcStatus, gcRun method
- GcStatus returns typed result with `staleSessionIds`
- GcResult returns typed result with `sessionsClosed` + `durationMs`

### Lines Removed
- `src/app.ts`: ~206 lines removed (1250-1454)
- `src/cli.ts`: ~390 lines removed (1503-1892)
- `src/mcp/client.ts`: ~50 lines removed (299-348)
- **Total: ~646 lines of dead code removed**

## Test Results

- **Host:** 1171 pass, 2 fail (pre-existing cron timezone), 0 type errors
- **Docker:** 1173/1173 pass, 0 type errors
- **New tests:** 24
- **Docker build:** clean
