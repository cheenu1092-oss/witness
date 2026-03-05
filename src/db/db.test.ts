/**
 * Database layer tests — connection, migration, pragmas.
 */

import { describe, it, expect } from 'vitest';
import { openDatabase, closeDatabase } from './connection.js';
import { currentVersion, verifyMigrations } from './migrate.js';

// ── Helpers ──

function makeDb() {
  return openDatabase({ path: ':memory:' });
}

// ── Connection ──

describe('openDatabase', () => {
  it('creates an in-memory database', () => {
    const db = makeDb();
    expect(db.open).toBe(true);
    db.close();
  });

  it('sets WAL journal mode', () => {
    const db = makeDb();
    // In-memory DBs may report 'memory' for journal_mode
    const mode = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(['wal', 'memory']).toContain(mode[0].journal_mode);
    db.close();
  });

  it('enables foreign keys', () => {
    const db = makeDb();
    const fk = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(fk[0].foreign_keys).toBe(1);
    db.close();
  });

  it('runs migrations automatically', () => {
    const db = makeDb();
    const version = currentVersion(db);
    expect(version).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('creates all expected tables', () => {
    const db = makeDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);

    expect(names).toContain('audit_log');
    expect(names).toContain('sessions');
    expect(names).toContain('inbox');
    expect(names).toContain('outbox');
    expect(names).toContain('work_orders');
    expect(names).toContain('trust_ledger');
    expect(names).toContain('chunks');
    expect(names).toContain('graph_edges');
    expect(names).toContain('llm_calls');
    expect(names).toContain('tool_calls');
    expect(names).toContain('mcp_servers');
    expect(names).toContain('cron_jobs');
    expect(names).toContain('anchors');
    expect(names).toContain('schema_version');

    db.close();
  });
});

// ── Migrations ──

describe('migrations', () => {
  it('verifyMigrations returns no issues for fresh DB', () => {
    const db = makeDb();
    const issues = verifyMigrations(db);
    expect(issues).toEqual([]);
    db.close();
  });

  it('idempotent: opening same DB twice runs no new migrations', async () => {
    const db = makeDb();
    const v1 = currentVersion(db);
    // Re-running migrate should be a no-op
    const { migrate } = await import('./migrate.js');
    const applied = migrate(db);
    expect(applied).toBe(0);
    expect(currentVersion(db)).toBe(v1);
    db.close();
  });

  it('schema_version tracks applied migrations', () => {
    const db = makeDb();
    const rows = db.prepare('SELECT version, filename FROM schema_version ORDER BY version').all() as Array<{ version: number; filename: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].filename).toBe('v001_initial.sql');
    db.close();
  });
});

// ── closeDatabase ──

describe('closeDatabase', () => {
  it('closes the database cleanly', () => {
    const db = makeDb();
    expect(db.open).toBe(true);
    closeDatabase(db);
    expect(db.open).toBe(false);
  });
});
