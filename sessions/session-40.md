# Session 40 — BUILD: Fix VULN-16 + GAP-3

**Date:** 2026-03-05  
**Phase:** BUILD  
**Duration:** ~10 min  

## Fixes

### VULN-16: Null byte stripping in ApprovalParser

**Problem:** JS regex `\s` matches `\x00` (null byte), so `approve\x00WO-123` parsed as valid `approve WO-123`. While authorization still enforced security, this was a defense-in-depth gap.

**Fix:** Added `content.replace(/\0/g, '')` as the first line in `parseApprovalCommand()`, before any regex matching. Now:
- `approve\x00WO-123` → `approveWO-123` → no match → returns null ✅
- `approve WO-\x00123` → `approve WO-123` → valid match ✅
- `\x00\x00\x00` → `` → returns null ✅

**Tests added:** 6 new tests covering null bytes in commands, IDs, reasons, and edge cases.

### GAP-3: Code-block-aware Discord message splitting

**Problem:** Naive `splitMessage()` cut at 2000 chars without regard for open ``` code blocks, leaving unclosed fences that broke Discord rendering.

**Fix:** Rewrote `splitMessage()` to track code block state across chunks:
1. Count triple-backtick fences per chunk to determine if a block is left open
2. If open at split point: append closing `\`\`\`` to current chunk
3. Prepend the original opener (e.g., `\`\`\`python`) to the next chunk
4. Handles multiple code blocks, language tags, and mixed content

**Tests added:** 7 new tests covering:
- Balanced fence verification across all chunks
- Language tag preservation on reopen (`\`\`\`python`)
- Multiple code blocks in one message
- Split at fence boundary
- Regression: plain text splitting unchanged
- Opening-only fence with late close
- Nested/edge markdown cases

## Test Results

```
New tests:   13 (6 VULN-16 + 7 GAP-3)
Full suite:  693/698 pass (5 pre-existing integration test failures)
TS:          0 type errors
```

## Files Changed

| File | Action | Change |
|------|--------|--------|
| `src/core/approval-parser.ts` | Modified | Added null byte stripping (1 line) |
| `src/core/approval-parser.test.ts` | Modified | +6 VULN-16 tests |
| `src/channel/discord.ts` | Modified | Rewrote `splitMessage()` with code-block tracking |
| `src/channel/discord.test.ts` | Modified | +7 GAP-3 tests |

## Security Status

| ID | Severity | Status |
|----|----------|--------|
| VULN-1–14 | Various | ✅ Fixed (S35) |
| VULN-15 | LOW | ✅ By design (documented) |
| VULN-16 | LOW | ✅ Fixed this session |
| GAP-1 | — | ✅ Fixed (S35) |
| GAP-2 | — | Open (compressor content filtering — future) |
| GAP-3 | — | ✅ Fixed this session |

## Next Session (41)

Options:
- **BUILD**: Work order post-approval execution (approve resolves but doesn't re-execute the tool call yet)
- **BUILD**: GAP-2 fix (content filtering in Compressor before entity upsert)
- **RED-TEAM**: Attack the new splitMessage code-block logic + null byte edge cases
