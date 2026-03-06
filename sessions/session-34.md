# Session 34 — RED-TEAM: Deeper Attacks

**Date:** 2026-03-05
**Phase:** RED-TEAM (continued)
**Duration:** ~20 min

## What Happened

### 32 Red-Team Tests Across 7 Deeper Attack Categories

| Category | Tests | Description |
|----------|-------|-------------|
| Prompt Injection via RAG | 3 | System prompt override, nested markdown injection, trust engine defense against tricked LLM |
| Tool Chaining Escalation | 3 | Low→high tool chain for stranger, tribe medium-risk script creation gap, independent per-call trust assessment |
| Work Order Timing Attacks | 5 | Race conditions, concurrent approvals, expiry edge cases, DB manipulation re-open |
| Memory Tier Boundary | 5 | WM overflow, corrupt session recovery, fact isolation, deep nesting, massive serialization |
| Vault Path Traversal | 5 | ../ in wikilinks, createFile path escape, readFile traversal, basename defense, null bytes |
| Trust Resolution Edge Cases | 6 | Cross-channel isolation, rapid grant/revoke, empty/long userId, SQL injection |
| RAG Fusion Manipulation | 5 | Keyword stuffing, graph walk bomb (1000 edges), circular graph cycles, empty queries, stopwords |

### Vulnerabilities Found

**VULN-13: Expired work order can be re-opened via DB manipulation (RT2-WO5)** — MEDIUM
- **Attack:** If attacker has DB access, they can reset an expired work order's status back to 'pending', then approve it.
- **Impact:** `approve()` only checks `status = 'pending'`, not `expired_at IS NULL` or `resolved_at IS NULL`.
- **Mitigation needed:** `approve()` and `deny()` should also check `resolved_at IS NULL AND expires_at > now`.
- **Status:** Documented, fix deferred to next BUILD cycle.

**VULN-14: VaultManager has no path containment validation (RT2-VPT2)** — MEDIUM
- **Attack:** Calling `createFile('../escaped.md', ...)` resolves to a path OUTSIDE the vault directory.
- **Impact:** Agent or LLM-driven code could write files outside the vault (e.g., overwrite system files).
- **Defense now:** OS filesystem permissions (EACCES blocks some paths). Not a code-level defense.
- **Mitigation needed:** All VaultManager write methods (createFile, updateFile, deleteFile, renameFile, appendToFile) should validate that `resolve(join(vaultPath, relPath))` starts with `resolve(vaultPath) + '/'`.
- **Status:** Documented, fix deferred to next BUILD cycle.

**GAP-1: Shell scripts (.sh) not treated as sensitive files by param escalation (RT2-TC2)** — LOW
- **Finding:** Tribe members (tier 3) can auto-approve Write to .sh files (medium risk, not escalated).
- **Impact:** Can create executable scripts, though executing them still requires high-risk exec tool.
- **Mitigation:** Add `.sh`, `.bat`, `.ps1` to the sensitive file extensions list in TrustEngine.
- **Status:** Documented, optional fix.

**GAP-2: Working memory eviction drops data without T2/T3 transition (RT2-MB1)** — INFO
- **Finding:** When working memory exceeds token budget, older messages are dropped entirely.
- **Impact:** Data loss, not security. Architecture says "forgetting = move to T3" but T1→T2/T3 compression is not yet implemented.
- **Status:** Expected — pending future BUILD cycle for memory compression.

### What Held Up Well

1. **Trust engine as defense-in-depth against prompt injection** — Even when malicious RAG content convinces the LLM to call tools, the trust engine independently gates execution. Strangers are blocked regardless of what the system prompt says.
2. **Independent per-tool trust assessment** — Each tool call in an agentic loop is assessed independently. No session-level trust caching that could be exploited.
3. **Cross-channel trust isolation** — Same user on different channels (CLI vs Discord) has independent trust entries.
4. **SQL injection protection** — All trust queries are parameterized. Injection in userId/channel fields is harmless.
5. **Graph walk cycle detection** — Circular wikilink references are handled via visited set. No infinite loops.
6. **Graph walk bomb mitigation** — 1000 outgoing links to non-existent files completes in <1s (no chunks = no results).
7. **Concurrent work order approval** — Only the first approval succeeds; second returns null.
8. **Session fact isolation** — Working memory facts don't leak between sessions.
9. **Corrupt session recovery** — Corrupt working_memory JSON gracefully degrades to empty WM.
10. **FTS edge cases** — Empty queries, stopwords, and special characters all handled gracefully.

### Results

- **32 red-team tests — all pass**
- **489/489 total tests pass** (457 existing + 32 new)
- **2 new vulnerabilities found** (both MEDIUM)
- **2 gaps documented** (1 LOW, 1 INFO)
- **0 critical vulnerabilities**

## Cumulative Vulnerability Tracker

| # | Severity | Description | Status |
|---|----------|-------------|--------|
| 1-8 | Various | Sessions 15-20 findings | Fixed |
| 9 | MEDIUM | Trust ledger self-grant | Open |
| 10 | MEDIUM | Owner downgrade via ledger | Open |
| 11 | LOW | SessionManager.get() no ACL | By design |
| 12 | LOW | Inbox double-processing | Open |
| 13 | MEDIUM | Expired work order re-openable via DB | Open |
| 14 | MEDIUM | VaultManager no path containment | Open |

## Next Session

Session 35: **BUILD cycle** — Fix open vulnerabilities:
- VULN-9: Validate `granted_by` is authorized in `grantTrust()`
- VULN-10: Config ownerIds as immutable floor in trust resolution
- VULN-12: Deduplicate inbox recovery messages
- VULN-13: Add `resolved_at IS NULL` check to work order approve/deny
- VULN-14: Path containment validation in VaultManager
- GAP-1: Add .sh/.bat/.ps1 to sensitive file extensions
