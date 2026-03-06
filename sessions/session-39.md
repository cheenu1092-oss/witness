# Session 39 — RED-TEAM: Approval Commands, Idle Timer, New Surfaces

**Date:** 2026-03-05  
**Phase:** RED-TEAM  
**Duration:** ~12 min  

## Attack Summary

40 red-team tests across 7 attack categories targeting the new surfaces built in sessions 37-38.

### Categories

| # | Category | Tests | Findings |
|---|----------|-------|----------|
| 1 | Approval Command Injection | 9 | VULN-15, VULN-16 documented |
| 2 | Approval Authorization Bypass | 7 | All held — tier 4 enforcement solid |
| 3 | Work Order Race Conditions | 6 | Double-approve, expire-then-approve all blocked |
| 4 | Idle Timer Manipulation | 6 | Debounce, crash recovery, audit all working |
| 5 | Compressor Prompt Injection | 4 | Parser passes through — VaultManager is the boundary |
| 6 | Discord Adapter Abuse | 2 | Code-block splitting is a known risk |
| 7 | Pipeline Interaction Attacks | 6 | SQL injection, cross-session, control plane isolation all solid |

### Vulnerabilities Found

**VULN-15: Deny reason captures trailing commands (LOW)**
- `deny WO-123 reason and also approve WO-456` parses as deny with reason text
- The trailing "approve WO-456" is NOT executed — it's stored as denial reason text
- Risk: LOW — deny is auth-gated to owner-only, and reason is just logged
- Fix: Not needed — this is by design (free-form denial reasons). Document only.

**VULN-16: Null byte in command parsed as whitespace (LOW)**
- `approve\x00WO-123` — null byte (\x00) matches `\s` in JS regex
- The command parses as valid `approve` with ID `WO-123`
- Risk: LOW — authorization and work order lookup still enforce security
- Fix recommended: Strip null bytes from input before parsing (defense in depth)

### Gaps Documented

**GAP-2: Compressor LLM output can create entities with sensitive content**
- If LLM echoes user-provided sensitive data (passwords, keys) into entity extraction
- Parser passes it through — VaultManager writes it to disk
- Mitigation: T4 audit trail + vault git history makes it traceable
- Fix: Content filtering in Compressor before entity upsert (future session)

**GAP-3: Discord message splitting breaks code blocks**
- Naive split at 2000 chars can leave unclosed ``` blocks
- Mitigation: Smart splitting should close/reopen code blocks at boundaries
- Fix: Implement code-block-aware splitting in Discord adapter (future session)

### What Held Up

- **Approval authorization**: Tiers 1-3 all correctly blocked from approve/deny
- **VULN-9 regression**: Trust ledger self-grant still properly prevented
- **Double-approve/deny**: SQL WHERE clause prevents all race conditions
- **Expired work orders**: Both timeout and sweep-then-approve correctly blocked
- **SQL injection**: Prepared statements prevent all injection vectors
- **Idle timer**: Debounce, crash recovery, stats tracking, audit all working
- **Control plane isolation**: Approval commands correctly bypass working memory
- **Cross-session**: Work order approval from different session doesn't contaminate

## Test Results

```
New tests:  40/40 passed
Full suite: 680/685 passed (5 pre-existing integration test failures)
TS:         0 type errors
```

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/redteam-s39.test.ts` | Created | ~630 |

## Next Session (40)

Options:
- **BUILD**: Fix VULN-16 (strip null bytes from approval parser input) + GAP-3 (code-block-aware Discord splitting)
- **BUILD**: Work order execution after approval (currently approve resolves but doesn't re-execute the tool call)
- **RED-TEAM**: Deeper attacks on compressor → entity pipeline (GAP-2)
