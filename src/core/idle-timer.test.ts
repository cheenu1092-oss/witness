/**
 * Tests for SessionIdleTimer.
 *
 * Covers:
 * - Start/stop lifecycle
 * - Idle session detection and closure
 * - T1→T2 compression triggering
 * - Debounce guard (no concurrent checks)
 * - Stats tracking
 * - Edge cases (no stale sessions, compressor unavailable, compression failure)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SessionIdleTimer } from './idle-timer.js';
import type { IdleTimerDeps } from './idle-timer.js';
import { SessionManager } from './session.js';
import { AuditLog } from '../audit/store.js';
import { migrate } from '../db/migrate.js';
import type { Session } from './session.js';
import { WorkingMemory } from './working-memory.js';

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function createTestSessions(db: Database.Database): SessionManager {
  return new SessionManager(db, {
    workingMemoryMaxTokens: 4000,
  });
}

function createMockCompressor() {
  return {
    compress: vi.fn().mockResolvedValue({
      sessionId: 'test',
      summary: 'test summary',
      facts: [],
      decisions: [],
      todos: [],
      entities: [],
    }),
    shouldCompress: vi.fn().mockReturnValue(false),
  };
}

function createDeps(db: Database.Database, withCompressor = true): IdleTimerDeps {
  return {
    sessions: createTestSessions(db),
    audit: new AuditLog(db),
    compressor: withCompressor ? createMockCompressor() as any : null,
  };
}

// Create a session with messages and set its last_active to the past
function createStaleSession(
  db: Database.Database,
  deps: IdleTimerDeps,
  minutesAgo: number,
): Session {
  const session = deps.sessions.getOrCreate('cli', '', 'user-1', 1);

  // Add some messages so compression has something to work with
  session.workingMemory.addMessage({
    role: 'user',
    content: 'Hello',
    timestamp: Date.now(),
  });
  session.workingMemory.addMessage({
    role: 'assistant',
    content: 'Hi there!',
    timestamp: Date.now(),
  });

  deps.sessions.persist(session);

  // Manually backdate the session
  const pastTime = Date.now() - minutesAgo * 60 * 1000;
  db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(pastTime, session.id);

  return session;
}

// ═══════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════

describe('SessionIdleTimer — lifecycle', () => {
  let db: Database.Database;
  let timer: SessionIdleTimer;

  beforeEach(() => {
    db = createTestDb();
    const deps = createDeps(db);
    timer = new SessionIdleTimer(
      { sessionIdleMinutes: 5, checkIntervalMs: 60_000 },
      deps,
    );
  });

  afterEach(() => {
    timer.stop();
  });

  it('starts and reports running', () => {
    expect(timer.isRunning).toBe(false);
    timer.start();
    expect(timer.isRunning).toBe(true);
  });

  it('stops cleanly', () => {
    timer.start();
    timer.stop();
    expect(timer.isRunning).toBe(false);
  });

  it('is idempotent on start', () => {
    timer.start();
    timer.start(); // should not throw or double-start
    expect(timer.isRunning).toBe(true);
  });

  it('is idempotent on stop', () => {
    timer.stop(); // not started — should not throw
    expect(timer.isRunning).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// IDLE DETECTION
// ═══════════════════════════════════════════════════════════════════════

describe('SessionIdleTimer — check()', () => {
  let db: Database.Database;
  let deps: IdleTimerDeps;
  let timer: SessionIdleTimer;

  beforeEach(() => {
    db = createTestDb();
    deps = createDeps(db);
    timer = new SessionIdleTimer(
      { sessionIdleMinutes: 5, checkIntervalMs: 60_000 },
      deps,
    );
  });

  afterEach(() => {
    timer.stop();
  });

  it('returns no-op when no sessions exist', async () => {
    const result = await timer.check();
    expect(result.checked).toBe(true);
    expect(result.closed).toBe(0);
    expect(result.compressed).toBe(0);
  });

  it('does not close active sessions', async () => {
    // Create a session that's recent (1 min ago < 5 min threshold)
    createStaleSession(db, deps, 1);

    const result = await timer.check();
    expect(result.closed).toBe(0);
  });

  it('closes sessions idle beyond threshold', async () => {
    // Create a session 10 minutes ago (> 5 min threshold)
    createStaleSession(db, deps, 10);

    const result = await timer.check();
    expect(result.closed).toBe(1);
  });

  it('compresses closed sessions with messages', async () => {
    createStaleSession(db, deps, 10);

    const result = await timer.check();
    expect(result.compressed).toBe(1);
    expect(deps.compressor!.compress).toHaveBeenCalledTimes(1);
  });

  it('skips compression for sessions with < 2 messages', async () => {
    const session = deps.sessions.getOrCreate('cli', '', 'user-2', 1);
    // Only 1 message
    session.workingMemory.addMessage({
      role: 'user',
      content: 'Solo message',
      timestamp: Date.now(),
    });
    deps.sessions.persist(session);
    db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
      .run(Date.now() - 10 * 60 * 1000, session.id);

    const result = await timer.check();
    expect(result.closed).toBe(1);
    expect(result.compressed).toBe(0);
    expect(deps.compressor!.compress).not.toHaveBeenCalled();
  });

  it('handles compression failure gracefully', async () => {
    const failingCompressor = {
      compress: vi.fn().mockRejectedValue(new Error('LLM down')),
      shouldCompress: vi.fn().mockReturnValue(false),
    };
    const failDeps = { ...deps, compressor: failingCompressor as any };
    const failTimer = new SessionIdleTimer(
      { sessionIdleMinutes: 5, checkIntervalMs: 60_000 },
      failDeps,
    );

    createStaleSession(db, failDeps, 10);

    const result = await failTimer.check();
    expect(result.closed).toBe(1);
    expect(result.compressed).toBe(0);
    expect(result.errors).toBe(1);
  });

  it('works without compressor', async () => {
    const noDeps = createDeps(db, false);
    const noCompTimer = new SessionIdleTimer(
      { sessionIdleMinutes: 5, checkIntervalMs: 60_000 },
      noDeps,
    );

    createStaleSession(db, noDeps, 10);

    const result = await noCompTimer.check();
    expect(result.closed).toBe(1);
    expect(result.compressed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('handles multiple stale sessions', async () => {
    // Create 3 stale sessions for different users
    for (let i = 0; i < 3; i++) {
      const session = deps.sessions.getOrCreate('cli', '', `user-${i}`, 1);
      session.workingMemory.addMessage({
        role: 'user', content: `msg-${i}`, timestamp: Date.now(),
      });
      session.workingMemory.addMessage({
        role: 'assistant', content: `reply-${i}`, timestamp: Date.now(),
      });
      deps.sessions.persist(session);
      db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
        .run(Date.now() - 15 * 60 * 1000, session.id);
    }

    const result = await timer.check();
    expect(result.closed).toBe(3);
    expect(result.compressed).toBe(3);
  });

  it('audits the idle sweep', async () => {
    createStaleSession(db, deps, 10);

    await timer.check();

    const head = deps.audit.getChainHead();
    expect(head.count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

describe('SessionIdleTimer — stats', () => {
  let db: Database.Database;
  let deps: IdleTimerDeps;
  let timer: SessionIdleTimer;

  beforeEach(() => {
    db = createTestDb();
    deps = createDeps(db);
    timer = new SessionIdleTimer(
      { sessionIdleMinutes: 5, checkIntervalMs: 60_000 },
      deps,
    );
  });

  afterEach(() => {
    timer.stop();
  });

  it('tracks check count', async () => {
    expect(timer.stats.totalChecks).toBe(0);

    await timer.check();
    expect(timer.stats.totalChecks).toBe(1);

    await timer.check();
    expect(timer.stats.totalChecks).toBe(2);
  });

  it('tracks closed and compressed counts', async () => {
    createStaleSession(db, deps, 10);

    await timer.check();
    expect(timer.stats.totalClosed).toBe(1);
    expect(timer.stats.totalCompressed).toBe(1);
  });

  it('tracks last check timestamp', async () => {
    const before = Date.now();
    await timer.check();
    const after = Date.now();

    expect(timer.stats.lastCheckAt).toBeGreaterThanOrEqual(before);
    expect(timer.stats.lastCheckAt).toBeLessThanOrEqual(after);
  });

  it('reports running state', () => {
    expect(timer.stats.running).toBe(false);
    timer.start();
    expect(timer.stats.running).toBe(true);
    timer.stop();
    expect(timer.stats.running).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DEBOUNCE
// ═══════════════════════════════════════════════════════════════════════

describe('SessionIdleTimer — debounce', () => {
  it('skips check if already processing', async () => {
    const db = createTestDb();
    const deps = createDeps(db);

    // Create a compressor that delays
    let resolveCompress: () => void;
    const delayedCompressor = {
      compress: vi.fn().mockImplementation(() => new Promise<void>(r => { resolveCompress = r; })),
      shouldCompress: vi.fn().mockReturnValue(false),
    };
    const delayDeps = { ...deps, compressor: delayedCompressor as any };

    const timer = new SessionIdleTimer(
      { sessionIdleMinutes: 5, checkIntervalMs: 60_000 },
      delayDeps,
    );

    createStaleSession(db, delayDeps, 10);

    // Start first check (will hang on compress)
    const check1 = timer.check();

    // Start second check — should be debounced
    const check2 = await timer.check();
    expect(check2.checked).toBe(false);

    // Resolve the first check
    resolveCompress!();
    await check1;
  });
});
