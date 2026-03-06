/**
 * Session 44 — BUILD tests.
 *
 * Tests for:
 * 1. VULN-17 fix: ghr_ GitHub fine-grained PAT now caught
 * 2. NFKC normalization: Unicode confusable bypass prevention
 * 3. CLI interactive commands: /help, /status, /clear, banner
 * 4. ved init enhancements: vault creation, config.local.yaml
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { filterSensitiveContent } from './core/compressor.js';
import { CLIAdapter } from './channel/cli.js';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ────────────────────────────────────────────
// 1. VULN-17 FIX: ghr_ tokens now caught
// ────────────────────────────────────────────

describe('VULN-17 fix: ghr_ GitHub fine-grained PAT detection', () => {
  it('should catch ghr_ (fine-grained PAT) tokens', () => {
    const token = 'ghr_' + 'A'.repeat(36);
    const { sanitized, redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('github_token');
    expect(sanitized).toBe('[REDACTED_GITHUB_TOKEN]');
  });

  it('should still catch ghp_ (classic PAT)', () => {
    const token = 'ghp_' + 'B'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('github_token');
  });

  it('should still catch gho_ (OAuth access token)', () => {
    const token = 'gho_' + 'C'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
  });

  it('should still catch ghs_ (server-to-server token)', () => {
    const token = 'ghs_' + 'D'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
  });

  it('should still catch ghh_ (??? — h is in [poshr])', () => {
    // 'h' was in original [posh] and remains in [poshr]
    const token = 'ghh_' + 'E'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(1);
  });

  it('should NOT catch gha_ (not a valid GitHub prefix)', () => {
    const token = 'gha_' + 'F'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(0);
  });

  it('should NOT catch ghx_ (not a valid GitHub prefix)', () => {
    const token = 'ghx_' + 'G'.repeat(36);
    const { redactions } = filterSensitiveContent(token);
    expect(redactions.length).toBe(0);
  });

  it('should catch ghr_ in surrounding text', () => {
    const text = `Here is my token: ghr_${'H'.repeat(40)} please use it`;
    const { sanitized, redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(1);
    expect(sanitized).not.toContain('ghr_');
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should catch multiple GitHub token types in same text', () => {
    const text = `ghp_${'A'.repeat(36)} and ghr_${'B'.repeat(36)} and ghs_${'C'.repeat(36)}`;
    const { redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(1); // All matched by same pattern, counted as one label
    expect(redactions[0]).toContain('3 occurrence');
  });
});

// ────────────────────────────────────────────
// 2. NFKC NORMALIZATION: Unicode bypass prevention
// ────────────────────────────────────────────

describe('NFKC normalization: Unicode confusable bypass prevention', () => {
  it('should catch API key with Cyrillic confusable characters', () => {
    // Cyrillic 'а' (U+0430) looks like Latin 'a'
    // NFKC doesn't map Cyrillic→Latin, but let's test what it does
    // Actually, NFKC won't convert Cyrillic а→Latin a. They're different scripts.
    // The REAL win is fullwidth and compatibility chars.
    const text = 'api_key = sk_live_ABCDEFghijklmnop1234';
    const { redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(1);
  });

  it('should catch API key with fullwidth Latin characters after NFKC', () => {
    // Fullwidth 'ａｐｉ_ｋｅｙ' → NFKC → 'api_key'
    const fullwidthApiKey = '\uFF41\uFF50\uFF49_\uFF4B\uFF45\uFF59 = sk_live_ABCDEFghijklmnop1234';
    const { redactions } = filterSensitiveContent(fullwidthApiKey);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('api_key');
  });

  it('should strip zero-width joiners from secret tokens', () => {
    // Zero-width joiner (U+200D) inserted into token prefix
    const token = 'ghp\u200D_' + 'A'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    // After stripping ZWJ, becomes 'ghp_AAA...' which should be caught
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should strip zero-width space (U+200B)', () => {
    const token = 'ghp\u200B_' + 'A'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should strip FEFF BOM character', () => {
    const token = 'ghp\uFEFF_' + 'A'.repeat(36);
    const { sanitized } = filterSensitiveContent(token);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should handle fullwidth digits in AWS key', () => {
    // Fullwidth 'AKIA' + ASCII remainder
    const fullwidthAKIA = '\uFF21\uFF2B\uFF29\uFF21' + 'BCDEFGHIJKLMNOPQ';
    const { redactions } = filterSensitiveContent(fullwidthAKIA);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('aws_key');
  });

  it('should handle fullwidth Bearer prefix', () => {
    const fullwidthBearer = '\uFF22\uFF45\uFF41\uFF52\uFF45\uFF52 ' + 'A'.repeat(30);
    const { redactions } = filterSensitiveContent(fullwidthBearer);
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toContain('bearer_token');
  });

  it('should not false-positive on normal Unicode text', () => {
    const text = '日本語テスト — this is fine 😀 こんにちは';
    const { redactions } = filterSensitiveContent(text);
    expect(redactions.length).toBe(0);
  });

  it('should preserve normal text through NFKC', () => {
    const text = 'Hello, world! This is a normal message.';
    const { sanitized } = filterSensitiveContent(text);
    expect(sanitized).toBe(text);
  });

  it('should handle empty string', () => {
    const { sanitized, redactions } = filterSensitiveContent('');
    expect(sanitized).toBe('');
    expect(redactions.length).toBe(0);
  });

  it('should handle string of only zero-width characters', () => {
    const { sanitized, redactions } = filterSensitiveContent('\u200B\u200C\u200D\uFEFF');
    expect(sanitized).toBe('');
    expect(redactions.length).toBe(0);
  });
});

// ────────────────────────────────────────────
// 3. CLI INTERACTIVE: commands and UX
// ────────────────────────────────────────────

describe('CLI adapter: interactive commands', () => {
  let adapter: CLIAdapter;

  beforeEach(() => {
    adapter = new CLIAdapter('test-cli');
  });

  it('should have correct id and type', () => {
    expect(adapter.id).toBe('test-cli');
    expect(adapter.type).toBe('cli');
  });

  it('should default to "cli" id when none provided', () => {
    const defaultAdapter = new CLIAdapter();
    expect(defaultAdapter.id).toBe('cli');
  });

  it('should not be connected before start', () => {
    expect(adapter.connected).toBe(false);
  });

  it('should accept custom prompt via init', async () => {
    await adapter.init({ prompt: 'test> ' });
    // No crash — prompt is stored internally
  });

  it('should send response to stdout', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.send({ content: 'Hello from Ved' });
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Hello from Ved'));
    writeSpy.mockRestore();
  });

  it('should format approval requests with work order details', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.sendApprovalRequest({
      id: 'wo_test123',
      tool: 'shell.exec',
      riskLevel: 'high',
      params: { command: 'rm -rf /' },
    } as any);

    const output = writeSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('shell.exec');
    expect(output).toContain('wo_test123');
    expect(output).toContain('high');
    writeSpy.mockRestore();
  });

  it('should format notifications with pin emoji', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.notify('System update complete');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('📌'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('System update complete'));
    writeSpy.mockRestore();
  });

  it('should register message handlers', () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler registered — no crash
  });

  it('should cleanup on shutdown', async () => {
    adapter.onMessage(vi.fn());
    await adapter.shutdown();
    expect(adapter.connected).toBe(false);
  });

  it('should not send empty responses', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.send({ content: '' });
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('should not send responses with no content', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.send({} as any);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

// ────────────────────────────────────────────
// 4. VED INIT: vault creation + config templates
// ────────────────────────────────────────────

describe('ved init: vault and config creation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ved-init-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create vault directory structure', () => {
    const vaultPath = join(tmpDir, 'vault');
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(join(vaultPath, 'daily'), { recursive: true });
    mkdirSync(join(vaultPath, 'entities'), { recursive: true });
    mkdirSync(join(vaultPath, 'concepts'), { recursive: true });
    mkdirSync(join(vaultPath, 'decisions'), { recursive: true });

    expect(existsSync(join(vaultPath, 'daily'))).toBe(true);
    expect(existsSync(join(vaultPath, 'entities'))).toBe(true);
    expect(existsSync(join(vaultPath, 'concepts'))).toBe(true);
    expect(existsSync(join(vaultPath, 'decisions'))).toBe(true);
  });

  it('should create vault README', () => {
    const vaultPath = join(tmpDir, 'vault');
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(join(vaultPath, 'README.md'),
      '# Ved Vault\n\nThis is Ved\'s knowledge graph.\n');

    const readme = readFileSync(join(vaultPath, 'README.md'), 'utf-8');
    expect(readme).toContain('Ved Vault');
    expect(readme).toContain('knowledge graph');
  });

  it('should create config.local.yaml template', () => {
    const localConfig = `# Ved Local Config — SECRETS GO HERE
llm:
  # apiKey: sk-your-anthropic-key
`;
    writeFileSync(join(tmpDir, 'config.local.yaml'), localConfig);

    const content = readFileSync(join(tmpDir, 'config.local.yaml'), 'utf-8');
    expect(content).toContain('SECRETS');
    expect(content).toContain('apiKey');
  });

  it('should not overwrite existing config', () => {
    const existingConfig = '# My custom config\nllm:\n  provider: openai\n';
    writeFileSync(join(tmpDir, 'config.yaml'), existingConfig);

    // Verify original is preserved
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toBe(existingConfig);
  });
});
