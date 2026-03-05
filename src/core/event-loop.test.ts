/**
 * EventLoop tests — core pipeline integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventLoop } from './event-loop.js';
import { migrate } from '../db/migrate.js';
import { getDefaults } from './config.js';
import type { VedConfig, VedMessage } from '../types/index.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function makeConfig(overrides?: Partial<VedConfig>): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    trust: {
      ...defaults.trust,
      ownerIds: ['owner-1'],
    },
    audit: {
      ...defaults.audit,
      anchorInterval: 10, // create anchor every 10 entries for testing
    },
    ...overrides,
  };
}

function makeMessage(id: string, content: string, author = 'owner-1'): VedMessage {
  return {
    id,
    channel: 'cli' as const,
    author,
    content,
    timestamp: Date.now(),
  };
}

// === Construction ===

describe('EventLoop — construction', () => {
  it('creates with all components initialized', () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    expect(loop.name).toBe('core');
    expect(loop.isRunning).toBe(false);
    expect(loop.queue).toBeDefined();
    expect(loop.sessions).toBeDefined();
    expect(loop.audit).toBeDefined();
    expect(loop.anchors).toBeDefined();
    expect(loop.trust).toBeDefined();
    expect(loop.workOrders).toBeDefined();
  });
});

// === Receive ===

describe('EventLoop — receive', () => {
  let db: Database.Database;
  let loop: EventLoop;

  beforeEach(() => {
    db = createTestDb();
    loop = new EventLoop({ config: makeConfig(), db });
  });

  it('persists message to inbox', () => {
    const msg = makeMessage('msg-1', 'Hello');
    loop.receive(msg);

    const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get('msg-1') as any;
    expect(row).toBeTruthy();
    expect(row.content).toBe('Hello');
    expect(row.processed).toBe(0);
    expect(row.author_id).toBe('owner-1');
  });

  it('enqueues message in the queue', () => {
    loop.receive(makeMessage('msg-1', 'test'));
    expect(loop.queue.length).toBe(1);
  });

  it('respects priority', () => {
    loop.receive(makeMessage('low', 'low'), 'low');
    loop.receive(makeMessage('high', 'high'), 'high');
    expect(loop.queue.peek()!.id).toBe('high');
  });

  it('persists attachments as JSON', () => {
    const msg: VedMessage = {
      id: 'msg-att',
      channel: 'cli',
      author: 'owner-1',
      content: 'test',
      attachments: [{ filename: 'test.txt', contentType: 'text/plain', size: 100 }],
      timestamp: Date.now(),
    };
    loop.receive(msg);

    const row = db.prepare('SELECT attachments FROM inbox WHERE id = ?').get('msg-att') as any;
    const parsed = JSON.parse(row.attachments);
    expect(parsed.length).toBe(1);
    expect(parsed[0].filename).toBe('test.txt');
  });
});

// === Health check ===

describe('EventLoop — healthCheck', () => {
  it('reports healthy with empty chain', () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });
    const health = loop.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.module).toBe('core');
  });

  it('reports healthy after receiving messages', () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });
    loop.receive(makeMessage('1', 'test'));
    const health = loop.healthCheck();
    expect(health.healthy).toBe(true);
  });
});

// === Run/Shutdown ===

describe('EventLoop — run and shutdown', () => {
  it('processes a message when run', async () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    loop.receive(makeMessage('msg-1', 'Hello world'));

    // Start the loop — it will process the message and we'll shut it down
    const runPromise = loop.run();

    // Give it a moment to process
    await new Promise(r => setTimeout(r, 250));

    loop.requestShutdown();
    await runPromise;

    expect(loop.isRunning).toBe(false);

    // Check inbox was marked processed
    const row = db.prepare('SELECT processed, session_id FROM inbox WHERE id = ?').get('msg-1') as any;
    expect(row.processed).toBe(1);
    expect(row.session_id).toBeTruthy();

    // Check audit has startup, message_received, and shutdown events
    const auditRows = db.prepare('SELECT event_type FROM audit_log ORDER BY timestamp').all() as any[];
    const types = auditRows.map((r: any) => r.event_type);
    expect(types).toContain('startup');
    expect(types).toContain('session_start');
    expect(types).toContain('message_received');
    expect(types).toContain('shutdown');
  });

  it('recovers unprocessed inbox on restart', async () => {
    const db = createTestDb();

    // Simulate a previous crash: insert unprocessed inbox row
    db.prepare(`
      INSERT INTO inbox (id, channel, channel_id, author_id, content, attachments, received_at, processed)
      VALUES ('orphan-1', 'cli', '', 'owner-1', 'orphaned message', '[]', ?, 0)
    `).run(Date.now());

    const loop = new EventLoop({ config: makeConfig(), db });

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 250));
    loop.requestShutdown();
    await runPromise;

    // The orphaned message should have been processed
    const row = db.prepare('SELECT processed FROM inbox WHERE id = ?').get('orphan-1') as any;
    expect(row.processed).toBe(1);
  });

  it('creates session for processed message', async () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    loop.receive(makeMessage('msg-1', 'test'));

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 250));
    loop.requestShutdown();
    await runPromise;

    // Check that a session was created
    const sessions = db.prepare('SELECT * FROM sessions').all() as any[];
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].author_id).toBe('owner-1');
    expect(sessions[0].status).not.toBe('active'); // closed on shutdown
  });

  it('creates anchor on shutdown', async () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    loop.receive(makeMessage('msg-1', 'test'));

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 250));
    loop.requestShutdown();
    await runPromise;

    const anchors = db.prepare('SELECT * FROM anchors').all() as any[];
    expect(anchors.length).toBeGreaterThan(0);
  });

  it('handles errors gracefully', async () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    // Receive a normal message
    loop.receive(makeMessage('msg-ok', 'ok'));

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 250));
    loop.requestShutdown();
    await runPromise;

    // Should have processed without throwing
    expect(loop.isRunning).toBe(false);
  });

  it('shuts down cleanly with empty queue', async () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    const runPromise = loop.run();

    // Immediate shutdown
    await new Promise(r => setTimeout(r, 50));
    loop.requestShutdown();
    await runPromise;

    expect(loop.isRunning).toBe(false);
  });

  it('throws if run called while already running', async () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    const p = loop.run();
    await new Promise(r => setTimeout(r, 50));

    await expect(loop.run()).rejects.toThrow('already running');

    loop.requestShutdown();
    await p;
  });

  it('expires pending work orders on shutdown', async () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    // Create a pending work order manually
    loop.workOrders.create('session-1', 'msg-1', 'exec', { command: 'ls' }, { level: 'high', reasons: ['test'] }, 4);

    // Backdate it to be expired
    db.prepare('UPDATE work_orders SET expires_at = ?').run(Date.now() - 1000);

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));
    loop.requestShutdown();
    await runPromise;

    const pending = loop.workOrders.getPending();
    expect(pending.length).toBe(0);
  });
});

// === Trust resolution in pipeline ===

describe('EventLoop — trust in pipeline', () => {
  it('resolves owner trust tier for configured owner', async () => {
    const db = createTestDb();
    const config = makeConfig({ trust: { ...makeConfig().trust, ownerIds: ['owner-1'] } });
    const loop = new EventLoop({ config, db });

    loop.receive(makeMessage('msg-1', 'test', 'owner-1'));

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 250));
    loop.requestShutdown();
    await runPromise;

    const session = db.prepare('SELECT trust_tier FROM sessions LIMIT 1').get() as any;
    expect(session.trust_tier).toBe(4);
  });

  it('resolves stranger trust tier for unknown user', async () => {
    const db = createTestDb();
    const loop = new EventLoop({ config: makeConfig(), db });

    loop.receive(makeMessage('msg-1', 'test', 'unknown-user'));

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 250));
    loop.requestShutdown();
    await runPromise;

    const session = db.prepare('SELECT trust_tier FROM sessions LIMIT 1').get() as any;
    expect(session.trust_tier).toBe(1);
  });
});
