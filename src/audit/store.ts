/**
 * AuditLog — append-only hash-chained audit store backed by SQLite.
 *
 * Every significant Ved action is recorded here. The chain is tamper-evident:
 * each entry includes the hash of the previous entry, forming an unbroken chain
 * from the genesis entry to the present.
 *
 * Concurrency: better-sqlite3 is synchronous. Node's event loop serializes
 * calls. No deadlocks, no races on the chain head.
 */

import Database from 'better-sqlite3';
import { vedUlid } from '../types/ulid.js';
import { hashEntry, verifyChain, GENESIS_HASH } from './hash.js';
import type { AuditEntry, AuditEntryInput, AuditEventType } from '../types/index.js';

export class AuditLog {
  /** In-memory chain state — avoids a DB read on every append. */
  private lastHash: string = GENESIS_HASH;
  private count: number = 0;
  private lastId: string = '';

  // DB reference for dynamic queries
  private readonly db: Database.Database;

  // Prepared statements
  private stmtInsert: Database.Statement;
  private stmtGetLatest: Database.Statement;
  private stmtGetRange: Database.Statement;
  private stmtGetByType: Database.Statement;
  private stmtGetForVerify: Database.Statement;
  private stmtGetRecent: Database.Statement;
  private stmtCount: Database.Statement;

  /**
   * Create an AuditLog backed by an existing database connection.
   * Loads current chain state from DB on construction.
   */
  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT INTO audit_log (id, timestamp, event_type, actor, session_id, detail, prev_hash, hash)
      VALUES (@id, @timestamp, @eventType, @actor, @sessionId, @detail, @prevHash, @hash)
    `);

    this.stmtGetLatest = db.prepare(`
      SELECT id, timestamp, event_type, actor, session_id, detail, prev_hash, hash
      FROM audit_log
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `);

    this.stmtGetRange = db.prepare(`
      SELECT id, timestamp, event_type, actor, session_id, detail, prev_hash, hash
      FROM audit_log
      WHERE timestamp >= @from AND timestamp <= @to
      ORDER BY timestamp ASC, id ASC
    `);

    this.stmtGetByType = db.prepare(`
      SELECT id, timestamp, event_type, actor, session_id, detail, prev_hash, hash
      FROM audit_log
      WHERE event_type = @eventType
      ORDER BY timestamp DESC, id DESC
      LIMIT @limit
    `);

    this.stmtGetForVerify = db.prepare(`
      SELECT id, timestamp, event_type, actor, session_id, detail, prev_hash, hash
      FROM audit_log
      ORDER BY timestamp ASC, id ASC
      LIMIT @limit
    `);

    this.stmtGetRecent = db.prepare(`
      SELECT id, timestamp, event_type, actor, session_id, detail, prev_hash, hash
      FROM audit_log
      ORDER BY timestamp DESC, id DESC
      LIMIT @limit
    `);

    this.stmtCount = db.prepare(`SELECT COUNT(*) as n FROM audit_log`);

    this.loadChainState();
  }

  /** Load chain head from DB into memory. */
  private loadChainState(): void {
    const row = this.stmtGetLatest.get() as RawRow | undefined;
    if (row) {
      this.lastHash = row.hash;
      this.lastId = row.id;
    }
    this.count = (this.stmtCount.get() as { n: number }).n;
  }

  /**
   * Append an audit entry to the log.
   * Computes hash, inserts atomically, updates in-memory chain state.
   * @returns The completed AuditEntry with computed hash.
   */
  append(input: AuditEntryInput): AuditEntry {
    const id = vedUlid();
    const timestamp = Date.now();
    const actor = input.actor ?? 'ved';
    const detail = JSON.stringify(input.detail);
    const prevHash = this.lastHash;

    const hash = hashEntry(prevHash, timestamp, input.eventType, actor, detail);

    this.stmtInsert.run({
      id,
      timestamp,
      eventType: input.eventType,
      actor,
      sessionId: input.sessionId ?? null,
      detail,
      prevHash,
      hash,
    });

    this.lastHash = hash;
    this.lastId = id;
    this.count++;

    return {
      id,
      timestamp,
      eventType: input.eventType,
      actor,
      sessionId: input.sessionId,
      detail,
      prevHash,
      hash,
    };
  }

  /**
   * Get the most recent audit entry, or null if log is empty.
   */
  getLatest(): AuditEntry | null {
    const row = this.stmtGetLatest.get() as RawRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /**
   * Get audit entries within a timestamp range (inclusive).
   * @param from Unix ms start timestamp
   * @param to Unix ms end timestamp
   */
  getRange(from: number, to: number): AuditEntry[] {
    return (this.stmtGetRange.all({ from, to }) as RawRow[]).map(rowToEntry);
  }

  /**
   * Get the N most recent entries of a specific event type.
   */
  getByType(type: AuditEventType, limit = 50): AuditEntry[] {
    return (this.stmtGetByType.all({ eventType: type, limit }) as RawRow[]).map(rowToEntry);
  }

  /**
   * Verify the hash chain integrity.
   * @param limit Max entries to verify (default: all)
   * @returns { intact, brokenAt?, total }
   */
  verifyChain(limit?: number): { intact: boolean; brokenAt?: number; total: number } {
    const rows = this.stmtGetForVerify.all({
      limit: limit ?? 2_147_483_647, // SQLite max int — equivalent to "no limit"
    }) as RawRow[];

    const entries = rows.map(r => ({
      prevHash: r.prev_hash,
      hash: r.hash,
      timestamp: r.timestamp,
      eventType: r.event_type,
      actor: r.actor,
      detail: r.detail,
    }));

    const brokenAt = verifyChain(entries);

    return {
      intact: brokenAt === -1,
      brokenAt: brokenAt === -1 ? undefined : brokenAt,
      total: rows.length,
    };
  }

  /**
   * Get the current chain head state.
   */
  getChainHead(): { hash: string; id: string; count: number } {
    return {
      hash: this.lastHash,
      id: this.lastId,
      count: this.count,
    };
  }

  /**
   * Get the N most recent entries, newest first.
   */
  getRecent(limit: number): AuditEntry[] {
    const n = Math.max(1, limit);
    return (this.stmtGetRecent.all({ limit: n }) as RawRow[]).map(rowToEntry);
  }

  /**
   * Get all entries in chain order (oldest first).
   */
  getAll(limit?: number): AuditEntry[] {
    return (this.stmtGetForVerify.all({
      limit: limit ?? 2_147_483_647,
    }) as RawRow[]).map(rowToEntry);
  }

  /**
   * Get filtered entries. Newest first. All filter params are optional.
   */
  getFiltered(options: { type?: string; from?: number; to?: number; limit?: number }): AuditEntry[] {
    const limit = Math.max(1, options.limit ?? 50);
    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit };

    if (options.type) {
      conditions.push('event_type = @type');
      params['type'] = options.type;
    }
    if (options.from !== undefined) {
      conditions.push('timestamp >= @from');
      params['from'] = options.from;
    }
    if (options.to !== undefined) {
      conditions.push('timestamp <= @to');
      params['to'] = options.to;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT id, timestamp, event_type, actor, session_id, detail, prev_hash, hash
      FROM audit_log
      ${where}
      ORDER BY timestamp DESC, id DESC
      LIMIT @limit
    `;

    return (this.db.prepare(sql).all(params) as RawRow[]).map(rowToEntry);
  }
}

// ── Internal types and helpers ──

interface RawRow {
  id: string;
  timestamp: number;
  event_type: string;
  actor: string;
  session_id: string | null;
  detail: string;
  prev_hash: string;
  hash: string;
}

function rowToEntry(row: RawRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.event_type as AuditEventType,
    actor: row.actor,
    sessionId: row.session_id ?? undefined,
    detail: row.detail,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
