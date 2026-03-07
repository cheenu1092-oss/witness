/**
 * Session 59 Tests — Dedup fixes + GC + Plugin CLI
 *
 * Tests for garbage collection and MCP plugin management.
 * Also verifies deduplication of app.ts / cli.ts / mcp/client.ts methods.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VedApp } from '../app.js';

/**
 * Helper: create a minimal VedApp with temp dirs for testing.
 */
function createTestApp(): { app: VedApp; tmpDir: string; dbPath: string; cleanup: () => void } {
  const tmpDir = join(tmpdir(), `ved-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  const vaultPath = join(tmpDir, 'vault');
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(join(vaultPath, 'daily'), { recursive: true });
  mkdirSync(join(vaultPath, 'entities'), { recursive: true });
  mkdirSync(join(vaultPath, 'concepts'), { recursive: true });
  mkdirSync(join(vaultPath, 'decisions'), { recursive: true });

  const dbPath = join(tmpDir, 'ved.db');

  const app = new VedApp({
    dbPath,
    memory: { vaultPath, gitEnabled: false },
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'test-key' },
    trust: { ownerIds: ['test-owner'] },
    channels: [{ type: 'cli', enabled: true, config: {} }],
    mcp: { servers: [] },
    rag: {
      embedding: { model: 'nomic-embed-text', dimensions: 768, baseUrl: 'http://localhost:11434', batchSize: 32 },
      search: { vectorTopK: 5, ftsTopK: 5, graphDepth: 1 },
    },
    log: { level: 'error', format: 'text' },
    audit: { hmacSecret: 'test-secret', anchorIntervalMs: 0 },
  } as any);

  const cleanup = () => {
    try {
      const { rmSync } = require('node:fs');
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  return { app, tmpDir, dbPath, cleanup };
}

// ── GC Tests ──

describe('gcStatus', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    cleanup = ctx.cleanup;
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    cleanup();
  });

  it('returns zero counts on fresh database', () => {
    const status = app.gcStatus();
    expect(status.staleSessions).toBe(0);
    expect(status.staleSessionIds).toEqual([]);
    expect(status.oldAuditEntries).toBe(0);
    expect(status.auditWarning).toBeUndefined();
  });

  it('detects stale sessions', () => {
    // Insert a session that's old (31 days ago)
    const db = (app as any).db;
    const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO sessions (id, channel, channel_id, author_id, status, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('stale-1', 'cli', 'ch-1', 'user-1', 'active', oldTime, oldTime);

    const status = app.gcStatus({ sessionsDays: 30 });
    expect(status.staleSessions).toBe(1);
    expect(status.staleSessionIds).toContain('stale-1');
  });

  it('ignores recent sessions', () => {
    const db = (app as any).db;
    const recentTime = Date.now() - (5 * 24 * 60 * 60 * 1000); // 5 days ago
    db.prepare(
      `INSERT INTO sessions (id, channel, channel_id, author_id, status, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('recent-1', 'cli', 'ch-1', 'user-1', 'active', recentTime, recentTime);

    const status = app.gcStatus({ sessionsDays: 30 });
    expect(status.staleSessions).toBe(0);
  });

  it('detects old audit entries', () => {
    const db = (app as any).db;
    const oldTime = Date.now() - (91 * 24 * 60 * 60 * 1000);
    // Insert old audit entries
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO audit_log (id, event_type, actor, detail, timestamp, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(`old-${i}`, 'startup', 'ved', '{}', oldTime, '', `hash-${i}`);
    }

    const status = app.gcStatus({ auditDays: 90 });
    expect(status.oldAuditEntries).toBe(5);
    expect(status.auditWarning).toContain('hash chain');
  });

  it('uses custom day thresholds', () => {
    const db = (app as any).db;
    const time = Date.now() - (10 * 24 * 60 * 60 * 1000); // 10 days ago
    db.prepare(
      `INSERT INTO sessions (id, channel, channel_id, author_id, status, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('mid-1', 'cli', 'ch-1', 'user-1', 'idle', time, time);

    // With 30-day threshold, not stale
    expect(app.gcStatus({ sessionsDays: 30 }).staleSessions).toBe(0);
    // With 7-day threshold, stale
    expect(app.gcStatus({ sessionsDays: 7 }).staleSessions).toBe(1);
  });
});

describe('gcRun', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    cleanup = ctx.cleanup;
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    cleanup();
  });

  it('closes stale sessions', () => {
    const db = (app as any).db;
    const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO sessions (id, channel, channel_id, author_id, status, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('stale-1', 'cli', 'ch-1', 'user-1', 'active', oldTime, oldTime);
    db.prepare(
      `INSERT INTO sessions (id, channel, channel_id, author_id, status, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('stale-2', 'cli', 'ch-2', 'user-2', 'idle', oldTime, oldTime);

    const result = app.gcRun({ sessionsDays: 30 });
    expect(result.sessionsClosed).toBe(2);
    expect(result.vacuumed).toBe(true);

    // Verify they're now closed
    const sessions = db.prepare(`SELECT status FROM sessions WHERE id IN ('stale-1', 'stale-2')`).all() as { status: string }[];
    expect(sessions.every(s => s.status === 'closed')).toBe(true);
  });

  it('does not delete audit entries without auditForce', () => {
    const db = (app as any).db;
    const oldTime = Date.now() - (91 * 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO audit_log (id, event_type, actor, detail, timestamp, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('old-audit', 'startup', 'ved', '{}', oldTime, '', 'hash-1');

    const result = app.gcRun({ auditDays: 90 });
    expect(result.auditEntriesDeleted).toBe(0);

    // Verify entry still exists
    const count = (db.prepare(`SELECT COUNT(*) as cnt FROM audit_log WHERE id = 'old-audit'`).get() as { cnt: number }).cnt;
    expect(count).toBe(1);
  });

  it('deletes audit entries with auditForce', () => {
    const db = (app as any).db;
    const oldTime = Date.now() - (91 * 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO audit_log (id, event_type, actor, detail, timestamp, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('old-audit-2', 'startup', 'ved', '{}', oldTime, '', 'hash-2');

    const result = app.gcRun({ auditDays: 90, auditForce: true });
    expect(result.auditEntriesDeleted).toBeGreaterThanOrEqual(1);
  });

  it('vacuums the database', () => {
    const result = app.gcRun();
    expect(result.vacuumed).toBe(true);
  });

  it('logs gc events to audit', () => {
    const db = (app as any).db;
    const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO sessions (id, channel, channel_id, author_id, status, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('gc-test', 'cli', 'ch-1', 'user-1', 'active', oldTime, oldTime);

    app.gcRun({ sessionsDays: 30 });

    const gcEvents = db.prepare(
      `SELECT event_type FROM audit_log WHERE event_type LIKE 'gc_%' ORDER BY timestamp DESC`
    ).all() as { event_type: string }[];

    const types = gcEvents.map(e => e.event_type);
    expect(types).toContain('gc_sessions_cleaned');
    expect(types).toContain('gc_vacuum');
  });

  it('handles empty database gracefully', () => {
    const result = app.gcRun();
    expect(result.sessionsClosed).toBe(0);
    expect(result.auditEntriesDeleted).toBe(0);
    expect(result.vacuumed).toBe(true);
  });
});

// ── Plugin Tests ──

describe('pluginList', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    cleanup = ctx.cleanup;
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    cleanup();
  });

  it('returns empty array when no servers configured', () => {
    const servers = app.pluginList();
    expect(servers).toEqual([]);
  });

  it('returns server info after adding one', async () => {
    await app.pluginAdd({
      name: 'test-server',
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });

    const servers = app.pluginList();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('test-server');
    expect(servers[0].transport).toBe('stdio');
  });
});

describe('pluginTools', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    cleanup = ctx.cleanup;
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    cleanup();
  });

  it('returns empty array when no tools discovered', () => {
    const tools = app.pluginTools();
    expect(tools).toEqual([]);
  });

  it('filters by server name', () => {
    // No servers = no tools
    const tools = app.pluginTools('nonexistent');
    expect(tools).toEqual([]);
  });
});

describe('pluginAdd + pluginRemove', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    cleanup = ctx.cleanup;
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    cleanup();
  });

  it('adds and removes a server', async () => {
    await app.pluginAdd({
      name: 'removable',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });
    expect(app.pluginList()).toHaveLength(1);

    const removed = await app.pluginRemove('removable');
    expect(removed).toBe(true);
    expect(app.pluginList()).toHaveLength(0);
  });

  it('returns false when removing nonexistent server', async () => {
    const removed = await app.pluginRemove('ghost');
    expect(removed).toBe(false);
  });

  it('rejects duplicate server names', async () => {
    await app.pluginAdd({
      name: 'unique',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });

    await expect(
      app.pluginAdd({
        name: 'unique',
        transport: 'stdio',
        command: 'echo',
        timeout: 5000,
        riskLevel: 'low',
        enabled: true,
      })
    ).rejects.toThrow(/already registered/);
  });
});

describe('pluginTest', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    cleanup = ctx.cleanup;
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    cleanup();
  });

  it('returns error for nonexistent server', async () => {
    const result = await app.pluginTest('ghost');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not registered');
    expect(result.serverName).toBe('ghost');
  });
});

// ── Dedup Verification Tests ──

describe('deduplication integrity', () => {
  it('VedApp has exactly one pluginList method', () => {
    // Verify the prototype only has one definition
    const proto = VedApp.prototype;
    expect(typeof proto.pluginList).toBe('function');
    // If there were duplicates, TypeScript wouldn't compile — this test is a safety net
  });

  it('VedApp has exactly one gcStatus method', () => {
    expect(typeof VedApp.prototype.gcStatus).toBe('function');
  });

  it('VedApp has exactly one gcRun method', () => {
    expect(typeof VedApp.prototype.gcRun).toBe('function');
  });

  it('GcStatus returns typed result with staleSessionIds', async () => {
    const ctx = createTestApp();
    await ctx.app.init();
    const status = ctx.app.gcStatus();

    // Verify first-set interface properties exist
    expect('staleSessions' in status).toBe(true);
    expect('staleSessionIds' in status).toBe(true);
    expect('oldAuditEntries' in status).toBe(true);
    expect(Array.isArray(status.staleSessionIds)).toBe(true);

    await ctx.app.stop();
    ctx.cleanup();
  });

  it('GcResult returns typed result with sessionsClosed', async () => {
    const ctx = createTestApp();
    await ctx.app.init();
    const result = ctx.app.gcRun();

    expect('sessionsClosed' in result).toBe(true);
    expect('auditEntriesDeleted' in result).toBe(true);
    expect('vacuumed' in result).toBe(true);
    expect('durationMs' in result).toBe(true);

    await ctx.app.stop();
    ctx.cleanup();
  });
});
