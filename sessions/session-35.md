# Session 35 — BUILD: Fix Open Vulnerabilities

**Date:** 2026-03-05
**Phase:** BUILD (vulnerability fixes)
**Duration:** ~15 min

## What Happened

### Fixed 5 Vulnerabilities + 1 Gap

| Vuln | Severity | Fix | File |
|------|----------|-----|------|
| VULN-9 | MEDIUM | `grantTrust()` validates `grantedBy` is in `config.ownerIds` — throws if not | `src/trust/engine.ts` |
| VULN-10 | MEDIUM | `resolveTier()` uses config as immutable floor — ledger can only elevate, never downgrade below config tier | `src/trust/engine.ts` |
| VULN-12 | LOW | `recoverInbox()` tracks IDs via `recoveredIds` Set — `receive()` also adds to set. Recovery skips already-enqueued messages | `src/core/event-loop.ts` |
| VULN-13 | MEDIUM | `approve()`/`deny()` SQL now requires `resolved_at IS NULL AND expires_at > @resolvedAt` — expired or already-resolved orders cannot be re-opened | `src/trust/work-orders.ts` |
| VULN-14 | MEDIUM | Added `assertPathContained()` to VaultManager — validates `resolve(join(vaultPath, relPath))` starts with `resolve(vaultPath) + '/'`. Applied to: `readFile`, `createFile`, `updateFile`, `appendToFile`, `deleteFile`, `renameFile` | `src/memory/vault.ts` |
| GAP-1 | LOW | Added `.sh`, `.bat`, `.ps1`, `.cmd`, `.bash`, `.zsh` to param escalation rules for `Write` and `Edit` — escalates to `high` risk | `src/trust/engine.ts` |

### Implementation Details

**VULN-9 (Trust self-grant):**
- `grantTrust()` now checks `!this.config.ownerIds.includes(grantedBy)` before any DB operations
- Throws descriptive error on violation
- Defense-in-depth: direct DB manipulation (raw SQL INSERT) still works — can't prevent at code level — but the API is now protected

**VULN-10 (Owner downgrade):**
- `resolveTier()` now determines config floor first (ownerIds→4, tribeIds→3, knownIds→2, default)
- If ledger entry exists, returns `Math.max(ledgerTier, configTier)` — ledger can only add, never subtract
- Breaking change: existing test expected owner downgrade via ledger, updated to assert new behavior

**VULN-12 (Inbox double-processing):**
- Added `recoveredIds: Set<string>` to EventLoop
- `receive()` adds msg.id to set when first enqueued
- `recoverInbox()` skips messages already in set (enqueued before crash recovery ran)

**VULN-13 (Expired work order re-open):**
- `approve()` and `deny()` WHERE clauses now include `AND resolved_at IS NULL AND expires_at > @resolvedAt`
- Even if attacker resets `status` to 'pending' via raw SQL, the expiry check blocks approval

**VULN-14 (Vault path traversal):**
- New private method `assertPathContained(relPath)` using `resolve()` + startsWith check
- Applied to ALL file I/O methods (read + write + delete + rename)
- Throws `"Path traversal blocked: '...' resolves outside vault boundary"`

**GAP-1 (Script file escalation):**
- New param escalator for Write/Edit: matches `.sh|.bat|.ps1|.cmd|.bash|.zsh` extensions
- Escalates risk to `high` with reason "Writing/Editing executable script file"
- Tribe members (tier 3) now need approval for script file writes

### Test Updates

- Updated 5 existing tests (trust + red-team) that assumed old vulnerable behavior
- Added 1 new test (`grantTrust rejects non-owner grantedBy`)
- **490/490 tests pass** (1 new test, updated expectations on 5 existing)
- TypeScript compiles clean (0 errors)
- Docker build + test parity confirmed

## Vulnerability Status

| # | Severity | Description | Status |
|---|----------|-------------|--------|
| 1-8 | Various | Sessions 15-20 findings | ✅ Fixed |
| 9 | MEDIUM | Trust ledger self-grant | ✅ Fixed (S35) |
| 10 | MEDIUM | Owner downgrade via ledger | ✅ Fixed (S35) |
| 11 | LOW | SessionManager.get() no ACL | By design |
| 12 | LOW | Inbox double-processing | ✅ Fixed (S35) |
| 13 | MEDIUM | Expired work order re-open | ✅ Fixed (S35) |
| 14 | MEDIUM | Vault path traversal | ✅ Fixed (S35) |
| GAP-1 | LOW | Script files not escalated | ✅ Fixed (S35) |
| GAP-2 | INFO | WM eviction data loss | Expected (future) |

**All security vulnerabilities resolved.** Only GAP-2 (working memory eviction → T2/T3 compression) remains as a known future feature.

## Next Session

Session 36: TEST — Regression tests for all fixes:
- Verify VULN-9: exhaustive grantTrust authorization tests
- Verify VULN-10: owner floor immutability across channels, rapid grant/revoke
- Verify VULN-12: simulate receive+recovery interleaving
- Verify VULN-13: expired order re-open attempts, edge timing
- Verify VULN-14: path traversal variants (symlinks, encoded chars, double-dots)
- Verify GAP-1: all script extensions escalated correctly
