/**
 * AnchorManager — HMAC-based integrity checkpoints for the audit chain.
 *
 * Periodically writes a signed snapshot of the chain head to the `anchors`
 * table. Even if an attacker rewrites audit_log entries, the HMAC anchor
 * preserves the expected chain state at each checkpoint.
 *
 * If no hmacSecret is configured, anchoring is disabled (logged as warning).
 */

import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { vedUlid } from '../types/ulid.js';

export interface Anchor {
  id: string;
  chainHeadId: string;
  chainHeadHash: string;
  chainLength: number;
  hmac: string;
  algorithm: string;
  timestamp: number; // unix ms
}

/**
 * AnchorManager handles creation and verification of HMAC checkpoints
 * stored in the `anchors` SQLite table.
 */
export class AnchorManager {
  private stmtInsert: Database.Statement;
  private stmtGetLatest: Database.Statement;
  private stmtGetAll: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO anchors (id, chain_head_id, chain_head_hash, chain_length, hmac, algorithm, timestamp)
      VALUES (@id, @chainHeadId, @chainHeadHash, @chainLength, @hmac, @algorithm, @timestamp)
    `);

    this.stmtGetLatest = db.prepare(`
      SELECT id, chain_head_id, chain_head_hash, chain_length, hmac, algorithm, timestamp
      FROM anchors
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    this.stmtGetAll = db.prepare(`
      SELECT id, chain_head_id, chain_head_hash, chain_length, hmac, algorithm, timestamp
      FROM anchors
      ORDER BY timestamp DESC
      LIMIT @limit
    `);
  }

  /**
   * Create an HMAC anchor for the current chain head.
   * If secret is provided, computes HMAC-SHA256 over the chain head data.
   * If no secret, stores a placeholder hmac of 'no-secret'.
   *
   * @param chainHead Current chain head state
   * @param secret Optional HMAC secret (from audit.hmacSecret config)
   */
  createAnchor(
    chainHead: { id: string; hash: string; count: number },
    secret?: string | null,
  ): Anchor {
    const id = vedUlid();
    const timestamp = Date.now();
    const data = `${chainHead.id}|${chainHead.hash}|${chainHead.count}|${timestamp}`;
    const hmac = secret
      ? createHmac('sha256', secret).update(data).digest('hex')
      : 'no-secret';

    this.stmtInsert.run({
      id,
      chainHeadId: chainHead.id,
      chainHeadHash: chainHead.hash,
      chainLength: chainHead.count,
      hmac,
      algorithm: 'hmac-sha256',
      timestamp,
    });

    return {
      id,
      chainHeadId: chainHead.id,
      chainHeadHash: chainHead.hash,
      chainLength: chainHead.count,
      hmac,
      algorithm: 'hmac-sha256',
      timestamp,
    };
  }

  /**
   * Verify the most recent anchor against the current chain state.
   *
   * @param currentHash Current chain head hash
   * @param currentCount Current chain entry count
   * @param secret The HMAC secret used when creating the anchor
   * @returns Verification result with reason if invalid
   */
  verifyLatestAnchor(
    currentHash: string,
    currentCount: number,
    secret?: string | null,
  ): { valid: boolean; reason?: string } {
    const row = this.stmtGetLatest.get() as RawAnchorRow | undefined;

    if (!row) {
      return { valid: true, reason: 'No anchors exist yet' };
    }

    const anchor = rowToAnchor(row);

    // Verify HMAC if secret is configured
    if (secret && anchor.hmac !== 'no-secret') {
      const data = `${anchor.chainHeadId}|${anchor.chainHeadHash}|${anchor.chainLength}|${anchor.timestamp}`;
      const expected = createHmac('sha256', secret).update(data).digest('hex');
      if (anchor.hmac !== expected) {
        return {
          valid: false,
          reason: 'Anchor HMAC invalid — anchor record may be tampered',
        };
      }
    }

    // If anchor is at current position, hashes must match
    if (anchor.chainLength === currentCount) {
      if (anchor.chainHeadHash === currentHash) {
        return { valid: true };
      }
      return {
        valid: false,
        reason: `Chain hash mismatch: anchor has ${anchor.chainHeadHash.slice(0, 16)}..., current is ${currentHash.slice(0, 16)}...`,
      };
    }

    // Anchor is behind current count — partial validation
    return {
      valid: true,
      reason: `Anchor at length ${anchor.chainLength}, current length ${currentCount} — partial validation`,
    };
  }

  /**
   * Get recent anchors from the database.
   * @param limit Max number of anchors to return (default 10)
   */
  getAnchors(limit = 10): Anchor[] {
    return (this.stmtGetAll.all({ limit }) as RawAnchorRow[]).map(rowToAnchor);
  }
}

// ── Internal helpers ──

interface RawAnchorRow {
  id: string;
  chain_head_id: string;
  chain_head_hash: string;
  chain_length: number;
  hmac: string;
  algorithm: string;
  timestamp: number;
}

function rowToAnchor(row: RawAnchorRow): Anchor {
  return {
    id: row.id,
    chainHeadId: row.chain_head_id,
    chainHeadHash: row.chain_head_hash,
    chainLength: row.chain_length,
    hmac: row.hmac,
    algorithm: row.algorithm,
    timestamp: row.timestamp,
  };
}
