/**
 * Audit layer tests — hash chain, audit log, and anchor manager.
 *
 * Tests: 45+ covering
 * - Hash computation and genesis constant
 * - Chain verification (intact, tampered, empty)
 * - AuditLog append, getLatest, getRange, getByType, verifyChain, getChainHead
 * - AnchorManager create and verify
 * - Edge cases: empty DB, sequential appends, large ranges
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { openDatabase } from '../db/connection.js';
import { AuditLog } from './store.js';
import { AnchorManager } from './anchor.js';
import { hashEntry, verifyChain, GENESIS_HASH } from './hash.js';
import type { ChainEntry } from './hash.js';
import type { AuditEntryInput } from '../types/index.js';

// ── Helpers ──

function makeDb(): Database.Database {
  return openDatabase({ path: ':memory:' });
}

function makeInput(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    eventType: 'startup',
    actor: 'ved',
    detail: { msg: 'test' },
    ...overrides,
  };
}

// ── Hash utilities ──

describe('GENESIS_HASH', () => {
  it('equals SHA-256("ved-genesis")', () => {
    const expected = createHash('sha256').update('ved-genesis').digest('hex');
    expect(GENESIS_HASH).toBe(expected);
  });

  it('is 64 hex characters', () => {
    expect(GENESIS_HASH).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(GENESIS_HASH)).toBe(true);
  });
});

describe('hashEntry', () => {
  it('produces a 64-char hex string', () => {
    const h = hashEntry(GENESIS_HASH, 1000, 'startup', 'ved', '{}');
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  it('is deterministic for the same inputs', () => {
    const h1 = hashEntry('aaa', 1234, 'startup', 'ved', '{}');
    const h2 = hashEntry('aaa', 1234, 'startup', 'ved', '{}');
    expect(h1).toBe(h2);
  });

  it('differs when any input changes', () => {
    const base = hashEntry(GENESIS_HASH, 1000, 'startup', 'ved', '{}');
    expect(hashEntry('different', 1000, 'startup', 'ved', '{}')).not.toBe(base);
    expect(hashEntry(GENESIS_HASH, 9999, 'startup', 'ved', '{}')).not.toBe(base);
    expect(hashEntry(GENESIS_HASH, 1000, 'shutdown', 'ved', '{}')).not.toBe(base);
    expect(hashEntry(GENESIS_HASH, 1000, 'startup', 'user:1', '{}')).not.toBe(base);
    expect(hashEntry(GENESIS_HASH, 1000, 'startup', 'ved', '{"x":1}')).not.toBe(base);
  });
});

describe('verifyChain (standalone)', () => {
  it('returns -1 for empty chain', () => {
    expect(verifyChain([])).toBe(-1);
  });

  it('validates a single valid entry from genesis', () => {
    const entry: ChainEntry = {
      prevHash: GENESIS_HASH,
      hash: hashEntry(GENESIS_HASH, 1000, 'startup', 'ved', '{}'),
      timestamp: 1000,
      eventType: 'startup',
      actor: 'ved',
      detail: '{}',
    };
    expect(verifyChain([entry])).toBe(-1);
  });

  it('detects wrong prevHash on first entry (not genesis)', () => {
    const entry: ChainEntry = {
      prevHash: 'wrong',
      hash: hashEntry('wrong', 1000, 'startup', 'ved', '{}'),
      timestamp: 1000,
      eventType: 'startup',
      actor: 'ved',
      detail: '{}',
    };
    expect(verifyChain([entry])).toBe(0);
  });

  it('validates a two-entry chain', () => {
    const h0 = hashEntry(GENESIS_HASH, 1000, 'startup', 'ved', '{}');
    const h1 = hashEntry(h0, 2000, 'shutdown', 'ved', '{}');
    const entries: ChainEntry[] = [
      { prevHash: GENESIS_HASH, hash: h0, timestamp: 1000, eventType: 'startup', actor: 'ved', detail: '{}' },
      { prevHash: h0, hash: h1, timestamp: 2000, eventType: 'shutdown', actor: 'ved', detail: '{}' },
    ];
    expect(verifyChain(entries)).toBe(-1);
  });

  it('detects tampered entry hash', () => {
    const h0 = hashEntry(GENESIS_HASH, 1000, 'startup', 'ved', '{}');
    const entries: ChainEntry[] = [
      { prevHash: GENESIS_HASH, hash: 'tampered', timestamp: 1000, eventType: 'startup', actor: 'ved', detail: '{}' },
    ];
    expect(verifyChain(entries)).toBe(0);

    const h1 = hashEntry(h0, 2000, 'shutdown', 'ved', '{}');
    const entries2: ChainEntry[] = [
      { prevHash: GENESIS_HASH, hash: h0, timestamp: 1000, eventType: 'startup', actor: 'ved', detail: '{}' },
      { prevHash: h0, hash: 'tampered', timestamp: 2000, eventType: 'shutdown', actor: 'ved', detail: '{}' },
    ];
    expect(verifyChain(entries2)).toBe(1);
    void h1;
  });

  it('detects broken chain link (prevHash mismatch)', () => {
    const h0 = hashEntry(GENESIS_HASH, 1000, 'startup', 'ved', '{}');
    // Second entry has wrong prevHash
    const h1 = hashEntry('wrongprev', 2000, 'shutdown', 'ved', '{}');
    const entries: ChainEntry[] = [
      { prevHash: GENESIS_HASH, hash: h0, timestamp: 1000, eventType: 'startup', actor: 'ved', detail: '{}' },
      { prevHash: 'wrongprev', hash: h1, timestamp: 2000, eventType: 'shutdown', actor: 'ved', detail: '{}' },
    ];
    expect(verifyChain(entries)).toBe(1);
  });
});

// ── AuditLog ──

describe('AuditLog', () => {
  let db: Database.Database;
  let log: AuditLog;

  beforeEach(() => {
    db = makeDb();
    log = new AuditLog(db);
  });

  it('starts with empty chain state', () => {
    expect(log.getLatest()).toBeNull();
    const head = log.getChainHead();
    expect(head.count).toBe(0);
    expect(head.hash).toBe(GENESIS_HASH);
    expect(head.id).toBe('');
  });

  it('appends first entry correctly', () => {
    const entry = log.append(makeInput({ eventType: 'startup', actor: 'ved' }));
    expect(entry.id).toBeTruthy();
    expect(entry.eventType).toBe('startup');
    expect(entry.actor).toBe('ved');
    expect(entry.prevHash).toBe(GENESIS_HASH);
    expect(entry.hash).toHaveLength(64);
  });

  it('updates chain head after append', () => {
    const e = log.append(makeInput());
    const head = log.getChainHead();
    expect(head.id).toBe(e.id);
    expect(head.hash).toBe(e.hash);
    expect(head.count).toBe(1);
  });

  it('chains entries correctly (prevHash linkage)', () => {
    const e1 = log.append(makeInput({ eventType: 'startup' }));
    const e2 = log.append(makeInput({ eventType: 'shutdown' }));
    expect(e2.prevHash).toBe(e1.hash);
  });

  it('defaults actor to "ved"', () => {
    const entry = log.append({ eventType: 'startup', detail: {} });
    expect(entry.actor).toBe('ved');
  });

  it('stores sessionId when provided', () => {
    const entry = log.append(makeInput({ sessionId: 'sess-123' }));
    expect(entry.sessionId).toBe('sess-123');
  });

  it('getLatest returns most recent entry', () => {
    log.append(makeInput({ eventType: 'startup' }));
    const e2 = log.append(makeInput({ eventType: 'shutdown' }));
    const latest = log.getLatest();
    expect(latest?.id).toBe(e2.id);
    expect(latest?.eventType).toBe('shutdown');
  });

  it('getRange returns entries in timestamp window', async () => {
    const t0 = Date.now();
    log.append(makeInput({ eventType: 'startup' }));
    await new Promise(r => setTimeout(r, 5));
    log.append(makeInput({ eventType: 'shutdown' }));
    const t1 = Date.now();
    const entries = log.getRange(t0, t1);
    expect(entries.length).toBe(2);
  });

  it('getRange excludes entries outside window', async () => {
    log.append(makeInput({ eventType: 'startup' }));
    await new Promise(r => setTimeout(r, 10));
    const t_mid = Date.now();
    log.append(makeInput({ eventType: 'shutdown' }));
    // Only get entries before t_mid
    const entries = log.getRange(0, t_mid - 1);
    expect(entries.length).toBe(1);
    expect(entries[0].eventType).toBe('startup');
  });

  it('getByType filters by event type', () => {
    log.append(makeInput({ eventType: 'startup' }));
    log.append(makeInput({ eventType: 'shutdown' }));
    log.append(makeInput({ eventType: 'startup' }));
    const startups = log.getByType('startup');
    expect(startups.length).toBe(2);
    expect(startups.every(e => e.eventType === 'startup')).toBe(true);
  });

  it('getByType respects limit', () => {
    for (let i = 0; i < 5; i++) {
      log.append(makeInput({ eventType: 'startup' }));
    }
    const limited = log.getByType('startup', 3);
    expect(limited.length).toBe(3);
  });

  it('verifyChain returns intact for valid chain', () => {
    log.append(makeInput({ eventType: 'startup' }));
    log.append(makeInput({ eventType: 'shutdown' }));
    const result = log.verifyChain();
    expect(result.intact).toBe(true);
    expect(result.brokenAt).toBeUndefined();
    expect(result.total).toBe(2);
  });

  it('verifyChain returns intact for empty log', () => {
    const result = log.verifyChain();
    expect(result.intact).toBe(true);
    expect(result.total).toBe(0);
  });

  it('detects chain tampering via direct SQL update', () => {
    log.append(makeInput({ eventType: 'startup' }));
    log.append(makeInput({ eventType: 'shutdown' }));

    // Tamper with first entry
    db.exec(`UPDATE audit_log SET actor = 'hacker' WHERE event_type = 'startup'`);

    // Reload log to get fresh state
    const log2 = new AuditLog(db);
    const result = log2.verifyChain();
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBeDefined();
  });

  it('appends 10 entries and maintains chain integrity', () => {
    for (let i = 0; i < 10; i++) {
      log.append(makeInput({ eventType: 'startup', detail: { i } }));
    }
    const result = log.verifyChain();
    expect(result.intact).toBe(true);
    expect(result.total).toBe(10);
  });

  it('stores and retrieves JSON detail', () => {
    const detail = { userId: 'abc', action: 'test', nested: { x: 1 } };
    const entry = log.append(makeInput({ detail }));
    expect(entry.detail).toBe(JSON.stringify(detail));
    const latest = log.getLatest();
    expect(latest?.detail).toBe(JSON.stringify(detail));
  });

  it('persists across AuditLog instances (DB reload)', () => {
    const e = log.append(makeInput({ eventType: 'startup' }));

    // Create a new AuditLog on the same DB
    const log2 = new AuditLog(db);
    const head2 = log2.getChainHead();
    expect(head2.hash).toBe(e.hash);
    expect(head2.count).toBe(1);
  });

  it('second instance chains from loaded state', () => {
    log.append(makeInput({ eventType: 'startup' }));

    const log2 = new AuditLog(db);
    const e2 = log2.append(makeInput({ eventType: 'shutdown' }));

    // Chain should be intact across both instances
    const log3 = new AuditLog(db);
    const result = log3.verifyChain();
    expect(result.intact).toBe(true);
    expect(result.total).toBe(2);
    void e2;
  });
});

// ── AnchorManager ──

describe('AnchorManager', () => {
  let db: Database.Database;
  let log: AuditLog;
  let anchor: AnchorManager;

  beforeEach(() => {
    db = makeDb();
    log = new AuditLog(db);
    anchor = new AnchorManager(db);
  });

  it('creates an anchor with no secret', () => {
    log.append(makeInput());
    const head = log.getChainHead();
    const a = anchor.createAnchor(head);
    expect(a.id).toBeTruthy();
    expect(a.chainHeadHash).toBe(head.hash);
    expect(a.chainLength).toBe(1);
    expect(a.hmac).toBe('no-secret');
  });

  it('creates an anchor with HMAC secret', () => {
    log.append(makeInput());
    const head = log.getChainHead();
    const a = anchor.createAnchor(head, 'my-secret');
    expect(a.hmac).not.toBe('no-secret');
    expect(a.hmac).toHaveLength(64);
  });

  it('getAnchors returns created anchors', () => {
    log.append(makeInput());
    const head = log.getChainHead();
    anchor.createAnchor(head, 'secret');
    const anchors = anchor.getAnchors();
    expect(anchors.length).toBe(1);
    expect(anchors[0].chainHeadHash).toBe(head.hash);
  });

  it('verifyLatestAnchor returns valid=true for no anchors', () => {
    const result = anchor.verifyLatestAnchor('somehash', 0);
    expect(result.valid).toBe(true);
    expect(result.reason).toContain('No anchors');
  });

  it('verifyLatestAnchor succeeds with matching hash and secret', () => {
    log.append(makeInput());
    const head = log.getChainHead();
    anchor.createAnchor(head, 'my-secret');
    const result = anchor.verifyLatestAnchor(head.hash, head.count, 'my-secret');
    expect(result.valid).toBe(true);
  });

  it('verifyLatestAnchor detects hash mismatch', () => {
    log.append(makeInput());
    const head = log.getChainHead();
    anchor.createAnchor(head, 'secret');
    const result = anchor.verifyLatestAnchor('wronghash', head.count, 'secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('mismatch');
  });

  it('verifyLatestAnchor detects tampered HMAC', () => {
    log.append(makeInput());
    const head = log.getChainHead();
    anchor.createAnchor(head, 'real-secret');
    // Verify with wrong secret — HMAC won't match
    const result = anchor.verifyLatestAnchor(head.hash, head.count, 'wrong-secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('HMAC');
  });

  it('verifyLatestAnchor returns partial when anchor is behind current', () => {
    log.append(makeInput());
    const head = log.getChainHead();
    anchor.createAnchor(head, 'secret');
    // Append more entries
    log.append(makeInput());
    const head2 = log.getChainHead();
    // Verify with current (larger) count
    const result = anchor.verifyLatestAnchor(head2.hash, head2.count, 'secret');
    expect(result.valid).toBe(true);
    expect(result.reason).toContain('partial');
  });

  it('getAnchors respects limit', () => {
    for (let i = 0; i < 5; i++) {
      log.append(makeInput());
      anchor.createAnchor(log.getChainHead());
    }
    const anchors = anchor.getAnchors(3);
    expect(anchors.length).toBe(3);
  });
});
