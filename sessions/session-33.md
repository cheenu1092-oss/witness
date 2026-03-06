# Session 33 — RED-TEAM: Security & Memory Integrity Attacks

**Date:** 2026-03-05
**Phase:** RED-TEAM
**Duration:** ~20 min

## What Happened

### 41 Red-Team Tests Across 7 Attack Categories

| Category | Tests | Description |
|----------|-------|-------------|
| Memory Integrity | 7 | Tamper audit entries, delete chain links, inject entries, evict working memory, corrupt JSON, serialization attacks |
| Trust Escalation | 9 | Self-grant trust via DB, owner downgrade via ledger, unknown tool risk defaults, param escalation, sensitive file detection, work order expiry/double-approval |
| Session Hijacking | 5 | Cross-session isolation, closed session resumption, session ID forgery, trust tier locking, stale session sweep |
| RAG Poisoning | 4 | FTS5 injection, prompt injection in vault content, 1MB chunk OOM test, ghost graph edges |
| Hash Chain Attacks | 6 | Full chain rewrite (detected via HMAC anchor), wrong HMAC secret, no-secret placeholder, empty/single chain, 100-entry consistency |
| Input Validation | 6 | Null bytes, 100KB messages, SQL injection, unicode edge cases, empty content, duplicate message IDs |
| Pipeline Attack Scenarios | 4 | Stranger tool denial + audit trail, owner critical tool → work order, LLM failure audit completeness, infinite agentic loop capping |

### Vulnerabilities Found

**VULN-9: Trust ledger self-grant (RT-T1)** — MEDIUM
- **Attack:** Direct DB manipulation lets any actor insert a trust_ledger row granting themselves tier 4.
- **Impact:** If attacker has DB access, they can elevate to owner-level trust.
- **Mitigation needed:** `grantTrust()` should validate that `granted_by` is an authorized owner. DB-level access is already a worst-case scenario, but defense-in-depth says validate anyway.
- **Status:** Documented, fix deferred to next BUILD cycle.

**VULN-10: Owner downgrade via runtime ledger (RT-T3)** — MEDIUM
- **Attack:** Runtime trust_ledger takes priority over config `ownerIds`. A call to `grantTrust('cli', 'owner-1', 1, 'attacker')` downgrades the owner to tier 1.
- **Impact:** If an attacker can invoke `grantTrust`, they can lock out the owner.
- **Mitigation needed:** Config `ownerIds` should be treated as immutable floor — ledger can only elevate above config, never below.
- **Status:** Documented, fix deferred to next BUILD cycle.

**VULN-11: SessionManager.get() has no access control (RT-S3)** — LOW (by design)
- **Attack:** Any code path with a session ID can read that session's working memory.
- **Impact:** Limited — the EventLoop is the gatekeeper (matches channel+author before serving). SessionManager is a storage layer.
- **Mitigation:** Not needed if EventLoop access patterns are correct. Document this design assumption.

**VULN-12: Inbox double-processing on recovery (RT-P3, RT-P4)** — LOW
- **Attack:** Messages enqueued via `receive()` and then recovered from inbox by `recoverInbox()` get processed twice.
- **Impact:** Duplicate audit entries, duplicate responses. Not a security issue but a correctness issue.
- **Mitigation needed:** Check if message is already in the queue before re-enqueuing during recovery, or mark inbox rows as enqueued.
- **Status:** Documented, fix deferred to next BUILD cycle.

### What Held Up Well

1. **Hash chain integrity** — All tamper scenarios detected (modified entries, deleted entries, injected entries, forged genesis).
2. **HMAC anchoring** — Complete chain rewrite (internally consistent) still caught by HMAC anchor mismatch.
3. **SQL injection protection** — Parameterized queries handle all injection attempts.
4. **Input validation** — Null bytes, unicode, 100KB payloads, empty strings all handled.
5. **Trust matrix** — Stranger denied medium/high/critical tools. Work orders can't be approved after expiry or double-approved.
6. **Agentic loop cap** — Infinite tool calls properly capped at maxAgenticLoops.
7. **FTS5 safety** — Query escaping prevents FTS5 operator injection.

### Results

- **41 red-team tests — all pass**
- **457/457 total tests pass** (416 existing + 41 new)
- **4 vulnerabilities found** (2 medium, 2 low)
- **0 critical vulnerabilities**

## Cumulative Vulnerability Tracker

| # | Severity | Description | Status |
|---|----------|-------------|--------|
| 1-8 | Various | Sessions 15-20 findings | Fixed |
| 9 | MEDIUM | Trust ledger self-grant | Open |
| 10 | MEDIUM | Owner downgrade via ledger | Open |
| 11 | LOW | SessionManager.get() no ACL | By design |
| 12 | LOW | Inbox double-processing | Open |

## Next Session

Session 34: RED-TEAM continued — deeper attacks:
- Prompt injection via RAG context (test actual system prompt assembly with malicious vault content)
- Trust escalation via tool chaining (use low-risk tool to stage high-risk action)
- Timing attacks on work order approval window
- Memory tier boundary attacks (T1→T2 compression manipulation)
- Vault file path traversal via wikilinks
