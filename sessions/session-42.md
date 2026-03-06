# Session 42 — TEST: Docker Parity + Test Infrastructure Fixes

**Date:** 2026-03-06  
**Phase:** TEST  

## What Was Done

### 1. Docker Build + Full Test Suite Verification

- TypeScript compiles cleanly to dist/ (52 modules)
- Docker image builds without errors
- All 729 tests pass on host

### 2. Found & Fixed: Docker-Only Test Failure (sweepExpired timing)

**Problem:** `sweepExpired does not affect approved/denied orders` test failed in Docker but passed on host. The test created a `WorkOrderManager` with a 1ms timeout. On Docker's slower clock, by the time `approve()` ran, the work order had already expired (the VULN-13 fix checks `expires_at > @resolvedAt`). So `approve()` was a no-op, the order stayed `pending`, and `sweepExpired()` swept it.

**Fix:** Changed timeout from 1ms to 5000ms for this test. The test verifies sweep behavior for *resolved* orders, not expiry timing — the 1ms timeout was an accidental footgun, not intentional.

**Result:** 729/729 pass in Docker.

### 3. Found & Fixed: Integration Test Mock Warning

**Problem:** 21 integration test setups used inline memory mocks (`{ vault: { readFile: vi.fn(), git: { flush: vi.fn() } }, init: vi.fn(), shutdown: vi.fn(), healthCheck: vi.fn() } as any`) that lacked `writeCompression`, `appendToDaily`, and `upsertEntity`. When the compressor ran during shutdown, it hit `this.memory.writeCompression is not a function` — caught by try/catch but logged as a warning.

**Fix:** Created `createMockMemory()` factory with all required methods and replaced all 21 inline mocks. Warning eliminated.

### 4. Final Verification

| Environment | Tests | Pass | Fail | Warnings |
|-------------|-------|------|------|----------|
| Host (macOS arm64) | 729 | 729 | 0 | 0 |
| Docker (node:22-slim) | 729 | 729 | 0 | 0 |

## Files Changed

| File | Action | Change |
|------|--------|--------|
| `src/integration.test.ts` | Modified | Added `createMockMemory()`, replaced 21 inline mocks |
| `src/trust/trust.test.ts` | Modified | Fixed `sweepExpired` timing (1ms → 5000ms) |

## Stats

```
Source:  11,447 LoC
Tests:   11,769 LoC
Total:   23,216 LoC
Tests:   729/729 pass (host + Docker parity)
TS:      0 type errors
Docker:  Builds + tests clean
```

## Next Session (43)

- **RED-TEAM**: Content filter bypass (unicode confusables, base64-encoded secrets, split-across-fields), post-approval race conditions (approve during shutdown, double-approve, approve after tool server disconnect)
- **BUILD**: CLI interactive mode, custom system prompt, vault initialization wizard, `ved init` command
