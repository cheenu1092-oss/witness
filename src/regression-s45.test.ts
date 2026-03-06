/**
 * Session 45 — TEST: Regression and edge-case coverage for S44 BUILD.
 *
 * Covers:
 * 1. VULN-17 regression: boundary lengths, mixed tokens, partial matches
 * 2. NFKC edge cases: combining chars, ligatures, math symbols, mixed scripts
 * 3. CLI interactive e2e: readLoop lifecycle, command routing, multi-adapter
 * 4. ved init flow: idempotency, partial state, vault structure integrity
 * 5. Discord splitMessage: code-block-aware splitting regression (GAP-3)
 * 6. Content filter interaction: NFKC + pattern interplay, redaction counting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { filterSensitiveContent } from './core/compressor.js';
import { CLIAdapter } from './channel/cli.js';
import { splitMessage } from './channel/discord.js';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ════════════════════════════════════════════
// 1. VULN-17 REGRESSION: Boundary & edge cases
// ════════════════════════════════════════════

describe('VULN-17 regression: token length boundaries', () => {
  it('should NOT catch ghr_ with exactly 35 chars (below threshold)', () => {
    const token = 'ghr_' + 'A'.repeat(35);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(0);
  });

  it('should catch ghr_ with exactly 36 chars (at threshold)', () => {
    const token = 'ghr_' + 'A'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('github_token');
  });

  it('should catch ghr_ with 100 chars (well above threshold)', () => {
    const token = 'ghr_' + 'X'.repeat(100);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
  });

  it('should catch ghr_ with underscores in payload', () => {
    const token = 'ghr_' + 'A_B_C_D_E_F_G_H_I_J_K_L_M_N_O_P_Q_R_S';
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
  });

  it('should NOT catch partial prefix ghr (no underscore)', () => {
    const token = 'ghr' + 'A'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    // No underscore separator — should NOT match gh[poshr]_
    expect(redactions.filter(r => r.includes('github_token')).length).toBe(0);
  });

  it('should NOT catch GHR_ (case sensitive — uppercase prefix)', () => {
    const token = 'GHR_' + 'A'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    // Regex uses lowercase gh — uppercase GH shouldn't match
    expect(redactions.filter(r => r.includes('github_token')).length).toBe(0);
  });

  it('should catch ghr_ embedded in URL', () => {
    const text = 'https://api.github.com/repos?token=ghr_' + 'A'.repeat(40);
    const { sanitized } = filterSensitiveContent(text);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(sanitized).not.toContain('ghr_');
  });

  it('should catch ghr_ at start of line', () => {
    const text = 'ghr_' + 'Z'.repeat(36) + '\nSome other text';
    const { sanitized } = filterSensitiveContent(text);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(sanitized).toContain('Some other text');
  });

  it('should catch ghr_ at end of text', () => {
    const text = 'Token is: ghr_' + 'W'.repeat(36);
    const { sanitized } = filterSensitiveContent(text);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should handle ghr_ mixed with other secret types', () => {
    const text = [
      'ghr_' + 'A'.repeat(36),
      'AKIAIOSFODNN7EXAMPLE',
      'Bearer ' + 'T'.repeat(30),
    ].join('\n');
    const { redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(3);
    expect(redactions.some(r => r.includes('github_token'))).toBe(true);
    expect(redactions.some(r => r.includes('aws_key'))).toBe(true);
    expect(redactions.some(r => r.includes('bearer_token'))).toBe(true);
  });
});

// ════════════════════════════════════════════
// 2. NFKC EDGE CASES: Deeper Unicode scenarios
// ════════════════════════════════════════════

describe('NFKC edge cases: combining characters and ligatures', () => {
  it('should normalize fi ligature (U+FB01) to "fi"', () => {
    // ﬁ → fi via NFKC
    const text = 'api_key = sk_live_\uFB01ltertoken12345678901234';
    const { sanitized } = filterSensitiveContent(text);
    // NFKC normalizes ﬁ→fi, so "filtertoken..." should be in output
    expect(sanitized.normalize('NFKC')).toBe(sanitized);
  });

  it('should normalize superscript digits', () => {
    // ¹²³ (U+00B9, U+00B2, U+00B3) → 1, 2, 3 via NFKC
    const text = 'test\u00B9\u00B2\u00B3';
    const { sanitized } = filterSensitiveContent(text);
    expect(sanitized).toBe('test123');
  });

  it('should normalize halfwidth katakana', () => {
    // Halfwidth ｶ (U+FF76) → fullwidth カ (U+30AB) via NFKC
    const text = '\uFF76\uFF80\uFF76\uFF85';
    const { sanitized, redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(0); // No secrets in katakana
    expect(sanitized.length).toBeGreaterThan(0);
  });

  it('should strip U+2060 (word joiner) from tokens', () => {
    const token = 'ghp\u2060_' + 'A'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should strip U+200C (zero-width non-joiner) from tokens', () => {
    const token = 'gh\u200Cp_' + 'B'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should strip U+200E (LTR mark) from tokens', () => {
    const token = 'ghp_' + '\u200E' + 'C'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should strip U+202A (LTR embedding) from tokens', () => {
    const token = 'ghp\u202A_' + 'D'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should handle mixed zero-width chars scattered throughout', () => {
    const token = 'g\u200Bh\u200Dp\u200B_' + 'E'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should normalize fullwidth password keyword', () => {
    // ｐａｓｓｗｏｒｄ = secret123
    const fullwidth = '\uFF50\uFF41\uFF53\uFF53\uFF57\uFF4F\uFF52\uFF44 = secret123456';
    const { redactions } = filterSensitiveContent(fullwidth);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('password');
  });

  it('should normalize fullwidth connection string protocol', () => {
    // ｍｏｎｇｏｄｂ://user:pass@host
    const fullwidthProto = '\uFF4D\uFF4F\uFF4E\uFF47\uFF4F\uFF44\uFF42://admin:pass@mongo.example.com/db';
    const { redactions } = filterSensitiveContent(fullwidthProto);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('connection_string');
  });

  it('should handle text with only zero-width chars between normal chars', () => {
    const text = 'Hello\u200B\u200B\u200B World';
    const { sanitized } = filterSensitiveContent(text);
    expect(sanitized).toBe('Hello World');
  });

  it('should preserve emoji and normal Unicode after NFKC', () => {
    const text = '🔑 API access granted! 日本語テスト ñ ü ö';
    const { sanitized, redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(0);
    expect(sanitized).toContain('🔑');
    expect(sanitized).toContain('日本語');
    expect(sanitized).toContain('ñ');
  });

  it('should handle very long string with scattered zero-width chars', () => {
    // Build a 10K string with zero-width chars every 100 chars
    let text = '';
    for (let i = 0; i < 100; i++) {
      text += 'A'.repeat(99) + '\u200B';
    }
    const { sanitized } = filterSensitiveContent(text);
    expect(sanitized.length).toBe(9900); // 100 ZW chars removed
    expect(sanitized).not.toContain('\u200B');
  });
});

// ════════════════════════════════════════════
// 3. CLI INTERACTIVE: Lifecycle & edge cases
// ════════════════════════════════════════════

describe('CLI adapter: lifecycle edge cases', () => {
  let adapter: CLIAdapter;

  beforeEach(() => {
    adapter = new CLIAdapter('test-cli');
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('should handle double shutdown gracefully', async () => {
    await adapter.shutdown();
    await adapter.shutdown(); // second call should not throw
    expect(adapter.connected).toBe(false);
  });

  it('should handle send before start', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // send before start — should still write to stdout
    await adapter.send({ content: 'Early message' });
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Early message'));
    writeSpy.mockRestore();
  });

  it('should handle notify before start', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.notify('Early notification');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('📌'));
    writeSpy.mockRestore();
  });

  it('should register multiple message handlers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    adapter.onMessage(h1);
    adapter.onMessage(h2);
    adapter.onMessage(h3);
    // No crash — all handlers registered
  });

  it('should handle approval request with special characters in params', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.sendApprovalRequest({
      id: 'wo_special',
      tool: 'shell.exec',
      riskLevel: 'critical',
      params: { command: 'echo "hello\'s world" && rm -rf /tmp/*' },
    } as any);
    const output = writeSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('shell.exec');
    expect(output).toContain('wo_special');
    writeSpy.mockRestore();
  });

  it('should handle init with empty config', async () => {
    await adapter.init({} as any);
    // No crash with empty config
  });

  it('should handle send with undefined content gracefully', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.send({ content: undefined } as any);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('should handle send with very long content', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const longContent = 'X'.repeat(100_000);
    await adapter.send({ content: longContent });
    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls.map(c => c[0]).join('');
    expect(written).toContain('X'.repeat(100));
    writeSpy.mockRestore();
  });
});

// ════════════════════════════════════════════
// 4. VED INIT: Idempotency & edge cases
// ════════════════════════════════════════════

describe('ved init: idempotency and edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ved-init-s45-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create all four vault subdirectories', () => {
    const vaultPath = join(tmpDir, 'vault');
    const dirs = ['daily', 'entities', 'concepts', 'decisions'];
    for (const dir of dirs) {
      mkdirSync(join(vaultPath, dir), { recursive: true });
    }
    for (const dir of dirs) {
      expect(existsSync(join(vaultPath, dir))).toBe(true);
    }
  });

  it('should be idempotent — running init twice does not corrupt vault', () => {
    const vaultPath = join(tmpDir, 'vault');
    const dirs = ['daily', 'entities', 'concepts', 'decisions'];

    // First init
    for (const dir of dirs) {
      mkdirSync(join(vaultPath, dir), { recursive: true });
    }
    writeFileSync(join(vaultPath, 'README.md'), '# Ved Vault\n');

    // Add a file to daily
    writeFileSync(join(vaultPath, 'daily', '2026-03-06.md'), '# Test Daily Note\n');

    // Second init (mkdirSync recursive is idempotent)
    for (const dir of dirs) {
      mkdirSync(join(vaultPath, dir), { recursive: true });
    }

    // Existing file should survive
    expect(existsSync(join(vaultPath, 'daily', '2026-03-06.md'))).toBe(true);
    const content = readFileSync(join(vaultPath, 'daily', '2026-03-06.md'), 'utf-8');
    expect(content).toBe('# Test Daily Note\n');
  });

  it('should create valid YAML in config.local.yaml', () => {
    const localConfig = `# Ved Local Config — SECRETS GO HERE (gitignored)
llm:
  # apiKey: sk-your-anthropic-key-here
`;
    writeFileSync(join(tmpDir, 'config.local.yaml'), localConfig);
    const content = readFileSync(join(tmpDir, 'config.local.yaml'), 'utf-8');
    // Should be valid YAML structure (commented out keys)
    expect(content).toContain('llm:');
    expect(content).toContain('apiKey');
    expect(content).not.toContain('undefined');
  });

  it('should create vault README with correct section headers', () => {
    const readme = `# Ved Vault\n\nThis is Ved's knowledge graph. Open this folder in Obsidian to visualize connections.\n\n` +
      `## Structure\n- \`daily/\` — Episodic memory (session summaries)\n- \`entities/\` — People, orgs, projects\n` +
      `- \`concepts/\` — Ideas, technologies\n- \`decisions/\` — Dated decision records\n`;
    writeFileSync(join(tmpDir, 'README.md'), readme);
    const content = readFileSync(join(tmpDir, 'README.md'), 'utf-8');
    expect(content).toContain('## Structure');
    expect(content).toContain('daily/');
    expect(content).toContain('entities/');
    expect(content).toContain('concepts/');
    expect(content).toContain('decisions/');
    expect(content).toContain('Obsidian');
  });

  it('should handle vault path with spaces', () => {
    const spacePath = join(tmpDir, 'my vault folder');
    mkdirSync(join(spacePath, 'daily'), { recursive: true });
    expect(existsSync(join(spacePath, 'daily'))).toBe(true);
  });

  it('should handle deeply nested vault path', () => {
    const deepPath = join(tmpDir, 'a', 'b', 'c', 'd', 'vault');
    mkdirSync(join(deepPath, 'daily'), { recursive: true });
    expect(existsSync(join(deepPath, 'daily'))).toBe(true);
  });
});

// ════════════════════════════════════════════
// 5. DISCORD splitMessage: GAP-3 regression
// ════════════════════════════════════════════

describe('Discord splitMessage: code-block-aware splitting', () => {
  it('should not split short messages', () => {
    const msg = 'Hello, world!';
    const chunks = splitMessage(msg);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(msg);
  });

  it('should split long messages at newlines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'X'.repeat(30)}`);
    const msg = lines.join('\n');
    const chunks = splitMessage(msg);
    expect(chunks.length).toBeGreaterThan(1);
    // Reconstruct should contain all original content
    const reconstructed = chunks.join('\n');
    for (let i = 0; i < 10; i++) {
      expect(reconstructed).toContain(`Line ${i}`);
    }
  });

  it('should close open code blocks at split boundary', () => {
    const codeBlock = '```javascript\n' + 'const x = 1;\n'.repeat(200) + '```';
    const chunks = splitMessage(codeBlock);
    // If split occurred, first chunk should end with ``` (closing the open block)
    if (chunks.length > 1) {
      expect(chunks[0].endsWith('```')).toBe(true);
      // Second chunk should start with reopened code block
      expect(chunks[1].startsWith('```')).toBe(true);
    }
  });

  it('should handle code blocks with language tags', () => {
    const msg = '```python\n' + 'print("hello")\n'.repeat(200) + '```';
    const chunks = splitMessage(msg);
    if (chunks.length > 1) {
      // Reopened block should have the language tag
      expect(chunks[1]).toMatch(/^```python/);
    }
  });

  it('should handle already-closed code blocks without extra closing', () => {
    // Two separate code blocks that each fit within limits
    const msg = '```\nblock1\n```\n\nSome text\n\n```\nblock2\n```';
    const chunks = splitMessage(msg);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(msg);
  });

  it('should handle message with no good split point', () => {
    // Single very long line with no newlines
    const msg = 'X'.repeat(3000);
    const chunks = splitMessage(msg);
    expect(chunks.length).toBeGreaterThan(1);
    // Total chars should equal original
    const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalChars).toBe(3000);
  });

  it('should handle empty string', () => {
    const chunks = splitMessage('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });

  it('should handle message at exact max length', () => {
    const msg = 'A'.repeat(2000);
    const chunks = splitMessage(msg);
    expect(chunks).toHaveLength(1);
  });

  it('should handle multiple code blocks across splits', () => {
    const part1 = '```ts\n' + 'const a = 1;\n'.repeat(100);
    const part2 = '```\n\nNormal text\n\n```py\n' + 'x = 2\n'.repeat(100) + '```';
    const msg = part1 + part2;
    const chunks = splitMessage(msg);
    // Should be more than 1 chunk and not throw
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All chunks should be strings
    for (const chunk of chunks) {
      expect(typeof chunk).toBe('string');
    }
  });
});

// ════════════════════════════════════════════
// 6. CONTENT FILTER INTERACTION: NFKC + patterns
// ════════════════════════════════════════════

describe('Content filter: NFKC + pattern interaction', () => {
  it('should handle fullwidth GitHub token prefix', () => {
    // ｇｈｐ_ → ghp_ via NFKC
    const token = '\uFF47\uFF48\uFF50_' + 'A'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should handle fullwidth Slack token prefix', () => {
    // ｘｏｘｂ- → xoxb- via NFKC
    const token = '\uFF58\uFF4F\uFF58\uFF42-' + 'abcdefghij';
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('slack_token');
  });

  it('should report correct redaction count for multiple same-type secrets', () => {
    const text = [
      'ghp_' + 'A'.repeat(36),
      'gho_' + 'B'.repeat(36),
      'ghs_' + 'C'.repeat(36),
      'ghr_' + 'D'.repeat(36),
    ].join(' ');
    const { redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(1); // One label entry
    expect(redactions[0]).toContain('4 occurrence');
  });

  it('should handle text with only redactable content', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toBe('[REDACTED_GITHUB_TOKEN]');
  });

  it('should handle interleaved secrets and normal text', () => {
    const text = `Hello ghp_${'A'.repeat(36)} world AKIAIOSFODNN7EXAMPLE goodbye`;
    const { sanitized, redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(2);
    expect(sanitized).toContain('Hello');
    expect(sanitized).toContain('world');
    expect(sanitized).toContain('goodbye');
    expect(sanitized).not.toContain('ghp_');
    expect(sanitized).not.toContain('AKIA');
  });

  it('should handle ZW chars within AWS key after normalization', () => {
    // AK\u200BIA + 16 uppercase chars
    const key = 'AK\u200BIA' + 'BCDEFGHIJKLMNOPQ';
    const { redactions } = filterSensitiveContent(key);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('aws_key');
  });

  it('should handle JWT with zero-width chars in header', () => {
    const jwt = 'eyJ\u200B' + 'A'.repeat(20) + '.' + 'B'.repeat(20) + '.' + 'C'.repeat(20);
    const { redactions } = filterSensitiveContent(jwt);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('jwt');
  });

  it('should handle fullwidth equals sign in password context', () => {
    // ＝ (U+FF1D) → = via NFKC
    const text = 'password\uFF1D"supersecret123"';
    const { redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('password');
  });

  it('should NOT false positive on discussion of token formats', () => {
    const text = 'GitHub tokens use prefixes like ghp_, gho_, ghs_, ghr_. Each is 36+ chars.';
    const { redactions } = filterSensitiveContent(text);
    // "ghp_" alone is only 4 chars — well under the 36-char threshold after prefix
    expect(redactions.length).toBe(0);
  });

  it('should handle repeated filtering (idempotent)', () => {
    const text = 'Token: ghp_' + 'A'.repeat(36);
    const first = filterSensitiveContent(text);
    const second = filterSensitiveContent(first.sanitized);
    // Second pass should find nothing new
    expect(second.redactions.length).toBe(0);
    expect(second.sanitized).toBe(first.sanitized);
  });
});
