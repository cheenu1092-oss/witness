/**
 * Database connection management for Ved.
 *
 * Opens a better-sqlite3 database with WAL mode and required pragmas.
 * Runs pending migrations on open (unless readonly).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrate.js';

export interface DbOptions {
  /** Database file path. Supports ~ expansion. */
  path: string;
  /** Open in read-only mode. Skips migrations. */
  readonly?: boolean;
  /** Log all SQL statements to console (development only). */
  verbose?: boolean;
}

/**
 * Open (or create) the Ved SQLite database.
 * Sets WAL mode, foreign keys, busy timeout, and cache pragmas.
 * Runs pending migrations unless readonly.
 */
export function openDatabase(options: DbOptions): Database.Database {
  const dbPath = options.path.replace(/^~(?=\/|$)/, process.env['HOME'] ?? '');

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, {
    readonly: options.readonly ?? false,
    verbose: options.verbose ? (sql: unknown) => console.log(sql) : undefined,
  });

  // === Performance and safety pragmas (must be set on every connection) ===
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL'); // Safe with WAL, faster than FULL
  db.pragma('cache_size = -64000'); // 64MB cache (negative = KB)
  db.pragma('temp_store = MEMORY'); // temp tables in RAM

  // Run migrations unless readonly
  if (!options.readonly) {
    const applied = migrate(db);
    if (applied > 0) {
      console.log(`[ved-db] Applied ${applied} migration(s)`);
    }
  }

  return db;
}

/**
 * Close the database cleanly.
 * Runs ANALYZE on tables that need it, then closes.
 * Call on shutdown.
 */
export function closeDatabase(db: Database.Database): void {
  db.pragma('optimize');
  db.close();
}
