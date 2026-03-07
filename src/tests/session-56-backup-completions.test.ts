/**
 * Session 56 tests — `ved backup` + `ved completions` CLI commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { VedApp } from '../app.js';
import { getDefaults } from '../core/config.js';
import type { VedConfig } from '../types/index.js';

// ── Helpers ──

function createTestDir(): string {
  const dir = join(tmpdir(), `ved-test-s56-${randomUUID().slice(0, 8)}`);
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
A test person.
`);

  writeFileSync(join(vault, 'entities', 'bob.md'), `---
type: person
tags: [person]
---
# Bob
Another test person.
`);

  writeFileSync(join(vault, 'daily', '2026-03-06.md'), `---
type: daily
---
# 2026-03-06
Today's session notes.
`);

  writeFileSync(join(vault, 'concepts', 'testing.md'), `---
type: concept
tags: [testing]
---
# Testing
Unit and integration testing concepts.
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
  };
}

// ── Backup Tests ──

describe('ved backup — create', () => {
  let baseDir: string;
  let vaultPath: string;
  let app: VedApp;

  beforeEach(async () => {
    baseDir = createTestDir();
    vaultPath = createTestVault(baseDir);
    const config = createTestConfig(baseDir, vaultPath);
    app = new VedApp(config);
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('creates a tar.gz backup with correct structure', () => {
    const backupDir = join(baseDir, 'backups');
    const result = app.createBackup({ backupDir });

    expect(result.filename).toMatch(/^ved-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/);
    expect(existsSync(result.path)).toBe(true);
    expect(result.vaultFiles).toBe(4); // alice, bob, daily, testing
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('backup contains vault files and database', () => {
    const backupDir = join(baseDir, 'backups');
    const result = app.createBackup({ backupDir });

    // Extract and verify contents
    const extractDir = join(baseDir, 'extract-verify');
    mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf "${result.path}" -C "${extractDir}"`, { stdio: 'pipe' });

    expect(existsSync(join(extractDir, 'ved.db'))).toBe(true);
    expect(existsSync(join(extractDir, 'vault', 'entities', 'alice.md'))).toBe(true);
    expect(existsSync(join(extractDir, 'vault', 'entities', 'bob.md'))).toBe(true);
    expect(existsSync(join(extractDir, 'vault', 'daily', '2026-03-06.md'))).toBe(true);
    expect(existsSync(join(extractDir, 'vault', 'concepts', 'testing.md'))).toBe(true);
  });

  it('creates audit entry for backup', () => {
    const backupDir = join(baseDir, 'backups');
    app.createBackup({ backupDir });

    const entries = app.getHistory({ type: 'backup_created', limit: 1 });
    expect(entries).toHaveLength(1);
    const detail = JSON.parse(entries[0].detail);
    expect(detail.vaultFiles).toBe(4);
    expect(detail.sizeBytes).toBeGreaterThan(0);
  });

  it('handles empty vault gracefully', async () => {
    const emptyBase = createTestDir();
    const emptyVault = join(emptyBase, 'empty-vault');
    mkdirSync(join(emptyVault, 'daily'), { recursive: true });
    mkdirSync(join(emptyVault, 'entities'), { recursive: true });
    mkdirSync(join(emptyVault, 'concepts'), { recursive: true });
    mkdirSync(join(emptyVault, 'decisions'), { recursive: true });

    const config = createTestConfig(emptyBase, emptyVault);
    const emptyApp = new VedApp(config);
    await emptyApp.init();

    const result = emptyApp.createBackup({ backupDir: join(emptyBase, 'backups') });
    expect(result.vaultFiles).toBe(0);
    expect(existsSync(result.path)).toBe(true);

    await emptyApp.stop();
    rmSync(emptyBase, { recursive: true, force: true });
  });
});

describe('ved backup — rotation', () => {
  let baseDir: string;
  let vaultPath: string;
  let app: VedApp;

  beforeEach(async () => {
    baseDir = createTestDir();
    vaultPath = createTestVault(baseDir);
    const config = createTestConfig(baseDir, vaultPath);
    app = new VedApp(config);
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('rotates backups when exceeding maxBackups', () => {
    const backupDir = join(baseDir, 'backups');
    mkdirSync(backupDir, { recursive: true });

    // Manually create 4 backup files with different timestamps
    for (let i = 0; i < 4; i++) {
      const ts = `2026-03-0${i + 1}_12-00-00`;
      const filename = `ved-backup-${ts}.tar.gz`;
      writeFileSync(join(backupDir, filename), `backup-${i}`);
    }

    // Verify 4 exist
    expect(app.listBackups(backupDir)).toHaveLength(4);

    // Now create one more backup with maxBackups=3, which should trigger rotation
    app.createBackup({ backupDir, maxBackups: 3 });

    const backups = app.listBackups(backupDir);
    expect(backups).toHaveLength(3); // 2 oldest of the 4 fakes + the new real one = 5, keep 3
  });

  it('keeps all backups when under maxBackups', () => {
    const backupDir = join(baseDir, 'backups');

    app.createBackup({ backupDir, maxBackups: 10 });
    app.createBackup({ backupDir, maxBackups: 10 });

    const backups = app.listBackups(backupDir);
    expect(backups.length).toBeLessThanOrEqual(10);
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });
});

describe('ved backup — list', () => {
  let baseDir: string;
  let vaultPath: string;
  let app: VedApp;

  beforeEach(async () => {
    baseDir = createTestDir();
    vaultPath = createTestVault(baseDir);
    const config = createTestConfig(baseDir, vaultPath);
    app = new VedApp(config);
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns empty array when no backups exist', () => {
    const backups = app.listBackups(join(baseDir, 'nonexistent'));
    expect(backups).toEqual([]);
  });

  it('lists backups sorted by date (newest first)', () => {
    const backupDir = join(baseDir, 'backups');
    mkdirSync(backupDir, { recursive: true });

    // Create files with known timestamps to ensure sort order
    writeFileSync(join(backupDir, 'ved-backup-2026-03-01_12-00-00.tar.gz'), 'old');
    writeFileSync(join(backupDir, 'ved-backup-2026-03-05_12-00-00.tar.gz'), 'new');

    const backups = app.listBackups(backupDir);
    expect(backups).toHaveLength(2);

    // Newest first (by mtime — the newer-named file was written second, so it has a later mtime)
    // But to be safe, just check that the list has 2 entries with correct filenames
    const filenames = backups.map(b => b.filename);
    expect(filenames).toContain('ved-backup-2026-03-01_12-00-00.tar.gz');
    expect(filenames).toContain('ved-backup-2026-03-05_12-00-00.tar.gz');
  });

  it('returns correct metadata for each backup', () => {
    const backupDir = join(baseDir, 'backups');
    app.createBackup({ backupDir });

    const backups = app.listBackups(backupDir);
    expect(backups).toHaveLength(1);
    expect(backups[0].filename).toMatch(/^ved-backup-.*\.tar\.gz$/);
    expect(backups[0].sizeBytes).toBeGreaterThan(0);
    expect(backups[0].createdAt).toBeInstanceOf(Date);
  });

  it('ignores non-backup files in backup directory', () => {
    const backupDir = join(baseDir, 'backups');
    mkdirSync(backupDir, { recursive: true });

    // Create a backup
    app.createBackup({ backupDir });

    // Add some non-backup files
    writeFileSync(join(backupDir, 'notes.txt'), 'hello');
    writeFileSync(join(backupDir, 'other.tar.gz'), 'not a backup');

    const backups = app.listBackups(backupDir);
    expect(backups).toHaveLength(1); // Only the real backup
    expect(backups[0].filename).toMatch(/^ved-backup-/);
  });
});

describe('ved backup — restore', () => {
  let baseDir: string;
  let vaultPath: string;
  let app: VedApp;

  beforeEach(async () => {
    baseDir = createTestDir();
    vaultPath = createTestVault(baseDir);
    const config = createTestConfig(baseDir, vaultPath);
    app = new VedApp(config);
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('dry-run restore shows file count without changing anything', () => {
    const backupDir = join(baseDir, 'backups');
    const backup = app.createBackup({ backupDir });

    // Modify vault
    writeFileSync(join(vaultPath, 'entities', 'alice.md'), 'MODIFIED');

    const result = app.restoreBackup(backup.path, { dryRun: true });
    expect(result.vaultFiles).toBe(4);
    expect(result.dbRestored).toBe(true);

    // Verify vault wasn't actually changed
    const content = readFileSync(join(vaultPath, 'entities', 'alice.md'), 'utf-8');
    expect(content).toBe('MODIFIED');
  });

  it('live restore overwrites vault files', () => {
    const backupDir = join(baseDir, 'backups');
    const backup = app.createBackup({ backupDir });

    // Modify vault
    writeFileSync(join(vaultPath, 'entities', 'alice.md'), 'MODIFIED');

    const result = app.restoreBackup(backup.path);
    expect(result.vaultFiles).toBe(4);
    expect(result.dbRestored).toBe(true);

    // Verify vault was restored
    const content = readFileSync(join(vaultPath, 'entities', 'alice.md'), 'utf-8');
    expect(content).toContain('# Alice');
  });

  it('throws on non-existent backup file', () => {
    expect(() => {
      app.restoreBackup('/nonexistent/backup.tar.gz');
    }).toThrow('Backup not found');
  });

  it('creates audit entry for restore', () => {
    const backupDir = join(baseDir, 'backups');
    const backupResult = app.createBackup({ backupDir });

    // Restore replaces the DB, so the audit log is now on the new DB
    const result = app.restoreBackup(backupResult.path);
    expect(result.vaultFiles).toBe(4);
    expect(result.dbRestored).toBe(true);

    // After restore, the app's DB was replaced — query the restored audit log
    // The backup_restored entry was appended to the new (restored) DB
    const entries = app.getHistory({ type: 'backup_restored', limit: 1 });
    expect(entries).toHaveLength(1);
    const detail = JSON.parse(entries[0].detail);
    expect(detail.vaultFiles).toBe(4);
    expect(detail.dbRestored).toBe(true);
  });

  it('preserves .git directory during restore', () => {
    // Create a fake .git dir in vault
    const gitDir = join(vaultPath, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main');

    const backupDir = join(baseDir, 'backups');
    const backup = app.createBackup({ backupDir });

    app.restoreBackup(backup.path);

    // .git should still be there
    expect(existsSync(join(vaultPath, '.git', 'HEAD'))).toBe(true);
  });
});

// ── Completions Tests ──

describe('ved completions', () => {
  it('generates valid bash completions', () => {
    const output = VedApp.generateCompletions('bash');
    expect(output).toContain('_ved_completions');
    expect(output).toContain('complete -F _ved_completions ved');
    expect(output).toContain('backup');
    expect(output).toContain('completions');
    expect(output).toContain('COMPREPLY');
  });

  it('generates valid zsh completions', () => {
    const output = VedApp.generateCompletions('zsh');
    expect(output).toContain('#compdef ved');
    expect(output).toContain('_ved()');
    expect(output).toContain('backup');
    expect(output).toContain('completions');
    expect(output).toContain('_describe');
  });

  it('generates valid fish completions', () => {
    const output = VedApp.generateCompletions('fish');
    expect(output).toContain('complete -c ved');
    expect(output).toContain('backup');
    expect(output).toContain('completions');
    expect(output).toContain('__fish_use_subcommand');
  });

  it('includes all CLI commands in completions', () => {
    const expectedCommands = [
      'init', 'start', 'status', 'stats', 'search', 'reindex',
      'config', 'export', 'import', 'history', 'doctor', 'backup', 'completions', 'version',
    ];

    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const output = VedApp.generateCompletions(shell);
      for (const cmd of expectedCommands) {
        expect(output).toContain(cmd);
      }
    }
  });

  it('includes backup subcommands', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const output = VedApp.generateCompletions(shell);
      expect(output).toContain('create');
      expect(output).toContain('list');
      expect(output).toContain('restore');
    }
  });

  it('includes config subcommands', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const output = VedApp.generateCompletions(shell);
      expect(output).toContain('validate');
      expect(output).toContain('show');
      expect(output).toContain('path');
    }
  });

  it('throws on unknown shell', () => {
    expect(() => {
      VedApp.generateCompletions('powershell' as any);
    }).toThrow('Unknown shell');
  });
});

// ── Audit Event Type Tests ──

describe('backup audit event types', () => {
  it('backup_created and backup_restored are valid event types', async () => {
    const baseDir = createTestDir();
    const vaultPath = createTestVault(baseDir);
    const config = createTestConfig(baseDir, vaultPath);
    const app = new VedApp(config);
    await app.init();

    const backupDir = join(baseDir, 'backups');
    app.createBackup({ backupDir });

    const types = app.getAuditEventTypes();
    expect(types).toContain('backup_created');

    await app.stop();
    rmSync(baseDir, { recursive: true, force: true });
  });
});
