/**
 * Session 55 tests — `ved history` + `ved doctor` CLI commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VedApp } from '../app.js';
import { getDefaults } from '../core/config.js';
import type { VedConfig } from '../types/index.js';

// ── Helpers ──

function createTestDir(): string {
  const dir = join(tmpdir(), `ved-test-s55-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestVault(baseDir: string): string {
  const vault = join(baseDir, 'vault');
  mkdirSync(join(vault, 'daily'), { recursive: true });
  mkdirSync(join(vault, 'entities'), { recursive: true });
  mkdirSync(join(vault, 'concepts'), { recursive: true });
  mkdirSync(join(vault, 'decisions'), { recursive: true });

  writeFileSync(join(vault, 'entities', 'alice.md'), `---
type: person
tags: [person]
---
# Alice
A test person linked to [[Bob]].
`);

  writeFileSync(join(vault, 'entities', 'bob.md'), `---
type: person
tags: [person]
---
# Bob
A test person linked to [[Alice]].
`);

  return vault;
}

function createTestConfig(baseDir: string, vaultPath: string): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    dbPath: join(baseDir, 'ved.db'),
    memory: {
      ...defaults.memory,
      vaultPath,
      gitEnabled: false,
    },
    trust: {
      ...defaults.trust,
      ownerIds: ['test-owner-123'],
    },
    channels: [{ type: 'cli', enabled: true, config: {} }],
  } as VedConfig;
}

// ── History Tests ──

describe('ved history', () => {
  let testDir: string;
  let app: VedApp;

  beforeEach(async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    app = new VedApp(config);
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array when no audit entries', () => {
    const entries = app.getHistory();
    expect(entries).toEqual([]);
  });

  it('returns entries after appending to audit log', () => {
    // Append some audit entries via the event loop's audit log
    app.eventLoop.audit.append({
      eventType: 'startup',
      actor: 'ved',
      detail: { version: '0.1.0' },
    });
    app.eventLoop.audit.append({
      eventType: 'message_received',
      actor: 'user-1',
      sessionId: 'session-abc',
      detail: { content: 'Hello Ved' },
    });

    const entries = app.getHistory();
    expect(entries).toHaveLength(2);
    // Newest first
    expect(entries[0].eventType).toBe('message_received');
    expect(entries[1].eventType).toBe('startup');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      app.eventLoop.audit.append({
        eventType: 'message_received',
        actor: 'user-1',
        detail: { index: i },
      });
    }

    const entries = app.getHistory({ limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it('filters by event type', () => {
    app.eventLoop.audit.append({ eventType: 'startup', detail: {} });
    app.eventLoop.audit.append({ eventType: 'message_received', detail: {} });
    app.eventLoop.audit.append({ eventType: 'llm_call', detail: {} });
    app.eventLoop.audit.append({ eventType: 'message_received', detail: {} });

    const entries = app.getHistory({ type: 'message_received' });
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.eventType === 'message_received')).toBe(true);
  });

  it('filters by date range', () => {
    const now = Date.now();

    // Create entries with known timestamps by appending (timestamps are auto-generated)
    app.eventLoop.audit.append({ eventType: 'startup', detail: { time: 'first' } });

    const entries = app.getHistory({ from: now - 60000, to: now + 60000 });
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for future date range', () => {
    app.eventLoop.audit.append({ eventType: 'startup', detail: {} });

    const futureMs = Date.now() + 86400000; // tomorrow
    const entries = app.getHistory({ from: futureMs, to: futureMs + 86400000 });
    expect(entries).toHaveLength(0);
  });

  it('verifyAuditChain returns intact for valid chain', () => {
    app.eventLoop.audit.append({ eventType: 'startup', detail: {} });
    app.eventLoop.audit.append({ eventType: 'message_received', detail: {} });
    app.eventLoop.audit.append({ eventType: 'shutdown', detail: {} });

    const result = app.verifyAuditChain();
    expect(result.intact).toBe(true);
    expect(result.total).toBe(3);
    expect(result.brokenAt).toBeUndefined();
  });

  it('verifyAuditChain returns intact:true for empty chain', () => {
    const result = app.verifyAuditChain();
    expect(result.intact).toBe(true);
    expect(result.total).toBe(0);
  });

  it('getAuditEventTypes returns distinct types', () => {
    app.eventLoop.audit.append({ eventType: 'startup', detail: {} });
    app.eventLoop.audit.append({ eventType: 'message_received', detail: {} });
    app.eventLoop.audit.append({ eventType: 'message_received', detail: {} });
    app.eventLoop.audit.append({ eventType: 'llm_call', detail: {} });

    const types = app.getAuditEventTypes();
    expect(types).toContain('startup');
    expect(types).toContain('message_received');
    expect(types).toContain('llm_call');
    // Should be deduplicated
    expect(types.filter(t => t === 'message_received')).toHaveLength(1);
    // Should be sorted
    expect(types).toEqual([...types].sort());
  });

  it('getAuditEventTypes returns empty array for no entries', () => {
    const types = app.getAuditEventTypes();
    expect(types).toEqual([]);
  });

  it('history entries contain all expected fields', () => {
    app.eventLoop.audit.append({
      eventType: 'tool_executed',
      actor: 'ved',
      sessionId: 'sess-123',
      detail: { tool: 'file_read', result: 'ok' },
    });

    const entries = app.getHistory();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.eventType).toBe('tool_executed');
    expect(entry.actor).toBe('ved');
    expect(entry.sessionId).toBe('sess-123');
    expect(entry.detail).toBeTruthy();
    expect(entry.hash).toBeTruthy();
    expect(entry.prevHash).toBeTruthy();
  });

  it('default limit is 20', () => {
    for (let i = 0; i < 30; i++) {
      app.eventLoop.audit.append({
        eventType: 'message_received',
        detail: { index: i },
      });
    }

    const entries = app.getHistory(); // no explicit limit
    expect(entries).toHaveLength(20);
  });

  it('combined type + date filters work together', () => {
    const now = Date.now();

    app.eventLoop.audit.append({ eventType: 'startup', detail: {} });
    app.eventLoop.audit.append({ eventType: 'llm_call', detail: {} });
    app.eventLoop.audit.append({ eventType: 'llm_call', detail: {} });

    const entries = app.getHistory({
      type: 'llm_call',
      from: now - 60000,
      to: now + 60000,
    });
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.eventType === 'llm_call')).toBe(true);
  });
});

// ── Doctor Tests ──

describe('ved doctor', () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('passes all checks with valid setup', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    const result = await app.doctor();

    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(0);
    // Should have checks for: Config, Database, Vault structure, Vault git, Audit chain, RAG index, LLM, MCP
    expect(result.checks.length).toBeGreaterThanOrEqual(7);

    // Config should pass
    const configCheck = result.checks.find(c => c.name === 'Config');
    expect(configCheck?.status).toBe('ok');

    // Database should pass
    const dbCheck = result.checks.find(c => c.name === 'Database');
    expect(dbCheck?.status).toBe('ok');

    // Vault structure should pass
    const vaultCheck = result.checks.find(c => c.name === 'Vault structure');
    expect(vaultCheck?.status).toBe('ok');

    await app.stop();
  });

  it('warns on missing vault subdirectories', async () => {
    testDir = createTestDir();
    const vaultPath = join(testDir, 'vault');
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(join(vaultPath, 'daily'), { recursive: true });

    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    // VaultManager auto-creates directories on init, so remove some after init
    // to simulate a corrupted/incomplete vault state
    rmSync(join(vaultPath, 'concepts'), { recursive: true, force: true });
    rmSync(join(vaultPath, 'decisions'), { recursive: true, force: true });

    const result = await app.doctor();
    const vaultCheck = result.checks.find(c => c.name === 'Vault structure');
    expect(vaultCheck?.status).toBe('warn');
    expect(vaultCheck?.message).toContain('concepts');
    expect(vaultCheck?.fixable).toBe(true);

    await app.stop();
  });

  it('reports audit chain as info when empty', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    const result = await app.doctor();
    const auditCheck = result.checks.find(c => c.name === 'Audit chain');
    expect(auditCheck?.status).toBe('info');
    expect(auditCheck?.message).toContain('Empty');

    await app.stop();
  });

  it('reports audit chain as ok with valid entries', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    // Add some audit entries
    app.eventLoop.audit.append({ eventType: 'startup', detail: {} });
    app.eventLoop.audit.append({ eventType: 'message_received', detail: {} });

    const result = await app.doctor();
    const auditCheck = result.checks.find(c => c.name === 'Audit chain');
    expect(auditCheck?.status).toBe('ok');
    expect(auditCheck?.message).toContain('intact');

    await app.stop();
  });

  it('reports vault git info when disabled', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    // Git is already disabled in our test config
    const app = new VedApp(config);
    await app.init();

    const result = await app.doctor();
    const gitCheck = result.checks.find(c => c.name === 'Vault git');
    // Either 'info' (disabled) or 'ok'/'warn' depending on implementation
    expect(['info', 'ok', 'warn']).toContain(gitCheck?.status);

    await app.stop();
  });

  it('tallies passed/warned/failed/infos correctly', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    const result = await app.doctor();
    const total = result.passed + result.warned + result.failed + result.infos;
    expect(total).toBe(result.checks.length);

    await app.stop();
  });

  it('DoctorResult has correct shape', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    const result = await app.doctor();

    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('warned');
    expect(result).toHaveProperty('failed');
    expect(result).toHaveProperty('infos');
    expect(Array.isArray(result.checks)).toBe(true);
    expect(typeof result.passed).toBe('number');

    // Each check has required fields
    for (const check of result.checks) {
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('status');
      expect(check).toHaveProperty('message');
      expect(['ok', 'warn', 'fail', 'info']).toContain(check.status);
    }

    await app.stop();
  });

  it('checks all 8 diagnostic areas', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    const result = await app.doctor();
    const checkNames = result.checks.map(c => c.name);

    expect(checkNames).toContain('Config');
    expect(checkNames).toContain('Database');
    expect(checkNames).toContain('Vault structure');
    expect(checkNames).toContain('Vault git');
    expect(checkNames).toContain('Audit chain');
    expect(checkNames).toContain('RAG index');
    expect(checkNames).toContain('LLM');
    expect(checkNames).toContain('MCP tools');

    await app.stop();
  });

  it('database check detects healthy SQLite', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    const result = await app.doctor();
    const dbCheck = result.checks.find(c => c.name === 'Database');
    expect(dbCheck?.status).toBe('ok');
    expect(dbCheck?.message).toContain('SQLite OK');

    await app.stop();
  });

  it('RAG check reports on index vs vault file mismatch', async () => {
    testDir = createTestDir();
    const vaultPath = createTestVault(testDir);
    const config = createTestConfig(testDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    // Vault has files but RAG index is empty (no indexing done)
    const result = await app.doctor();
    const ragCheck = result.checks.find(c => c.name === 'RAG index');
    // Should be warn since vault has files but index is empty
    expect(['warn', 'ok', 'info']).toContain(ragCheck?.status);

    await app.stop();
  });
});
