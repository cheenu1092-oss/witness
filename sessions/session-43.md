# Session 43 — RED-TEAM: Content Filter Bypass + Post-Approval Race Conditions

**Date:** 2026-03-06  
**Phase:** RED-TEAM  

## What Was Done

### 43 red-team tests across 7 attack categories

**1. Content Filter Bypass — Unicode Confusables (3 tests)**
- Unicode confusable attack (Cyrillic 'а' instead of Latin 'a' in `api_key`) — **BYPASS CONFIRMED**
- Fullwidth Latin character bypass — **BYPASS CONFIRMED**
- Zero-width joiner injection in key prefix — **BYPASS CONFIRMED**
- These are inherent to regex-based filtering. Mitigation would require Unicode normalization (NFKC) before regex matching.

**2. Content Filter Bypass — Encoding + Split (5 tests)**
- Base64-encoded secrets bypass filter — **EXPECTED** (filter only works on plaintext)
- Hex-encoded AWS keys bypass — **EXPECTED**
- Split-across-fields attack (secret split between entity name and fact) — **DOCUMENTED**
- Password split by newline — tested `\s` behavior in regex
- Standard ASCII API key correctly caught — **HELD**

**3. Content Filter Boundary Cases (12 tests)**
- AWS key boundary: exact 16-char, 15-char (too short), 20-char (long) — all correct
- JWT minimum segment lengths — correctly caught
- JWT-like with short segments — correctly not caught
- GitHub tokens: `gh[posh]_` character class tested
- **VULN-17 FOUND:** `ghr_` (GitHub fine-grained PAT) bypasses `gh[posh]_` regex — `r` not in character class
- `gha_` correctly not caught
- Multiple secrets in one text — all caught
- Secret in markdown code block — caught
- JSON format API key — caught (regex is substring-based)
- PEM private key — caught
- Connection string with special chars — caught
- Slack token formats — caught
- Normal text not falsely flagged — held
- Empty/whitespace input — handled correctly

**4. Post-Approval Race Conditions (6 tests)**
- Double-approve: second approval fails (VULN-13 fix holds) — **HELD**
- Approve then deny: deny fails on resolved order — **HELD**
- Deny then approve: approve fails on resolved order — **HELD**
- Concurrent approve from two owners: exactly one succeeds (SQLite serialization) — **HELD**
- Approve after manual expiry: VULN-13 `expires_at > @resolvedAt` blocks it — **HELD**
- Approve at exact expiry boundary: strict `>` comparison rejects — **HELD**

**5. Post-Approval Session Integrity (3 tests)**
- Cross-session contamination: tool result doesn't leak to other sessions — **HELD**
- Audit survives channel send failure — **HELD**
- Work order result persists even after session cleanup — **HELD**

**6. Work Order Timing + Safety (3 tests)**
- Rapid 10x create + approve: all succeed — **HELD**
- Sweep doesn't affect already-approved orders — **HELD**
- 100 work orders with no ID collisions (ULID) — **HELD**

**7. Compressor→Filter Interaction (4 tests)**
- Entity name encoding secrets: obfuscated `p4ssw0rd` in entity name bypasses filter — **DOCUMENTED** (accepted risk)
- Connection string in fact text — caught by filter
- JWT in decision context — caught by filter
- Multiple secrets across facts and decisions — all caught

**8. Approval+Filter Combined (5 tests)**
- Tool result with API key in working memory: T1 stores raw (by design), filter catches at T2/T3 boundary — **AS DESIGNED**
- Work order params immutable after creation (JSON copy in DB) — **HELD**
- SQL injection in tool name: parameterized queries prevent — **HELD**
- 100KB params stored correctly — **HELD**

## Vulnerabilities Found

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| VULN-17 | LOW | `ghr_` GitHub fine-grained PAT tokens bypass `gh[posh]_` regex (missing `r` in char class) | NEW |

## Findings Documented (Accepted Risk / Known Limitations)

1. **Unicode confusable bypass** — Cyrillic/fullwidth/zero-width chars defeat ASCII regex patterns. Mitigation: NFKC normalization. Low risk (LLM output rarely uses confusables).
2. **Base64/hex encoding bypass** — Filter is plaintext-only by design. Would need decode-then-filter pipeline.
3. **Obfuscated secrets in entity names** — `toKebabCase` preserves digits, so `p4ssw0rd` survives. Low risk (attacker needs to control LLM output format).
4. **T1 stores raw secrets** — By design. LLM needs tool results. Filter is T2/T3 boundary defense.

## Files Changed

| File | Action | Change |
|------|--------|--------|
| `src/redteam-s43.test.ts` | Created | 43 red-team tests (802 lines) |

## Stats

```
Source:  11,447 LoC
Tests:   12,571 LoC
Total:   24,018 LoC
Tests:   772/772 pass (host + Docker parity)
TS:      0 type errors
Docker:  Builds + tests clean
```

## Next Session (44)

- **BUILD**: Fix VULN-17 (`gh[poshr]_` regex), optionally add NFKC Unicode normalization to `filterSensitiveContent`
- **BUILD**: CLI interactive mode, `ved init` wizard, custom system prompt configuration
- **TEST**: Regression tests for VULN-17 fix
