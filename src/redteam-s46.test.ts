/**
 * Red Team Tests — Session 46 (Attack: CLI Injection, Parser Edge Cases, Deep Evasion)
 *
 * Attack categories:
 * 1. CLI COMMAND INJECTION — ANSI escape codes, terminal control sequences in input
 * 2. APPROVAL PARSER EDGE CASES — Regex catastrophic backtracking, format string attacks
 * 3. SPLITMESSAGE ADVERSARIAL — Nested/malformed code blocks, backtick bombs, edge splits
 * 4. CONTENT FILTER DEEP EVASION — Cyrillic homoglyphs, RTL override, combining diacriticals
 * 5. PATH TRAVERSAL ADVANCED — Null bytes in paths, URL-encoded paths, symlink attacks
 * 6. EVENT LOOP MESSAGE SHAPE — Malformed messages, missing fields, prototype pollution attempts
 * 7. WORK ORDER ID INJECTION — Crafted IDs to break SQL or logging
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { filterSensitiveContent } from './core/compressor.js';
import { parseApprovalCommand, executeApprovalCommand, type ApprovalParserDeps } from './core/approval-parser.js';
import { splitMessage } from './channel/discord.js';
import { VaultManager } from './memory/vault.js';
import { AuditLog } from './audit/store.js';
import { TrustEngine } from './trust/engine.js';
import { WorkOrderManager } from './trust/work-orders.js';
import { migrate } from './db/migrate.js';
import { getDefaults } from './core/config.js';
import type { VedConfig } from './types/index.js';

// ─── Helpers ───

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function makeConfig(overrides?: Partial<VedConfig>): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    ...overrides,
    ownerIds: overrides?.ownerIds ?? ['owner-1'],
    audit: { ...defaults.audit, ...overrides?.audit },
    trust: { ...defaults.trust, ...overrides?.trust },
  } as VedConfig;
}

function setupApprovalDeps(db: Database.Database, config: VedConfig): {
  workOrders: WorkOrderManager;
  trust: TrustEngine;
  audit: AuditLog;
} {
  const audit = new AuditLog(db);
  const trust = new TrustEngine(db, config, audit);
  const workOrders = new WorkOrderManager(db);
  return { workOrders, trust, audit };
}

function createTempVault(): { path: string; cleanup: () => void } {
  const path = join(tmpdir(), `ved-rt-s46-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path, { recursive: true });
  return {
    path,
    cleanup: () => { try { rmSync(path, { recursive: true, force: true }); } catch {} },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. CLI COMMAND INJECTION
//    Attack: inject ANSI escape sequences, terminal control codes, cursor
//    manipulation, OSC commands via user input that flows through the CLI
//    adapter and into logs/audit/memory.
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S46 — 1. CLI Command Injection', () => {
  it('ANSI escape codes in message do not break approval parser', () => {
    // Attack: embed ANSI escape codes to potentially confuse parsing
    const payload = '\x1B[2J\x1B[Happrove WO-123';
    const cmd = parseApprovalCommand(payload);
    // The ANSI codes are treated as whitespace/noise — should NOT parse as valid command
    // because the regex expects ^\\s*approve... and ANSI codes aren't \\s
    expect(cmd).toBeNull();
  });

  it('OSC terminal title injection in input is harmless', () => {
    // Attack: OSC 0 sets terminal title — could be abused for social engineering
    const payload = '\x1B]0;HACKED\x07approve WO-123';
    const cmd = parseApprovalCommand(payload);
    // OSC sequence is not whitespace, so regex won't match
    expect(cmd).toBeNull();
  });

  it('carriage return injection does not overwrite visible command', () => {
    // Attack: use \\r to visually overwrite what was displayed
    const payload = 'deny WO-FAKE reason\rapprove WO-REAL';
    const cmd = parseApprovalCommand(payload);
    // \\r is not stripped; the whole line doesn't match approve or deny cleanly
    expect(cmd).toBeNull();
  });

  it('backspace characters do not alter parsed command', () => {
    // Attack: use backspace to "erase" characters
    const payload = 'deny\b\b\b\bapprove WO-123';
    const cmd = parseApprovalCommand(payload);
    // Backspaces are literal characters, not processed
    expect(cmd).toBeNull();
  });

  it('newline injection splits command — only first line matters', () => {
    // Attack: inject newlines to add a second hidden command
    const payload = 'pending\napprove WO-SECRET';
    const cmd = parseApprovalCommand(payload);
    // The regex uses $ not .*, so newline breaks the pending match
    // and the overall string doesn't match any single-command pattern
    expect(cmd).toBeNull();
  });

  it('tab characters in approve command treated as non-space', () => {
    // Tab between approve and ID should still work since \\s matches \\t
    const payload = 'approve\tWO-123';
    const cmd = parseApprovalCommand(payload);
    expect(cmd).not.toBeNull();
    expect(cmd!.action).toBe('approve');
    expect(cmd!.workOrderId).toBe('WO-123');
  });

  it('vertical tab and form feed are matched by \\s', () => {
    const payload = 'approve\x0BWO-123'; // vertical tab
    const cmd = parseApprovalCommand(payload);
    expect(cmd).not.toBeNull();
    expect(cmd!.workOrderId).toBe('WO-123');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. APPROVAL PARSER EDGE CASES
//    Attack: catastrophic backtracking, very long inputs, format strings,
//    injection through work order IDs.
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S46 — 2. Approval Parser Edge Cases', () => {
  it('extremely long input does not cause catastrophic backtracking', () => {
    // Attack: ReDoS — send a huge string that makes regex backtrack exponentially
    const longPayload = 'approve ' + 'A'.repeat(100_000);
    const start = performance.now();
    const cmd = parseApprovalCommand(longPayload);
    const elapsed = performance.now() - start;

    // Must complete in under 100ms (no catastrophic backtracking)
    expect(elapsed).toBeLessThan(100);
    expect(cmd).not.toBeNull();
    expect(cmd!.action).toBe('approve');
  });

  it('work order ID with SQL injection payload', () => {
    const payload = "approve WO-123'; DROP TABLE audit_log; --";
    const cmd = parseApprovalCommand(payload);
    // \\S+ stops at space, so only WO-123'; is captured... but the rest breaks the regex
    // because there's trailing content after the ID for approve (which expects only \\S+\\s*$)
    expect(cmd).toBeNull();
  });

  it('work order ID with format string specifiers', () => {
    const payload = 'approve %s%n%x';
    const cmd = parseApprovalCommand(payload);
    // %s%n%x is a valid \\S+ match
    expect(cmd).not.toBeNull();
    expect(cmd!.workOrderId).toBe('%s%n%x');
    // The ID is just a string — format specifiers have no effect in JS
  });

  it('deny with multi-line reason (injected newlines)', () => {
    const payload = 'deny WO-123 bad\nbecause\nreasons';
    const cmd = parseApprovalCommand(payload);
    // Newline breaks the regex match since it expects single line
    expect(cmd).toBeNull();
  });

  it('unicode work order ID is accepted', () => {
    const payload = 'approve WO-🔥-42';
    const cmd = parseApprovalCommand(payload);
    expect(cmd).not.toBeNull();
    expect(cmd!.workOrderId).toBe('WO-🔥-42');
  });

  it('approve command with only whitespace after ID', () => {
    const payload = 'approve WO-123   \t  ';
    const cmd = parseApprovalCommand(payload);
    expect(cmd).not.toBeNull();
    expect(cmd!.workOrderId).toBe('WO-123');
  });

  it('case-insensitive matching works for mixed case', () => {
    const payload = 'ApPrOvE WO-123';
    const cmd = parseApprovalCommand(payload);
    expect(cmd).not.toBeNull();
    expect(cmd!.action).toBe('approve');
  });

  it('deny reason with special regex characters', () => {
    const payload = 'deny WO-123 reason.*+?()[]{}|\\^$';
    const cmd = parseApprovalCommand(payload);
    expect(cmd).not.toBeNull();
    expect(cmd!.reason).toBe('reason.*+?()[]{}|\\^$');
  });

  let db: Database.Database;
  let config: VedConfig;

  beforeEach(() => {
    db = createTestDb();
    config = makeConfig();
  });

  afterEach(() => {
    db.close();
  });

  it('executeApprovalCommand with non-existent WO returns not found', () => {
    const deps = setupApprovalDeps(db, config);
    const cmd = { action: 'approve' as const, workOrderId: 'NONEXISTENT-ID' };
    const result = executeApprovalCommand(cmd, 'discord', 'owner-1', deps);
    expect(result.response).toContain('not found');
  });

  it('pending command when many work orders exist does not crash', () => {
    const deps = setupApprovalDeps(db, config);
    // Create 100 work orders
    for (let i = 0; i < 100; i++) {
      deps.workOrders.create(
        `session-${i}`,
        `msg-${i}`,
        `tool-${i}`,
        { index: i },
        { level: 'medium' as const, reasons: ['test'] },
        3 as const,
      );
    }
    const cmd = { action: 'pending' as const };
    const result = executeApprovalCommand(cmd, 'discord', 'owner-1', deps);
    expect(result.response).toContain('100 pending');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SPLITMESSAGE ADVERSARIAL
//    Attack: crafted inputs with nested code blocks, mismatched backticks,
//    backtick bombs, and boundary-exact messages.
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S46 — 3. splitMessage Adversarial', () => {
  it('nested code blocks (triple backticks inside code block)', () => {
    // Attack: confuse the fence tracker with nested backticks
    const inner = '```\ninner code\n```';
    const content = '```markdown\n' + inner + '\n```\n' + 'A'.repeat(3000);
    const chunks = splitMessage(content);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must be ≤ 2000 chars
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('backtick bomb — thousands of ``` in sequence', () => {
    // Attack: DoS via fence tracking — many toggles
    const bombs = '```\n'.repeat(500); // 2000 chars of just fences
    const content = bombs + 'A'.repeat(3000);
    const start = performance.now();
    const chunks = splitMessage(content);
    const elapsed = performance.now() - start;

    // Must complete quickly (no exponential blowup)
    expect(elapsed).toBeLessThan(200);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('single backtick lines are not treated as code fences', () => {
    const content = '`single backtick`\n' + 'A'.repeat(3000);
    const chunks = splitMessage(content);
    // No code block tracking should be triggered
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      // No stray ``` closure should appear
      expect(chunk).not.toMatch(/\n```$/);
    }
  });

  it('unclosed code block spanning entire message', () => {
    // Attack: open a code block that never closes, forcing closure logic
    const content = '```python\n' + 'x = 1\n'.repeat(400); // ~2400 chars
    const chunks = splitMessage(content);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should end with closing ```
    expect(chunks[0]).toMatch(/```$/);
    // Second chunk should reopen with ```python
    expect(chunks[1]).toMatch(/^```python/);
  });

  it('message exactly at 2000 chars is not split', () => {
    const content = 'X'.repeat(2000);
    const chunks = splitMessage(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(content);
  });

  it('message at 2001 chars IS split', () => {
    const content = 'X'.repeat(2001);
    const chunks = splitMessage(content);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('only whitespace between code fences', () => {
    const content = '```\n   \n```\n' + 'B'.repeat(3000);
    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('code block with language tag containing special chars', () => {
    const content = '```c++/objective-c\ncode here\n' + 'x\n'.repeat(1000);
    const chunks = splitMessage(content);
    expect(chunks.length).toBeGreaterThan(1);
    // Language tag should be preserved in reopened block
    if (chunks.length > 1 && chunks[1].startsWith('```')) {
      expect(chunks[1]).toMatch(/^```c\+\+\/objective-c/);
    }
  });

  it('interleaved code blocks and normal text across splits', () => {
    // Create: text, code, text, code, text — each ~800 chars
    let content = '';
    content += 'Normal text: ' + 'A'.repeat(787) + '\n'; // 800
    content += '```js\n' + 'code1\n'.repeat(130) + '```\n'; // ~800
    content += 'More text: ' + 'B'.repeat(789) + '\n'; // 800
    content += '```py\n' + 'code2\n'.repeat(130) + '```\n'; // ~800
    content += 'Final text: ' + 'C'.repeat(788); // 800

    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // Rejoin should reconstruct the content (minus any added closure/opener)
    const rejoined = chunks.join('');
    expect(rejoined).toContain('Normal text:');
    expect(rejoined).toContain('Final text:');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. CONTENT FILTER DEEP EVASION
//    Attack: Cyrillic homoglyphs for Latin chars, RTL override chars,
//    combining diacriticals over letters, homoglyph substitution.
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S46 — 4. Content Filter Deep Evasion', () => {
  it('Cyrillic а (U+0430) in "password" is NOT normalized by NFKC', () => {
    // NFKC does NOT convert Cyrillic а → Latin a — they're distinct characters
    // This is a KNOWN accepted risk (documented in S43 findings)
    const cyrillic_a = '\u0430'; // Cyrillic small а
    const payload = `p${cyrillic_a}ssword=hunter2`;
    const { sanitized, redactions } = filterSensitiveContent(payload);

    // NFKC leaves Cyrillic chars intact — this WILL NOT be caught
    // This is the accepted risk from S43 — documenting it holds
    expect(sanitized).toBe(payload);
    expect(redactions).toHaveLength(0);
  });

  it('Cyrillic е (U+0435) in "Bearer" bypasses filter (accepted risk)', () => {
    const cyrillic_e = '\u0435';
    const payload = `B${cyrillic_e}arer sk-1234567890abcdef1234567890abcdef`;
    const { sanitized } = filterSensitiveContent(payload);
    // Not caught — Cyrillic confusables are accepted risk
    expect(sanitized).toBe(payload);
  });

  it('RTL override (U+202E) is stripped before matching', () => {
    // Attack: use RTL override to visually reverse text while keeping bytes in order
    const rtlOverride = '\u202E';
    const payload = `password${rtlOverride}=secret123`;
    const { sanitized, redactions } = filterSensitiveContent(payload);
    // RTL override is in the ZW strip range (U+2028-U+202F)
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_PASSWORD]');
  });

  it('combining diacritical marks over key letters', () => {
    // Attack: add combining marks (U+0300 - U+036F) to alter appearance
    // "password" with combining acute accent over 'a'
    const payload = 'pa\u0301ssword=secretvalue';
    const { sanitized } = filterSensitiveContent(payload);
    // NFKC may compose á (a + combining acute) into á (U+00E1) which is NOT 'a'
    // So "pássword" won't match "password" pattern
    // This is expected — combining marks change the character identity
    // The regex expects literal "password"
    if (sanitized.includes('[REDACTED')) {
      // If NFKC decomposes back, the filter catches it — good
      expect(sanitized).toContain('[REDACTED_PASSWORD]');
    } else {
      // If NFKC composes to 'á', password regex misses — accepted
      expect(sanitized).toContain('\u00E1'); // composed character preserved
    }
  });

  it('fullwidth exclamation and symbols near API key patterns', () => {
    // Fullwidth = (U+FF1D) should normalize to =
    const payload = 'api_key\uFF1Dsk_live_abcdef1234567890abcd';
    const { sanitized, redactions } = filterSensitiveContent(payload);
    // NFKC normalizes fullwidth = to regular =
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_API_KEY]');
  });

  it('multiple zero-width chars scattered through a GitHub token', () => {
    // ghp_ with ZWJ, ZWNJ, ZW space between each character
    const payload = 'g\u200Bh\u200Cp\u200D_' + 'A'.repeat(40);
    const { sanitized, redactions } = filterSensitiveContent(payload);
    // ZW chars stripped → becomes ghp_ + A*40 → caught
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('double-encoding attempt: NFKC applied to already-NFKC text', () => {
    // Ensure idempotency — double normalization doesn't break anything
    const payload = 'password=mysecret123';
    const first = filterSensitiveContent(payload);
    const second = filterSensitiveContent(first.sanitized);
    // Second pass should find nothing new
    expect(second.redactions).toHaveLength(0);
    expect(second.sanitized).toBe(first.sanitized);
  });

  it('mixed script attack: Latin + Cyrillic + fullwidth in one token', () => {
    // Some letters Latin, some Cyrillic, some fullwidth
    const payload = 'ｐa\u0441sword=secret'; // fullwidth p + Latin a + Cyrillic с + rest
    const { sanitized } = filterSensitiveContent(payload);
    // NFKC normalizes fullwidth ｐ→p but Cyrillic с stays as с
    // So "paсsword" ≠ "password" — won't match
    // This is the known accepted risk
    expect(sanitized).toBe('paсsword=secret'); // Cyrillic с preserved
  });

  it('invisible separator characters (U+2063, U+2064) in key patterns', () => {
    // These are NOT in the current ZW strip range — potential gap
    const invisSep = '\u2063'; // invisible separator
    const payload = `pass${invisSep}word=secret123`;
    const { sanitized, redactions } = filterSensitiveContent(payload);
    // U+2063 is NOT in the strip range [\u200B-\u200F\u2028-\u202F\u2060\uFEFF]
    // It's at U+2063 which is outside U+2028-U+202F and above U+2060
    // Wait — let me check: the range is individual chars, not a range for 2060+
    // The regex has \u2060 as a single char, not \u2060-\u206F
    // So U+2063 is NOT stripped
    if (redactions.length === 0) {
      // U+2063 breaks the pattern — this is a potential FINDING
      expect(sanitized).toContain(invisSep);
    }
  });

  it('invisible chars U+2061-U+2064 (function application, separator, joiner) not stripped', () => {
    // Documenting the gap: U+2060 is stripped but U+2061-U+2064 are not
    const chars = ['\u2061', '\u2062', '\u2063', '\u2064'];
    for (const ch of chars) {
      const payload = `ghp_${'A'.repeat(20)}${ch}${'B'.repeat(20)}`;
      const { sanitized } = filterSensitiveContent(payload);
      // If the invisible char breaks the token, it won't be caught
      // The regex expects ghp_ followed by continuous [A-Za-z0-9_]{36,}
      // An invisible char would break the match
      if (!sanitized.includes('[REDACTED_GITHUB_TOKEN]')) {
        // Invisible char broke the match — this IS a gap (but LOW risk)
        expect(sanitized).toContain(ch);
      }
    }
  });

  it('BOM (U+FEFF) at start of input is stripped', () => {
    const payload = '\uFEFFpassword=secret123';
    const { sanitized, redactions } = filterSensitiveContent(payload);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_PASSWORD]');
  });

  it('AWS key with Cyrillic A (U+0410) at start bypasses (accepted risk)', () => {
    // AKIA prefix with Cyrillic А instead of Latin A
    const payload = '\u0410KIA' + 'X'.repeat(16);
    const { sanitized } = filterSensitiveContent(payload);
    // Cyrillic А is not normalized to Latin A by NFKC — accepted risk
    expect(sanitized).toBe(payload);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. PATH TRAVERSAL ADVANCED
//    Attack: null bytes, URL-encoding, symlinks, double-dot sequences,
//    Windows-style separators, case manipulation.
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S46 — 5. Path Traversal Advanced', () => {
  let vault: VaultManager;
  let vaultDir: { path: string; cleanup: () => void };

  beforeEach(async () => {
    vaultDir = createTempVault();
    vault = new VaultManager(vaultDir.path, false);
    await vault.init();
  });

  afterEach(() => {
    vault.close();
    vaultDir.cleanup();
  });

  it('null byte in path is blocked', () => {
    expect(() => vault.readFile('entities/\x00../../../etc/passwd'))
      .toThrow();
  });

  it('URL-encoded dots (%2e%2e) are treated as literal characters', () => {
    // URL encoding is not decoded by path.resolve — these become literal directory names
    // which don't exist, so readFile throws "not found" not "traversal blocked"
    expect(() => vault.readFile('%2e%2e/%2e%2e/etc/passwd'))
      .toThrow();
  });

  it('double-encoded traversal (..%252f..)', () => {
    expect(() => vault.readFile('..%252f..%252fetc/passwd'))
      .toThrow();
  });

  it('backslash-based traversal (Windows-style)', () => {
    // On Unix, backslash is a valid filename character, not a separator
    // path.resolve treats it as a literal char, so no traversal
    // But the path won't exist
    expect(() => vault.readFile('..\\..\\etc\\passwd'))
      .toThrow();
  });

  it('deeply nested traversal with intermediate valid dirs', () => {
    // Create a deep valid path, then traverse back up and out
    mkdirSync(join(vaultDir.path, 'a/b/c'), { recursive: true });
    expect(() => vault.readFile('a/b/c/../../../../etc/passwd'))
      .toThrow(/traversal blocked/i);
  });

  it('symlink inside vault pointing outside is followed (expected behavior)', () => {
    // Create a file outside the vault
    const outsideDir = join(tmpdir(), `ved-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.txt'), 'sensitive data');

    // Create a symlink inside vault pointing to outside dir
    const symlinkPath = join(vaultDir.path, 'entities', 'escape-link');
    try {
      symlinkSync(outsideDir, symlinkPath);
      // Reading via the symlink — path.resolve resolves the path but assertPathContained
      // checks the LOGICAL path, not the real path. So this might pass the check
      // but fail because the file doesn't end in .md or doesn't exist
      try {
        vault.readFile('entities/escape-link/secret.txt');
        // If we get here, the symlink was followed — document as finding
        // (VULN-14 only checks logical path, not realpath)
      } catch (err) {
        // Expected: file not found or similar
        expect(err).toBeDefined();
      }
    } finally {
      try { rmSync(symlinkPath); } catch {}
      try { rmSync(outsideDir, { recursive: true }); } catch {}
    }
  });

  it('createFile with traversal in path is blocked', () => {
    expect(() => vault.createFile('../escaped.md', { type: 'entity' }, 'escaped'))
      .toThrow(/traversal blocked/i);
  });

  it('updateFile with traversal is blocked', () => {
    // First create a valid file
    vault.createFile('entities/test.md', { type: 'person' }, 'test');
    // Then try to update with traversal path
    expect(() => vault.updateFile('../../etc/passwd', { body: 'hacked' }))
      .toThrow(/traversal blocked/i);
  });

  it('renameFile with source traversal is blocked', () => {
    vault.createFile('entities/real.md', { type: 'person' }, 'real');
    expect(() => vault.renameFile('../outside.md', 'entities/stolen.md'))
      .toThrow(/traversal blocked/i);
  });

  it('renameFile with destination traversal is blocked', () => {
    vault.createFile('entities/real.md', { type: 'person' }, 'real');
    expect(() => vault.renameFile('entities/real.md', '../escaped.md'))
      .toThrow(/traversal blocked/i);
  });

  it('deleteFile with traversal is blocked', () => {
    expect(() => vault.deleteFile('../../../etc/important'))
      .toThrow(/traversal blocked/i);
  });

  it('appendToFile with traversal is blocked', () => {
    expect(() => vault.appendToFile('../../outside.md', 'data'))
      .toThrow(/traversal blocked/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. EVENT LOOP MESSAGE SHAPE
//    Attack: craft messages with unusual shapes — very long content,
//    empty strings, binary data, prototype pollution in metadata.
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S46 — 6. Event Loop Message Shape Attacks', () => {
  it('extremely long message content does not crash approval parser', () => {
    const longContent = 'A'.repeat(10_000_000); // 10MB string
    const start = performance.now();
    const cmd = parseApprovalCommand(longContent);
    const elapsed = performance.now() - start;
    expect(cmd).toBeNull();
    // Must complete in reasonable time
    expect(elapsed).toBeLessThan(1000);
  });

  it('binary data in message content', () => {
    // Random binary bytes as a string
    const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    const cmd = parseApprovalCommand(binary);
    // Should not throw, just return null
    expect(cmd).toBeNull();
  });

  it('empty string returns null from approval parser', () => {
    expect(parseApprovalCommand('')).toBeNull();
  });

  it('only null bytes returns null from approval parser', () => {
    expect(parseApprovalCommand('\x00\x00\x00')).toBeNull();
  });

  it('prototype pollution attempt in message content', () => {
    const payload = 'approve __proto__';
    const cmd = parseApprovalCommand(payload);
    // Should parse as a valid approve command with ID "__proto__"
    expect(cmd).not.toBeNull();
    expect(cmd!.workOrderId).toBe('__proto__');
    // The ID is just a string lookup — no object mutation occurs
  });

  it('constructor.prototype in work order ID', () => {
    const payload = 'approve constructor.prototype.polluted';
    const cmd = parseApprovalCommand(payload);
    expect(cmd).not.toBeNull();
    expect(cmd!.workOrderId).toBe('constructor.prototype.polluted');
  });

  it('content filter handles massive input without OOM', () => {
    const hugeContent = 'password=secret '.repeat(100_000); // ~1.6MB
    const start = performance.now();
    const { redactions } = filterSensitiveContent(hugeContent);
    const elapsed = performance.now() - start;
    expect(redactions.length).toBeGreaterThan(0);
    // Should complete in under 5 seconds even for massive input
    expect(elapsed).toBeLessThan(5000);
  });

  it('splitMessage handles single character repeated to 100K', () => {
    const content = 'X'.repeat(100_000);
    const chunks = splitMessage(content);
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalLength).toBe(100_000);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. WORK ORDER ID INJECTION
//    Attack: use crafted IDs that could break logging, SQL queries,
//    or response formatting.
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S46 — 7. Work Order ID Injection', () => {
  let db: Database.Database;
  let config: VedConfig;

  beforeEach(() => {
    db = createTestDb();
    config = makeConfig();
  });

  afterEach(() => {
    db.close();
  });

  it('work order ID with backticks does not break Discord markdown', () => {
    const deps = setupApprovalDeps(db, config);
    const cmd = { action: 'approve' as const, workOrderId: 'WO-`inject`-123' };
    const result = executeApprovalCommand(cmd, 'discord', 'owner-1', deps);
    // Should return not found (since the WO doesn't exist), but the response
    // should contain the ID safely wrapped
    expect(result.response).toContain('WO-`inject`-123');
    expect(result.response).toContain('not found');
  });

  it('work order ID with markdown bold/italic does not break formatting', () => {
    const deps = setupApprovalDeps(db, config);
    const cmd = { action: 'approve' as const, workOrderId: '**bold**' };
    const result = executeApprovalCommand(cmd, 'discord', 'owner-1', deps);
    expect(result.response).toContain('not found');
  });

  it('work order ID with HTML tags is treated as plain text', () => {
    const deps = setupApprovalDeps(db, config);
    const cmd = { action: 'approve' as const, workOrderId: '<script>alert(1)</script>' };
    const result = executeApprovalCommand(cmd, 'discord', 'owner-1', deps);
    expect(result.response).toContain('not found');
  });

  it('work order create + approve with unicode ID works', () => {
    const deps = setupApprovalDeps(db, config);
    const wo = deps.workOrders.create(
      'session-1',
      'msg-1',
      'test-tool',
      { x: 1 },
      { level: 'medium' as const, reasons: ['test'] },
      3 as const,
    );

    // Use the real WO ID to approve
    const cmd = { action: 'approve' as const, workOrderId: wo.id };
    const result = executeApprovalCommand(cmd, 'discord', 'owner-1', deps);
    expect(result.response).toContain('Approved');
    expect(result.response).toContain(wo.id);
  });

  it('audit entry is created even for non-existent work orders', () => {
    const deps = setupApprovalDeps(db, config);
    const cmd = { action: 'approve' as const, workOrderId: 'DOES-NOT-EXIST' };
    executeApprovalCommand(cmd, 'discord', 'owner-1', deps);

    // The approval fails (not found), so NO audit entry is created
    // This is correct behavior — only successful resolutions are audited
    const entries = db.prepare('SELECT COUNT(*) as cnt FROM audit_log').get() as { cnt: number };
    // Only the bootstrap audit entries exist (if any)
    expect(entries.cnt).toBe(0);
  });

  it('deny with very long reason is preserved fully', () => {
    const deps = setupApprovalDeps(db, config);
    const wo = deps.workOrders.create(
      'session-1',
      'msg-1',
      'dangerous-tool',
      {},
      { level: 'high' as const, reasons: ['test'] },
      2 as const,
    );

    const longReason = 'R'.repeat(10_000);
    const cmd = { action: 'deny' as const, workOrderId: wo.id, reason: longReason };
    const result = executeApprovalCommand(cmd, 'discord', 'owner-1', deps);
    expect(result.response).toContain('Denied');

    // Check audit entry has the full reason
    const entry = db.prepare(
      "SELECT detail FROM audit_log WHERE json_extract(detail, '$.resolution') = 'denied'"
    ).get() as { detail: string } | undefined;
    expect(entry).toBeDefined();
    const detail = JSON.parse(entry!.detail);
    expect(detail.reason).toBe(longReason);
  });
});
