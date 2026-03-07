/**
 * Session 58 Tests — `ved upgrade` + `ved watch`
 *
 * Tests for version migration management and standalone vault watcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { VedApp, createApp } from '../app.js';
import { migrate, currentVersion, verifyMigrations } from '../db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Helper: create a minimal VedApp with temp dirs for testing.
 */
function createTestApp(): { app: VedApp; tmpDir: string; cleanup: () => void } {
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
      embedding: { model: 'nomic-embed-text', dimensions: 768 },
      search: { vectorTopK: 5, ftsTopK: 5, graphDepth: 1 },
    },
    log: { level: 'error', format: 'text' },
    audit: { hmacSecret: 'test-secret', anchorIntervalMs: 0 },
  } as any);

  const cleanup = () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  };

  return { app, tmpDir, cleanup };
}

// ── Upgrade Status ──

describe('ved upgrade status', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    try { await app.stop(); } catch { /* ignore */ }
    cleanup();
  });

  it('returns current version after construction (migrations auto-applied)', () => {
    const status = app.getUpgradeStatus();
    expect(status.currentVersion).toBeGreaterThanOrEqual(1);
    expect(status.availableVersions).toBeGreaterThanOrEqual(1);
    expect(status.pendingCount).toBe(0); // All applied during construction
    expect(status.dbPath).toBeTruthy();
  });

  it('reports correct available migration count', () => {
    const status = app.getUpgradeStatus();
    // Should match number of v*.sql files
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
    const files = readdirSync(migrationsDir).filter(f => /^v\d{3}_.*\.sql$/.test(f));
    expect(status.availableVersions).toBe(files.length);
  });

  it('reports pending count is 0 when fully migrated', () => {
    const status = app.getUpgradeStatus();
    expect(status.pendingCount).toBe(0);
  });
});

// ── Upgrade Verify ──

describe('ved upgrade verify', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    try { await app.stop(); } catch { /* ignore */ }
    cleanup();
  });

  it('returns empty issues array when migrations are intact', () => {
    const issues = app.verifyMigrations();
    expect(issues).toEqual([]);
  });
});

// ── Upgrade History ──

describe('ved upgrade history', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    try { await app.stop(); } catch { /* ignore */ }
    cleanup();
  });

  it('returns applied migrations with version, filename, checksum', () => {
    const migrations = app.getAppliedMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(1);

    const first = migrations[0];
    expect(first.version).toBe(1);
    expect(first.filename).toMatch(/^v001_/);
    expect(first.appliedAt).toBeGreaterThan(0);
    expect(first.description).toBeTruthy();
  });

  it('migrations are ordered by version', () => {
    const migrations = app.getAppliedMigrations();
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i].version).toBeGreaterThan(migrations[i - 1].version);
    }
  });

  it('all migrations have valid checksums', () => {
    const migrations = app.getAppliedMigrations();
    for (const m of migrations) {
      // v001 may have empty checksum from self-referential INSERT, but after migrate() it should be filled
      expect(m.checksum).toBeTruthy();
      expect(m.checksum.length).toBeGreaterThanOrEqual(10); // hex hash
    }
  });
});

// ── Upgrade Run ──

describe('ved upgrade run', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    try { await app.stop(); } catch { /* ignore */ }
    cleanup();
  });

  it('returns 0 when no pending migrations', () => {
    const applied = app.runMigrations();
    expect(applied).toBe(0);
  });

  it('status shows 0 pending after run', () => {
    app.runMigrations();
    const status = app.getUpgradeStatus();
    expect(status.pendingCount).toBe(0);
  });
});

// ── Watch Mode ──

describe('ved watch (standalone vault watcher)', () => {
  let app: VedApp;
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    tmpDir = result.tmpDir;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    try { await app.stop(); } catch { /* ignore */ }
    cleanup();
  });

  it('app has runWatch method', () => {
    expect(typeof app.runWatch).toBe('function');
  });

  it('channels module is instantiated but not auto-started', () => {
    // VedApp constructor creates channels but doesn't start them
    expect(app.channels).toBeDefined();
  });

  it('vault watcher exists on memory module', () => {
    // Vault manager should exist and have watch capability
    expect(app.memory).toBeDefined();
    expect(typeof app.memory.vault.startWatch).toBe('function');
    expect(typeof app.memory.vault.stopWatch).toBe('function');
  });
});

// ── Completions include new commands ──

describe('completions include upgrade + watch', () => {
  it('bash completions contain upgrade and watch', () => {
    const bash = VedApp.generateCompletions('bash');
    expect(bash).toContain('upgrade');
    expect(bash).toContain('watch');
  });

  it('zsh completions contain upgrade and watch', () => {
    const zsh = VedApp.generateCompletions('zsh');
    expect(zsh).toContain('upgrade');
    expect(zsh).toContain('watch');
    expect(zsh).toContain('Watch vault for changes');
    expect(zsh).toContain('Manage database migrations');
  });

  it('fish completions contain upgrade and watch', () => {
    const fish = VedApp.generateCompletions('fish');
    expect(fish).toContain('upgrade');
    expect(fish).toContain('watch');
  });

  it('bash completions include upgrade subcommands', () => {
    const bash = VedApp.generateCompletions('bash');
    expect(bash).toContain('status run verify history');
  });

  it('zsh completions include upgrade subcommands', () => {
    const zsh = VedApp.generateCompletions('zsh');
    expect(zsh).toContain('status[Show migration status]');
    expect(zsh).toContain('verify[Check migration integrity]');
  });

  it('fish completions include upgrade subcommands', () => {
    const fish = VedApp.generateCompletions('fish');
    expect(fish).toContain("__fish_seen_subcommand_from upgrade");
  });
});

// ── Edge Cases ──

describe('upgrade edge cases', () => {
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    try { await app.stop(); } catch { /* ignore */ }
    cleanup();
  });

  it('getUpgradeStatus returns dbPath from config', () => {
    const status = app.getUpgradeStatus();
    expect(status.dbPath).toContain('ved.db');
  });

  it('runMigrations is idempotent (multiple calls safe)', () => {
    const first = app.runMigrations();
    const second = app.runMigrations();
    expect(first).toBe(0);
    expect(second).toBe(0);
  });

  it('verifyMigrations is idempotent', () => {
    const first = app.verifyMigrations();
    const second = app.verifyMigrations();
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it('getAppliedMigrations returns consistent data across calls', () => {
    const first = app.getAppliedMigrations();
    const second = app.getAppliedMigrations();
    expect(first.length).toBe(second.length);
    expect(first[0].version).toBe(second[0].version);
  });
});
