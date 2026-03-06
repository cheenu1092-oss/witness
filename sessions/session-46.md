# Session 46 — RED-TEAM: CLI Injection, Parser Edge Cases, Deep Evasion

**Date:** 2026-03-06  
**Phase:** RED-TEAM  

## What Was Done

### 64 New Red-Team Tests Across 7 Attack Categories

**1. CLI Command Injection (7 tests)**
- ANSI escape codes (CSI, OSC title injection) do NOT parse as approval commands
- Carriage return injection (visual overwrite attack) blocked by regex
- Backspace characters treated as literal (no terminal interpretation)
- Newline injection breaks single-line command matching
- Tab and vertical tab ARE matched by `\s` — correct behavior for approve parsing

**2. Approval Parser Edge Cases (10 tests)**
- **ReDoS tested:** 100K-char input completes in <100ms — no catastrophic backtracking
- SQL injection in work order ID fails (trailing content breaks `\S+\s*$` regex)
- Format string specifiers (`%s%n%x`) harmless in JS — stored as literal string
- Newlines in deny reason break regex (single-line only)
- Unicode emoji in work order ID accepted and handled correctly
- Case-insensitive matching works for mixed case
- Special regex chars in deny reason preserved as-is
- 100 pending work orders listed without crash

**3. splitMessage Adversarial (9 tests)**
- Nested code blocks (triple backticks inside code block) handled correctly
- **Backtick bomb (500 fences):** completes in <200ms — no performance regression
- Single backtick lines correctly NOT treated as code fences
- Unclosed code block properly closed at split boundary with reopening
- Boundary cases: exactly 2000 chars (no split), 2001 chars (split)
- Code block with special chars in language tag (c++/objective-c) preserved
- Interleaved code/text across multiple splits maintains content integrity

**4. Content Filter Deep Evasion (12 tests)**
- **Confirmed accepted risks hold:** Cyrillic homoglyphs (а→a, е→e, А→A, с→c) still bypass NFKC normalization — by design
- RTL override (U+202E) correctly stripped before pattern matching
- Combining diacriticals (é via U+0301) change character identity — not caught (expected)
- Fullwidth symbols (＝→=) correctly normalized and caught
- ZW chars scattered through GitHub tokens correctly stripped → caught
- NFKC idempotency confirmed (double-pass finds nothing new)
- BOM (U+FEFF) at start correctly stripped
- **NEW FINDING (GAP-4):** U+2061-U+2064 (function application, invisible separator, invisible times, invisible plus) are NOT in the ZW strip regex. These can break token patterns. **Risk: LOW** — requires attacker to know exact token format AND inject invisible Unicode chars.

**5. Path Traversal Advanced (11 tests)**
- Null bytes in path blocked
- URL-encoded (`%2e%2e`) and double-encoded (`%252f`) treated as literals (no decode)
- Backslash traversal (Windows-style) — treated as literal char on Unix
- Deep nested traversal with intermediate valid dirs — blocked by assertPathContained
- Symlink test: logical path check passes but file not found (documented behavior)
- All 6 vault I/O methods (create, read, update, append, delete, rename) block traversal
- Both source AND destination checked on rename

**6. Event Loop Message Shape (8 tests)**
- 10MB string input completes in <1s — no parser explosion
- Binary data (all 256 byte values) returns null safely
- Empty string and null-byte-only strings return null
- Prototype pollution IDs (`__proto__`, `constructor.prototype.polluted`) treated as literal strings
- Content filter handles 1.6MB input (100K repeated passwords) in <5s
- splitMessage handles 100K-char input, total length preserved

**7. Work Order ID Injection (6 tests)**
- Backticks, markdown bold/italic, HTML tags in IDs — all treated as plain text
- Real work order create→approve cycle works correctly
- Failed approvals (not found) do NOT create audit entries — correct
- Very long deny reason (10K chars) fully preserved in audit log

## Findings

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| GAP-4 | LOW | U+2061-U+2064 invisible math chars not in ZW strip regex; can split tokens to bypass content filter | Accepted risk |

**GAP-4 Detail:** The ZW strip regex `[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]` includes U+2060 (word joiner) as an individual char, but U+2061 (function application), U+2062 (invisible times), U+2063 (invisible separator), U+2064 (invisible plus) are NOT included. If inserted mid-token (e.g., `ghp_AAAA\u2063BBBB`), they break the regex match, preventing detection. Risk is LOW because: (1) requires knowing exact token format, (2) requires injecting specific Unicode chars, (3) these chars are extremely rare in natural text.

**Fix if desired:** Extend the strip regex to `[\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]` (add U+2061-U+2064 to the range).

## All Existing Defenses Held

- ✅ Approval parser regex — no ReDoS, no injection
- ✅ VULN-14 path containment — all vault methods protected
- ✅ Content filter NFKC — catches fullwidth, ZW chars, BOM
- ✅ splitMessage code-block tracking — handles adversarial inputs
- ✅ SQL injection — parameterized queries throughout
- ✅ No prototype pollution — IDs are string lookups only

## Files Changed

| File | Change |
|------|--------|
| `src/redteam-s46.test.ts` | **64 new tests** across 7 attack categories |

## Test Results

- **927/927 tests pass** (host + Docker parity)
- **0 type errors** (TS compiles clean)
- **0 failures, 0 warnings**
- **64 net new tests** (863 → 927)

## Next Session

Session 47 — Options:
- **BUILD:** Fix GAP-4 (extend ZW strip regex to include U+2061-U+2064) — trivial 1-line change
- **BUILD:** Open-source readiness — README polish, architecture diagrams, CONTRIBUTING.md
- **BUILD:** New features — vault git init on `ved init`, healthcheck endpoint, metrics
- **RED-TEAM:** Deeper symlink/realpath attacks, timing side-channels on trust resolution
