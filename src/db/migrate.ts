/**
 * Migration runner for Ved's database.
 *
 * Discovers SQL files in src/db/migrations/, validates checksums,
 * and applies pending migrations inside transactions.
 *
 * Philosophy:
 * - Forward-only: no down migrations
 * - SQL files only: no TypeScript DSL
 * - Checksums: detect tampering of already-applied migrations
 * - Transactional: if a migration fails, nothing changes
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

interface MigrationFile {
  version: number;
  filename: string;
  path: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: number;
  filename: string;
  checksum: string;
}

/**
 * Discover migration SQL files on disk, sorted by version.
 * Files must match pattern: v{NNN}_{description}.sql
 */
function discoverMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^v\d{3}_.*\.sql$/.test(f))
    .sort();

  return files.map(filename => {
    const version = parseInt(filename.slice(1, 4), 10);
    const filePath = join(MIGRATIONS_DIR, filename);
    const sql = readFileSync(filePath, 'utf-8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    return { version, filename, path: filePath, checksum, sql };
  });
}

/**
 * Get already-applied migrations from the database.
 * Returns empty array if schema_version table doesn't exist yet.
 */
function getApplied(db: Database.Database): AppliedMigration[] {
  const tableExists = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='schema_version'
  `).get();

  if (!tableExists) return [];

  return db.prepare(`
    SELECT version, filename, checksum FROM schema_version
    ORDER BY version
  `).all() as AppliedMigration[];
}

/**
 * Run all pending migrations. Returns count of migrations applied.
 *
 * Safety guarantees:
 * - Validates no gaps in version sequence
 * - Validates checksums of already-applied migrations haven't changed
 * - Each migration runs in a transaction (atomic)
 * - Records checksum in schema_version for future tamper detection
 *
 * @throws Error if version gaps, tampering, or SQL errors detected
 */
export function migrate(db: Database.Database): number {
  const available = discoverMigrations();
  const applied = getApplied(db);

  // Validate: no version gaps in available files
  for (let i = 0; i < available.length; i++) {
    const expected = i + 1;
    if (available[i].version !== expected) {
      throw new Error(
        `Migration version gap: expected v${String(expected).padStart(3, '0')}, ` +
        `found ${available[i].filename}`
      );
    }
  }

  // Validate: applied migrations haven't been tampered with
  for (const prev of applied) {
    const file = available.find(m => m.version === prev.version);
    if (!file) {
      throw new Error(
        `Applied migration v${String(prev.version).padStart(3, '0')} ` +
        `(${prev.filename}) not found on disk`
      );
    }
    // v001 has empty checksum in its self-referential INSERT — skip that one
    if (prev.checksum && file.checksum !== prev.checksum) {
      throw new Error(
        `Migration ${prev.filename} has been modified after application! ` +
        `Expected checksum ${prev.checksum}, got ${file.checksum}`
      );
    }
  }

  // Find pending migrations
  const appliedVersions = new Set(applied.map(a => a.version));
  const pending = available.filter(m => !appliedVersions.has(m.version));

  if (pending.length === 0) return 0;

  for (const migration of pending) {
    console.log(`[ved-db] Applying migration: ${migration.filename}`);

    const txn = db.transaction(() => {
      db.exec(migration.sql);

      // Prepare inside transaction — schema_version may have just been created by this migration
      const insertVersion = db.prepare(`
        INSERT OR REPLACE INTO schema_version (version, applied_at, filename, checksum, description)
        VALUES (?, ?, ?, ?, ?)
      `);

      // Update schema_version with the real checksum (v001 has empty placeholder)
      insertVersion.run(
        migration.version,
        Date.now(),
        migration.filename,
        migration.checksum,
        migration.filename.slice(5, -4).replace(/_/g, ' ')
      );
    });

    txn();
    console.log(`[ved-db] Applied v${String(migration.version).padStart(3, '0')}`);
  }

  return pending.length;
}

/**
 * Get the current schema version number.
 * Returns 0 if no migrations have been applied.
 */
export function currentVersion(db: Database.Database): number {
  const applied = getApplied(db);
  return applied.length > 0 ? Math.max(...applied.map(a => a.version)) : 0;
}

/**
 * Verify integrity of applied migrations against disk files.
 * Returns list of issues (empty array = all good).
 */
export function verifyMigrations(db: Database.Database): string[] {
  const available = discoverMigrations();
  const applied = getApplied(db);
  const issues: string[] = [];

  for (const prev of applied) {
    const file = available.find(m => m.version === prev.version);
    if (!file) {
      issues.push(`Applied migration v${prev.version} (${prev.filename}) missing from disk`);
    } else if (prev.checksum && file.checksum !== prev.checksum) {
      issues.push(`Migration ${prev.filename} modified after application`);
    }
  }

  return issues;
}
