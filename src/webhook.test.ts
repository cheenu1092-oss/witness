/**
 * Tests for WebhookManager — event-driven HTTP webhook delivery.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventBus, type VedEvent } from './event-bus.js';
import { WebhookManager } from './webhook.js';
import { migrate } from './db/migrate.js';

// ── Test Helpers ──

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function makeEvent(overrides: Partial<VedEvent> = {}): VedEvent {
  return {
    id: `evt_${Date.now()}`,
    timestamp: Date.now(),
    type: 'message_received',
    actor: 'user1',
    detail: { content: 'hello' },
    hash: 'abc123',
    ...overrides,
  };
}

/**
 * Create a local HTTP server for testing webhook delivery.
 * Returns the server, URL, and arrays of received requests.
 */
function createTestServer(options: {
  statusCode?: number;
  delay?: number;
  responseBody?: string;
} = {}): Promise<{
  server: Server;
  url: string;
  requests: Array<{ body: string; headers: Record<string, string | string[] | undefined> }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = [];
    const statusCode = options.statusCode ?? 200;
    const delay = options.delay ?? 0;
    const responseBody = options.responseBody ?? '{"ok":true}';

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        requests.push({ body, headers: req.headers });

        const respond = () => {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(responseBody);
        };

        if (delay > 0) {
          setTimeout(respond, delay);
        } else {
          respond();
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        server,
        url,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ── Tests ──

describe('WebhookManager', () => {
  let db: Database.Database;
  let bus: EventBus;
  let mgr: WebhookManager;

  beforeEach(() => {
    db = createTestDb();
    bus = new EventBus();
    mgr = new WebhookManager(db, bus);
  });

  afterEach(() => {
    mgr.stop();
    bus.clear();
    db.close();
  });

  // ── CRUD ──

  describe('CRUD', () => {
    it('should register a webhook with defaults', () => {
      const wh = mgr.add({ name: 'test', url: 'http://example.com/hook' });
      expect(wh.id).toBeTruthy();
      expect(wh.name).toBe('test');
      expect(wh.url).toBe('http://example.com/hook');
      expect(wh.secret).toBeNull();
      expect(wh.eventTypes).toEqual(['*']);
      expect(wh.enabled).toBe(true);
    });

    it('should register a webhook with custom settings', () => {
      const wh = mgr.add({
        name: 'filtered',
        url: 'https://example.com/hook',
        secret: 'my-secret',
        eventTypes: ['message_received', 'llm_call'],
      });
      expect(wh.secret).toBe('my-secret');
      expect(wh.eventTypes).toEqual(['message_received', 'llm_call']);
    });

    it('should reject duplicate names', () => {
      mgr.add({ name: 'unique', url: 'http://example.com/1' });
      expect(() => mgr.add({ name: 'unique', url: 'http://example.com/2' })).toThrow();
    });

    it('should reject invalid URLs', () => {
      expect(() => mgr.add({ name: 'bad', url: 'not-a-url' })).toThrow('Invalid webhook URL');
      expect(() => mgr.add({ name: 'bad', url: 'ftp://example.com' })).toThrow('Unsupported protocol');
    });

    it('should list webhooks', () => {
      mgr.add({ name: 'a', url: 'http://example.com/a' });
      mgr.add({ name: 'b', url: 'http://example.com/b' });
      const list = mgr.list();
      expect(list).toHaveLength(2);
      expect(list.map(w => w.name)).toEqual(['a', 'b']);
    });

    it('should get webhook by ID', () => {
      const wh = mgr.add({ name: 'lookup', url: 'http://example.com/look' });
      const found = mgr.get(wh.id);
      expect(found?.name).toBe('lookup');
    });

    it('should get webhook by name', () => {
      mgr.add({ name: 'named', url: 'http://example.com/named' });
      const found = mgr.get('named');
      expect(found?.name).toBe('named');
    });

    it('should return null for unknown webhook', () => {
      expect(mgr.get('nonexistent')).toBeNull();
    });

    it('should remove a webhook by name', () => {
      mgr.add({ name: 'removable', url: 'http://example.com/rm' });
      expect(mgr.remove('removable')).toBe(true);
      expect(mgr.get('removable')).toBeNull();
    });

    it('should return false when removing nonexistent webhook', () => {
      expect(mgr.remove('nope')).toBe(false);
    });

    it('should toggle webhook enabled/disabled', () => {
      mgr.add({ name: 'togglable', url: 'http://example.com/tog' });
      const disabled = mgr.toggle('togglable', false);
      expect(disabled?.enabled).toBe(false);
      const enabled = mgr.toggle('togglable', true);
      expect(enabled?.enabled).toBe(true);
    });

    it('should return null when toggling nonexistent webhook', () => {
      expect(mgr.toggle('nope', true)).toBeNull();
    });

    it('should update webhook URL and secret', () => {
      mgr.add({ name: 'updatable', url: 'http://example.com/old' });
      const updated = mgr.update('updatable', {
        url: 'http://example.com/new',
        secret: 'new-secret',
      });
      expect(updated?.url).toBe('http://example.com/new');
      expect(updated?.secret).toBe('new-secret');
    });

    it('should update webhook event types', () => {
      mgr.add({ name: 'filtered', url: 'http://example.com/f' });
      const updated = mgr.update('filtered', {
        eventTypes: ['tool_executed'],
      });
      expect(updated?.eventTypes).toEqual(['tool_executed']);
    });

    it('should return null when updating nonexistent webhook', () => {
      expect(mgr.update('nope', { url: 'http://example.com' })).toBeNull();
    });
  });

  // ── Delivery ──

  describe('Delivery', () => {
    let testServer: Awaited<ReturnType<typeof createTestServer>>;

    afterEach(async () => {
      if (testServer) await testServer.close();
    });

    it('should deliver events to registered webhook', async () => {
      testServer = await createTestServer();
      mgr.add({ name: 'deliver-test', url: testServer.url });
      mgr.start();

      const event = makeEvent({ id: 'evt_deliver_1' });
      await mgr.deliverEvent(event);

      // Wait for async delivery
      await new Promise(r => setTimeout(r, 500));

      expect(testServer.requests).toHaveLength(1);
      const payload = JSON.parse(testServer.requests[0].body);
      expect(payload.id).toBe('evt_deliver_1');
      expect(payload.type).toBe('message_received');
      expect(payload.webhookName).toBe('deliver-test');
    });

    it('should include HMAC signature when secret is set', async () => {
      testServer = await createTestServer();
      mgr.add({ name: 'signed', url: testServer.url, secret: 'test-secret' });
      mgr.start();

      await mgr.deliverEvent(makeEvent());
      await new Promise(r => setTimeout(r, 500));

      expect(testServer.requests).toHaveLength(1);
      const sig = testServer.requests[0].headers['x-ved-signature-256'];
      expect(sig).toBeTruthy();
      expect(String(sig)).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('should include User-Agent header', async () => {
      testServer = await createTestServer();
      mgr.add({ name: 'ua-test', url: testServer.url });
      mgr.start();

      await mgr.deliverEvent(makeEvent());
      await new Promise(r => setTimeout(r, 500));

      expect(testServer.requests[0].headers['user-agent']).toBe('Ved-Webhook/0.1.0');
    });

    it('should filter events by type', async () => {
      testServer = await createTestServer();
      mgr.add({
        name: 'filtered',
        url: testServer.url,
        eventTypes: ['tool_executed'],
      });
      mgr.start();

      // Send non-matching event
      await mgr.deliverEvent(makeEvent({ type: 'message_received' }));
      await new Promise(r => setTimeout(r, 300));
      expect(testServer.requests).toHaveLength(0);

      // Send matching event
      await mgr.deliverEvent(makeEvent({ type: 'tool_executed' }));
      await new Promise(r => setTimeout(r, 500));
      expect(testServer.requests).toHaveLength(1);
    });

    it('should not deliver to disabled webhooks', async () => {
      testServer = await createTestServer();
      mgr.add({ name: 'disabled-wh', url: testServer.url });
      mgr.toggle('disabled-wh', false);
      mgr.start();

      await mgr.deliverEvent(makeEvent());
      await new Promise(r => setTimeout(r, 300));
      expect(testServer.requests).toHaveLength(0);
    });

    it('should record successful delivery', async () => {
      testServer = await createTestServer();
      mgr.add({ name: 'record-test', url: testServer.url });
      mgr.start();

      await mgr.deliverEvent(makeEvent({ id: 'evt_record_1' }));
      await new Promise(r => setTimeout(r, 500));

      const deliveries = mgr.deliveries('record-test');
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe('success');
      expect(deliveries[0].statusCode).toBe(200);
      expect(deliveries[0].durationMs).toBeGreaterThan(0);
    });

    it('should record failed delivery with HTTP error', async () => {
      testServer = await createTestServer({ statusCode: 500 });
      mgr.add({ name: 'fail-test', url: testServer.url });
      mgr.start();

      await mgr.deliverEvent(makeEvent());
      await new Promise(r => setTimeout(r, 500));

      const deliveries = mgr.deliveries('fail-test');
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe('failed');
      expect(deliveries[0].statusCode).toBe(500);
      expect(deliveries[0].nextRetryAt).toBeTruthy();
    });

    it('should record dead delivery after max retries', async () => {
      testServer = await createTestServer({ statusCode: 503 });
      const wh = mgr.add({ name: 'dead-test', url: testServer.url });
      mgr.start();

      // Simulate event
      await mgr.deliverEvent(makeEvent({ id: 'evt_dead_1' }));
      await new Promise(r => setTimeout(r, 500));

      // Get the delivery and manually set it as attempt 3
      const deliveries = mgr.deliveries('dead-test');
      expect(deliveries).toHaveLength(1);

      // Update to simulate it's on its 3rd attempt via the retry path
      db.prepare(
        "UPDATE webhook_deliveries SET attempt = 3, status = 'failed', next_retry_at = ? WHERE id = ?"
      ).run(Date.now() - 1000, deliveries[0].id);

      // Process retries (this should mark it dead since attempt+1 > MAX_ATTEMPTS)
      await mgr.processRetries();
      await new Promise(r => setTimeout(r, 500));

      // Check the delivery was marked dead
      const updated = mgr.deliveries('dead-test');
      // Should have the original delivery updated to dead (attempt 4 > MAX_ATTEMPTS=3 → dead)
      const deadEntry = updated.find(d => d.status === 'dead');
      expect(deadEntry).toBeTruthy();
    });

    it('should deliver to multiple matching webhooks', async () => {
      testServer = await createTestServer();
      const server2 = await createTestServer();

      try {
        mgr.add({ name: 'multi-1', url: testServer.url });
        mgr.add({ name: 'multi-2', url: server2.url });
        mgr.start();

        await mgr.deliverEvent(makeEvent());
        await new Promise(r => setTimeout(r, 500));

        expect(testServer.requests).toHaveLength(1);
        expect(server2.requests).toHaveLength(1);
      } finally {
        await server2.close();
      }
    });

    it('should include custom headers from metadata', async () => {
      testServer = await createTestServer();
      mgr.add({
        name: 'custom-headers',
        url: testServer.url,
        metadata: { headers: { 'X-Custom': 'my-value' } },
      });
      mgr.start();

      await mgr.deliverEvent(makeEvent());
      await new Promise(r => setTimeout(r, 500));

      expect(testServer.requests[0].headers['x-custom']).toBe('my-value');
    });
  });

  // ── EventBus Integration ──

  describe('EventBus Integration', () => {
    let testServer: Awaited<ReturnType<typeof createTestServer>>;

    afterEach(async () => {
      if (testServer) await testServer.close();
    });

    it('should auto-deliver when EventBus emits events', async () => {
      testServer = await createTestServer();
      mgr.add({ name: 'bus-test', url: testServer.url });
      mgr.start();

      // Emit through EventBus (which WebhookManager subscribes to)
      bus.emit(makeEvent({ id: 'evt_bus_1' }));
      await new Promise(r => setTimeout(r, 500));

      expect(testServer.requests).toHaveLength(1);
      const payload = JSON.parse(testServer.requests[0].body);
      expect(payload.id).toBe('evt_bus_1');
    });

    it('should stop receiving events after stop()', async () => {
      testServer = await createTestServer();
      mgr.add({ name: 'stop-test', url: testServer.url });
      mgr.start();

      bus.emit(makeEvent());
      await new Promise(r => setTimeout(r, 300));
      expect(testServer.requests).toHaveLength(1);

      mgr.stop();
      bus.emit(makeEvent());
      await new Promise(r => setTimeout(r, 300));
      expect(testServer.requests).toHaveLength(1); // no new request
    });
  });

  // ── Stats ──

  describe('Stats', () => {
    it('should return correct stats', async () => {
      mgr.add({ name: 'stats-1', url: 'http://example.com/1' });
      mgr.add({ name: 'stats-2', url: 'http://example.com/2' });
      mgr.toggle('stats-2', false);

      const stats = mgr.stats();
      expect(stats.totalWebhooks).toBe(2);
      expect(stats.enabledWebhooks).toBe(1);
      expect(stats.pendingDeliveries).toBe(0);
      expect(stats.failedDeliveries).toBe(0);
      expect(stats.deadDeliveries).toBe(0);
      expect(stats.successfulLast24h).toBe(0);
    });
  });

  // ── Retry Processing ──

  describe('Retry Processing', () => {
    let testServer: Awaited<ReturnType<typeof createTestServer>>;

    afterEach(async () => {
      if (testServer) await testServer.close();
    });

    it('should process retryable deliveries', async () => {
      testServer = await createTestServer(); // now succeeds
      const wh = mgr.add({ name: 'retry-test', url: testServer.url });
      mgr.start();

      // Insert a failed delivery with past retry time
      db.prepare(`
        INSERT INTO webhook_deliveries
          (id, webhook_id, event_id, event_type, attempt, status, request_body, started_at, next_retry_at)
        VALUES (?, ?, ?, ?, 1, 'failed', ?, ?, ?)
      `).run(
        'del_retry_1',
        wh.id,
        'evt_retry_1',
        'message_received',
        JSON.stringify({ id: 'evt_retry_1', type: 'message_received', actor: 'test', detail: {}, hash: 'x', timestamp: Date.now(), webhookName: 'retry-test', deliveredAt: Date.now() }),
        Date.now() - 60000,
        Date.now() - 1000,
      );

      const processed = await mgr.processRetries();
      await new Promise(r => setTimeout(r, 500));

      expect(processed).toBe(1);
      expect(testServer.requests).toHaveLength(1);
    });

    it('should not process retries when stopped', async () => {
      testServer = await createTestServer();
      mgr.add({ name: 'stopped-retry', url: testServer.url });
      mgr.stop(); // stop before processing

      const processed = await mgr.processRetries();
      expect(processed).toBe(0);
    });

    it('should skip retries with future next_retry_at', async () => {
      testServer = await createTestServer();
      const wh = mgr.add({ name: 'future-retry', url: testServer.url });
      mgr.start();

      // Insert failed delivery with FUTURE retry time
      db.prepare(`
        INSERT INTO webhook_deliveries
          (id, webhook_id, event_id, event_type, attempt, status, request_body, started_at, next_retry_at)
        VALUES (?, ?, ?, ?, 1, 'failed', ?, ?, ?)
      `).run(
        'del_future_1', wh.id, 'evt_future', 'message_received',
        '{}', Date.now() - 60000, Date.now() + 60000, // 1 min in future
      );

      const processed = await mgr.processRetries();
      expect(processed).toBe(0);
    });
  });

  // ── Edge Cases ──

  describe('Edge Cases', () => {
    it('should handle connection error gracefully', async () => {
      // Use a port that's definitely not listening
      mgr.add({ name: 'conn-error', url: 'http://127.0.0.1:1' });
      mgr.start();

      await mgr.deliverEvent(makeEvent());
      await new Promise(r => setTimeout(r, 1000));

      const deliveries = mgr.deliveries('conn-error');
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe('failed');
      expect(deliveries[0].error).toBeTruthy();
    });

    it('should return empty deliveries for unknown webhook', () => {
      const deliveries = mgr.deliveries('nonexistent');
      expect(deliveries).toEqual([]);
    });

    it('should handle multiple rapid events', async () => {
      const testServer = await createTestServer();
      try {
        mgr.add({ name: 'rapid', url: testServer.url });
        mgr.start();

        // Fire 5 events rapidly
        for (let i = 0; i < 5; i++) {
          await mgr.deliverEvent(makeEvent({ id: `evt_rapid_${i}` }));
        }

        await new Promise(r => setTimeout(r, 1000));
        expect(testServer.requests).toHaveLength(5);
      } finally {
        await testServer.close();
      }
    });

    it('should not start twice', () => {
      mgr.start();
      mgr.start(); // should be a no-op
      // Verify only one subscription
      expect(bus.subscriberCount).toBe(1);
    });

    it('should safely stop when not started', () => {
      mgr.stop(); // should not throw
    });
  });
});
