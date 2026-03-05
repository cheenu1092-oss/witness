/**
 * SessionManager tests — session lifecycle backed by SQLite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SessionManager } from './session.js';
import { migrate } from '../db/migrate.js';
import type { AuditEntryInput } from '../types/index.js';

// Use in-memory database for tests
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function createManager(db: Database.Database, onAudit?: (input: AuditEntryInput) => void) {
  return new SessionManager(db, {
    workingMemoryMaxTokens: 8000,
    onAudit,
  });
}

// === Creation ===

describe('SessionManager — create', () => {
  let db: Database.Database;
  let mgr: SessionManager;

  beforeEach(() => {
    db = createTestDb();
    mgr = createManager(db);
  });

  it('creates a new session for unknown author', () => {
    const session = mgr.getOrCreate('discord', 'guild#general', 'user-1');
    expect(session.id).toBeTruthy();
    expect(session.channel).toBe('discord');
    expect(session.author).toBe('user-1');
    expect(session.status).toBe('active');
    expect(session.workingMemory.messageCount).toBe(0);
  });

  it('creates session with specified trust tier', () => {
    const session = mgr.getOrCreate('discord', 'guild#general', 'user-1', 4);
    expect(session.trustTier).toBe(4);
  });

  it('defaults trust tier to 1', () => {
    const session = mgr.getOrCreate('discord', '', 'user-1');
    expect(session.trustTier).toBe(1);
  });

  it('assigns unique IDs to different sessions', () => {
    const s1 = mgr.getOrCreate('discord', '', 'user-1');
    mgr.close(s1.id); // close so next call creates new
    const s2 = mgr.getOrCreate('discord', '', 'user-1');
    expect(s1.id).not.toBe(s2.id);
  });

  it('persists session to database', () => {
    const session = mgr.getOrCreate('cli', '', 'user-1');
    const retrieved = mgr.get(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.channel).toBe('cli');
  });
});

// === Resumption ===

describe('SessionManager — resume', () => {
  let db: Database.Database;
  let mgr: SessionManager;

  beforeEach(() => {
    db = createTestDb();
    mgr = createManager(db);
  });

  it('resumes active session for same channel+author', () => {
    const s1 = mgr.getOrCreate('discord', '', 'user-1');
    s1.workingMemory.setFact('key', 'value');
    mgr.persist(s1);

    const s2 = mgr.getOrCreate('discord', '', 'user-1');
    expect(s2.id).toBe(s1.id);
    expect(s2.workingMemory.getFact('key')).toBe('value');
  });

  it('resumes idle session (reactivates)', () => {
    const s1 = mgr.getOrCreate('cli', '', 'user-1');
    mgr.markIdle(s1.id);

    const s2 = mgr.getOrCreate('cli', '', 'user-1');
    expect(s2.id).toBe(s1.id);
    // Status in the returned object should be active after resume
    expect(s2.status).toBe('active');
  });

  it('creates new session if previous was closed', () => {
    const s1 = mgr.getOrCreate('cli', '', 'user-1');
    mgr.close(s1.id);

    const s2 = mgr.getOrCreate('cli', '', 'user-1');
    expect(s2.id).not.toBe(s1.id);
  });

  it('different channels get different sessions', () => {
    const s1 = mgr.getOrCreate('discord', '', 'user-1');
    const s2 = mgr.getOrCreate('cli', '', 'user-1');
    expect(s1.id).not.toBe(s2.id);
  });

  it('different authors on same channel get different sessions', () => {
    const s1 = mgr.getOrCreate('discord', '', 'user-1');
    const s2 = mgr.getOrCreate('discord', '', 'user-2');
    expect(s1.id).not.toBe(s2.id);
  });
});

// === Persistence ===

describe('SessionManager — persist', () => {
  let db: Database.Database;
  let mgr: SessionManager;

  beforeEach(() => {
    db = createTestDb();
    mgr = createManager(db);
  });

  it('persists working memory changes', () => {
    const session = mgr.getOrCreate('cli', '', 'user-1');
    session.workingMemory.addMessage({ role: 'user', content: 'Hello', timestamp: Date.now() });
    session.workingMemory.setFact('name', 'Nag');
    mgr.persist(session);

    const restored = mgr.get(session.id)!;
    expect(restored.workingMemory.messageCount).toBe(1);
    expect(restored.workingMemory.messages[0].content).toBe('Hello');
    expect(restored.workingMemory.getFact('name')).toBe('Nag');
  });

  it('updates last_active timestamp', () => {
    const session = mgr.getOrCreate('cli', '', 'user-1');
    const before = session.lastActive;

    // Small delay
    const now = Date.now() + 100;
    mgr.persist(session);

    const restored = mgr.get(session.id)!;
    expect(restored.lastActive).toBeGreaterThanOrEqual(before);
  });
});

// === Idle & Close ===

describe('SessionManager — idle and close', () => {
  let db: Database.Database;
  let mgr: SessionManager;

  beforeEach(() => {
    db = createTestDb();
    mgr = createManager(db);
  });

  it('markIdle changes status', () => {
    const session = mgr.getOrCreate('cli', '', 'user-1');
    mgr.markIdle(session.id);
    const restored = mgr.get(session.id)!;
    expect(restored.status).toBe('idle');
  });

  it('close sets status=closed and clears working memory', () => {
    const session = mgr.getOrCreate('cli', '', 'user-1');
    session.workingMemory.setFact('key', 'val');
    mgr.persist(session);

    mgr.close(session.id, 'session summary');
    const restored = mgr.get(session.id)!;
    expect(restored.status).toBe('closed');
    expect(restored.workingMemory.factCount).toBe(0);
  });

  it('close does nothing for already closed session', () => {
    const session = mgr.getOrCreate('cli', '', 'user-1');
    mgr.close(session.id);
    // Second close should be a no-op
    mgr.close(session.id);
    expect(mgr.get(session.id)!.status).toBe('closed');
  });

  it('get returns null for nonexistent session', () => {
    expect(mgr.get('nonexistent')).toBeNull();
  });
});

// === Close stale ===

describe('SessionManager — closeStale', () => {
  let db: Database.Database;
  let mgr: SessionManager;

  beforeEach(() => {
    db = createTestDb();
    mgr = createManager(db);
  });

  it('closes sessions older than threshold', () => {
    // Create a session and backdate it
    const session = mgr.getOrCreate('cli', '', 'user-1');
    db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
      .run(Date.now() - 60 * 60 * 1000, session.id); // 1 hour ago

    const closed = mgr.closeStale(30); // 30 min threshold
    expect(closed.length).toBe(1);
    expect(closed[0].id).toBe(session.id);
    expect(mgr.get(session.id)!.status).toBe('closed');
  });

  it('does not close recent sessions', () => {
    mgr.getOrCreate('cli', '', 'user-1');
    const closed = mgr.closeStale(30);
    expect(closed.length).toBe(0);
  });

  it('returns sessions with their working memory (for T1→T2 flush)', () => {
    const session = mgr.getOrCreate('cli', '', 'user-1');
    session.workingMemory.setFact('remember', 'this');
    mgr.persist(session);

    db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
      .run(Date.now() - 60 * 60 * 1000, session.id);

    const closed = mgr.closeStale(30);
    expect(closed[0].workingMemory.getFact('remember')).toBe('this');
  });
});

// === Audit callback ===

describe('SessionManager — audit', () => {
  it('calls onAudit for session_start (created)', () => {
    const db = createTestDb();
    const audits: AuditEntryInput[] = [];
    const mgr = createManager(db, (input) => audits.push(input));

    mgr.getOrCreate('cli', '', 'user-1');

    expect(audits.length).toBe(1);
    expect(audits[0].eventType).toBe('session_start');
  });

  it('calls onAudit for session close', () => {
    const db = createTestDb();
    const audits: AuditEntryInput[] = [];
    const mgr = createManager(db, (input) => audits.push(input));

    const session = mgr.getOrCreate('cli', '', 'user-1');
    mgr.close(session.id);

    const closeAudit = audits.find(a => a.eventType === 'session_close');
    expect(closeAudit).toBeTruthy();
  });

  it('calls onAudit for session idle', () => {
    const db = createTestDb();
    const audits: AuditEntryInput[] = [];
    const mgr = createManager(db, (input) => audits.push(input));

    const session = mgr.getOrCreate('cli', '', 'user-1');
    mgr.markIdle(session.id);

    const idleAudit = audits.find(a => a.eventType === 'session_idle');
    expect(idleAudit).toBeTruthy();
  });

  it('works without onAudit callback', () => {
    const db = createTestDb();
    const mgr = createManager(db); // no callback
    expect(() => mgr.getOrCreate('cli', '', 'user-1')).not.toThrow();
  });
});
