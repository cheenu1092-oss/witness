/**
 * HTTP API Server Tests — Session 61
 *
 * Tests the VedHttpServer REST API endpoints:
 *   - GET /api/health
 *   - GET /api/stats
 *   - GET /api/search
 *   - GET /api/history
 *   - GET /api/vault/files
 *   - GET /api/vault/file
 *   - GET /api/doctor
 *   - POST /api/approve/:id
 *   - POST /api/deny/:id
 *   - Auth (Bearer token)
 *   - CORS
 *   - Error handling
 *   - Edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { VedHttpServer, type HttpServerConfig } from './http.js';
import { EventBus } from './event-bus.js';

// ── Mock VedApp ──

function createMockApp(overrides: Record<string, unknown> = {}): any {
  const defaultOwnerIds = ['owner-1'];

  return {
    eventBus: overrides.eventBus ?? new EventBus(),
    config: {
      trust: { ownerIds: defaultOwnerIds },
      memory: { vaultPath: '/tmp/test-vault', gitEnabled: false },
      dbPath: '/tmp/test.db',
      ...overrides.config as object,
    },
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      modules: [
        { module: 'event-loop', healthy: true, details: 'ok' },
        { module: 'llm', healthy: true, details: 'connected' },
      ],
    }),
    getStats: vi.fn().mockReturnValue({
      rag: { filesIndexed: 10, chunksStored: 50, ftsEntries: 40, graphEdges: 20, queueDepth: 0 },
      vault: { fileCount: 10, tagCount: 5, typeCount: 3, gitClean: true, gitDirtyCount: 0 },
      audit: { chainLength: 100, chainHead: 'abc123def456' },
      sessions: { active: 1, total: 5 },
    }),
    search: vi.fn().mockResolvedValue({
      results: [
        {
          filePath: 'entities/test.md',
          heading: 'Test Entity',
          content: 'This is test content',
          rrfScore: 0.85,
          sources: ['fts', 'vector'],
        },
      ],
      tokenCount: 42,
      metrics: {
        vectorResultCount: 3,
        ftsResultCount: 2,
        graphResultCount: 1,
        vectorSearchMs: 10,
        ftsSearchMs: 5,
        graphWalkMs: 2,
        fusionMs: 1,
      },
    }),
    getHistory: vi.fn().mockReturnValue([
      {
        id: 1,
        eventType: 'message_received',
        actor: 'user',
        detail: '{"content":"hello"}',
        timestamp: Date.now(),
        sessionId: 'sess-001',
        hash: 'abc123',
        prevHash: null,
      },
    ]),
    verifyAuditChain: vi.fn().mockReturnValue({
      intact: true,
      total: 100,
    }),
    doctor: vi.fn().mockResolvedValue({
      checks: [
        { name: 'Config', status: 'ok', message: 'Valid' },
        { name: 'Database', status: 'ok', message: 'SQLite OK' },
      ],
      passed: 2,
      warned: 0,
      failed: 0,
      infos: 0,
    }),
    memory: {
      vault: {
        listFiles: vi.fn().mockReturnValue(['daily/2026-03-07.md', 'entities/test.md']),
        readFile: vi.fn().mockImplementation((path: string) => {
          if (path === 'entities/test.md') {
            return {
              path: 'entities/test.md',
              frontmatter: { type: 'entity', tags: ['test'] },
              body: '# Test Entity\n\nSome content.',
              links: ['[[other]]'],
            };
          }
          if (path.includes('..') || path.startsWith('/')) {
            throw new Error('Path traversal detected: path resolves outside vault');
          }
          throw new Error('ENOENT: file not found');
        }),
        assertPathSafe: vi.fn(),
      },
    },
    eventLoop: {
      workOrders: {
        approve: vi.fn().mockImplementation((id: string) => {
          if (id === 'valid-wo-id') return { id, status: 'approved' };
          if (id === 'expired-wo') throw new Error('Work order expired');
          return null;
        }),
        deny: vi.fn().mockImplementation((id: string) => {
          if (id === 'valid-wo-id') return { id, status: 'denied' };
          if (id === 'expired-wo') throw new Error('Work order already resolved');
          return null;
        }),
      },
    },
    ...overrides,
  };
}

// ── HTTP Client Helper ──

function httpGet(port: number, path: string, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: any;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') respHeaders[k] = v;
          }
          resolve({ status: res.statusCode ?? 0, body, headers: respHeaders });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port: number, path: string, data?: Record<string, unknown>, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : '';
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: any;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function httpOptions(port: number, path: string): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method: 'OPTIONS' },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        res.on('data', () => {}); // drain
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Tests ──

describe('VedHttpServer', () => {
  let server: VedHttpServer;
  let port: number;
  let mockApp: any;

  beforeEach(async () => {
    mockApp = createMockApp();
    server = new VedHttpServer(mockApp, { port: 0, host: '127.0.0.1' }); // port 0 = random
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // ── Lifecycle ──

  describe('lifecycle', () => {
    it('starts and reports listening', () => {
      expect(server.listening).toBe(true);
      expect(port).toBeGreaterThan(0);
    });

    it('stops cleanly', async () => {
      await server.stop();
      expect(server.listening).toBe(false);
    });

    it('throws on double start', async () => {
      await expect(server.start()).rejects.toThrow('already running');
    });

    it('stop is idempotent', async () => {
      await server.stop();
      await server.stop(); // no throw
      expect(server.listening).toBe(false);
    });
  });

  // ── Health ──

  describe('GET /api/health', () => {
    it('returns healthy status', async () => {
      const res = await httpGet(port, '/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.modules).toHaveLength(2);
    });

    it('returns 503 when unhealthy', async () => {
      mockApp.healthCheck.mockResolvedValueOnce({ healthy: false, modules: [] });
      const res = await httpGet(port, '/api/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
    });
  });

  // ── Stats ──

  describe('GET /api/stats', () => {
    it('returns system stats', async () => {
      const res = await httpGet(port, '/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.rag.filesIndexed).toBe(10);
      expect(res.body.vault.fileCount).toBe(10);
      expect(res.body.audit.chainLength).toBe(100);
      expect(res.body.sessions.active).toBe(1);
    });
  });

  // ── Search ──

  describe('GET /api/search', () => {
    it('searches with query', async () => {
      const res = await httpGet(port, '/api/search?q=test+entity');
      expect(res.status).toBe(200);
      expect(res.body.query).toBe('test entity');
      expect(res.body.resultCount).toBe(1);
      expect(res.body.results[0].filePath).toBe('entities/test.md');
      expect(res.body.metrics.vectorResultCount).toBe(3);
    });

    it('returns 400 without query', async () => {
      const res = await httpGet(port, '/api/search');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing');
    });

    it('accepts n parameter', async () => {
      await httpGet(port, '/api/search?q=test&n=10');
      expect(mockApp.search).toHaveBeenCalledWith('test', expect.objectContaining({ vectorTopK: 10 }));
    });

    it('accepts fts_only parameter', async () => {
      await httpGet(port, '/api/search?q=test&fts_only=true');
      expect(mockApp.search).toHaveBeenCalledWith('test', expect.objectContaining({ sources: ['fts'] }));
    });

    it('rejects invalid n parameter', async () => {
      const res = await httpGet(port, '/api/search?q=test&n=-1');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('between 1 and 100');
    });

    it('rejects n > 100', async () => {
      const res = await httpGet(port, '/api/search?q=test&n=999');
      expect(res.status).toBe(400);
    });
  });

  // ── History ──

  describe('GET /api/history', () => {
    it('returns audit entries', async () => {
      const res = await httpGet(port, '/api/history');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.entries[0].eventType).toBe('message_received');
    });

    it('passes type filter', async () => {
      await httpGet(port, '/api/history?type=tool_executed');
      expect(mockApp.getHistory).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_executed' }));
    });

    it('passes limit', async () => {
      await httpGet(port, '/api/history?limit=50');
      expect(mockApp.getHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });

    it('passes date filters', async () => {
      await httpGet(port, '/api/history?from=2026-03-01&to=2026-03-07');
      const call = mockApp.getHistory.mock.calls[0][0];
      expect(call.from).toBeGreaterThan(0);
      expect(call.to).toBeGreaterThan(call.from);
    });

    it('verifies chain integrity', async () => {
      const res = await httpGet(port, '/api/history?verify=true');
      expect(res.status).toBe(200);
      expect(res.body.intact).toBe(true);
      expect(res.body.total).toBe(100);
    });

    it('rejects invalid limit', async () => {
      const res = await httpGet(port, '/api/history?limit=-5');
      expect(res.status).toBe(400);
    });

    it('rejects invalid from date', async () => {
      const res = await httpGet(port, '/api/history?from=not-a-date');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid from date');
    });
  });

  // ── Vault Files ──

  describe('GET /api/vault/files', () => {
    it('lists vault files', async () => {
      const res = await httpGet(port, '/api/vault/files');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.files).toContain('entities/test.md');
    });

    it('filters by folder', async () => {
      await httpGet(port, '/api/vault/files?folder=entities');
      expect(mockApp.memory.vault.listFiles).toHaveBeenCalledWith('entities');
    });
  });

  // ── Vault File ──

  describe('GET /api/vault/file', () => {
    it('reads a vault file', async () => {
      const res = await httpGet(port, '/api/vault/file?path=entities/test.md');
      expect(res.status).toBe(200);
      expect(res.body.path).toBe('entities/test.md');
      expect(res.body.frontmatter.type).toBe('entity');
      expect(res.body.body).toContain('Test Entity');
      expect(res.body.links).toContain('[[other]]');
    });

    it('returns 400 without path', async () => {
      const res = await httpGet(port, '/api/vault/file');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing');
    });

    it('returns 404 for nonexistent file', async () => {
      const res = await httpGet(port, '/api/vault/file?path=nonexistent.md');
      expect(res.status).toBe(404);
    });

    it('returns 403 for path traversal', async () => {
      mockApp.memory.vault.readFile.mockImplementationOnce(() => {
        throw new Error('Path traversal detected: path resolves outside vault');
      });
      const res = await httpGet(port, '/api/vault/file?path=../../etc/passwd');
      expect(res.status).toBe(403);
    });
  });

  // ── Doctor ──

  describe('GET /api/doctor', () => {
    it('returns diagnostics when healthy', async () => {
      const res = await httpGet(port, '/api/doctor');
      expect(res.status).toBe(200);
      expect(res.body.passed).toBe(2);
      expect(res.body.failed).toBe(0);
    });

    it('returns 503 when checks fail', async () => {
      mockApp.doctor.mockResolvedValueOnce({
        checks: [{ name: 'DB', status: 'fail', message: 'corrupt' }],
        passed: 0,
        warned: 0,
        failed: 1,
        infos: 0,
      });
      const res = await httpGet(port, '/api/doctor');
      expect(res.status).toBe(503);
      expect(res.body.failed).toBe(1);
    });
  });

  // ── Approve ──

  describe('POST /api/approve/:id', () => {
    it('approves a work order', async () => {
      const res = await httpPost(port, '/api/approve/valid-wo-id', { reason: 'looks good' });
      expect(res.status).toBe(200);
      expect(res.body.approved).toBe(true);
      expect(res.body.workOrderId).toBe('valid-wo-id');
    });

    it('returns 404 for unknown work order', async () => {
      const res = await httpPost(port, '/api/approve/unknown-id');
      expect(res.status).toBe(404);
    });

    it('returns 409 for expired work order', async () => {
      const res = await httpPost(port, '/api/approve/expired-wo');
      expect(res.status).toBe(409);
    });

    it('works without body', async () => {
      const res = await httpPost(port, '/api/approve/valid-wo-id');
      expect(res.status).toBe(200);
    });
  });

  // ── Deny ──

  describe('POST /api/deny/:id', () => {
    it('denies a work order', async () => {
      const res = await httpPost(port, '/api/deny/valid-wo-id', { reason: 'not safe' });
      expect(res.status).toBe(200);
      expect(res.body.denied).toBe(true);
      expect(res.body.reason).toBe('not safe');
    });

    it('returns 404 for unknown work order', async () => {
      const res = await httpPost(port, '/api/deny/unknown-id');
      expect(res.status).toBe(404);
    });

    it('returns 409 for already resolved', async () => {
      const res = await httpPost(port, '/api/deny/expired-wo');
      expect(res.status).toBe(409);
    });

    it('uses default reason when none provided', async () => {
      const res = await httpPost(port, '/api/deny/valid-wo-id');
      expect(res.status).toBe(200);
      expect(res.body.reason).toBe('Denied via API');
    });
  });

  // ── Auth ──

  describe('Bearer token auth', () => {
    let authServer: VedHttpServer;
    let authPort: number;

    beforeEach(async () => {
      authServer = new VedHttpServer(mockApp, { port: 0, host: '127.0.0.1', apiToken: 'secret-token-123' });
      authPort = await authServer.start();
    });

    afterEach(async () => {
      await authServer.stop();
    });

    it('rejects requests without token', async () => {
      const res = await httpGet(authPort, '/api/health');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects requests with wrong token', async () => {
      const res = await httpGet(authPort, '/api/health', { Authorization: 'Bearer wrong-token' });
      expect(res.status).toBe(401);
    });

    it('accepts requests with correct token', async () => {
      const res = await httpGet(authPort, '/api/health', { Authorization: 'Bearer secret-token-123' });
      expect(res.status).toBe(200);
    });

    it('rejects malformed auth header', async () => {
      const res = await httpGet(authPort, '/api/health', { Authorization: 'Token secret-token-123' });
      expect(res.status).toBe(401); // wrong scheme
    });
  });

  // ── CORS ──

  describe('CORS', () => {
    it('sets CORS headers on responses', async () => {
      const res = await httpGet(port, '/api/health');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('handles OPTIONS preflight', async () => {
      const res = await httpOptions(port, '/api/health');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-methods']).toContain('GET');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    });

    it('uses custom CORS origin', async () => {
      const corsServer = new VedHttpServer(mockApp, { port: 0, host: '127.0.0.1', corsOrigin: 'https://my-app.com' });
      const corsPort = await corsServer.start();
      try {
        const res = await httpGet(corsPort, '/api/health');
        expect(res.headers['access-control-allow-origin']).toBe('https://my-app.com');
      } finally {
        await corsServer.stop();
      }
    });
  });

  // ── 404 ──

  describe('routing', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await httpGet(port, '/api/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not found');
    });

    it('serves dashboard at root path', async () => {
      const res = await httpGet(port, '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Ved');
    });

    it('returns 404 for POST to GET-only endpoint', async () => {
      const res = await httpPost(port, '/api/health');
      expect(res.status).toBe(404);
    });

    it('strips trailing slashes', async () => {
      const res = await httpGet(port, '/api/health/');
      expect(res.status).toBe(200);
    });
  });

  // ── Response format ──

  describe('response format', () => {
    it('returns JSON content type', async () => {
      const res = await httpGet(port, '/api/health');
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('includes X-Powered-By header', async () => {
      const res = await httpGet(port, '/api/health');
      expect(res.headers['x-powered-by']).toBe('Ved');
    });
  });

  // ── Error handling ──

  describe('error handling', () => {
    it('returns 500 when stats throws', async () => {
      mockApp.getStats.mockImplementationOnce(() => {
        throw new Error('Database locked');
      });
      const res = await httpGet(port, '/api/stats');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Database locked');
    });

    it('returns 500 when search throws', async () => {
      mockApp.search.mockRejectedValueOnce(new Error('Embedding service down'));
      const res = await httpGet(port, '/api/search?q=test');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Embedding service down');
    });

    it('handles non-Error throws', async () => {
      mockApp.getStats.mockImplementationOnce(() => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      });
      const res = await httpGet(port, '/api/stats');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('string error');
    });
  });

  // ── URL encoding ──

  describe('URL encoding', () => {
    it('decodes query parameters', async () => {
      await httpGet(port, '/api/search?q=hello%20world');
      expect(mockApp.search).toHaveBeenCalledWith('hello world', expect.anything());
    });

    it('decodes path parameters in approve', async () => {
      mockApp.eventLoop.workOrders.approve.mockReturnValueOnce({ id: 'wo/123', status: 'approved' });
      const res = await httpPost(port, '/api/approve/wo%2F123');
      expect(res.status).toBe(200);
      expect(mockApp.eventLoop.workOrders.approve).toHaveBeenCalledWith('wo/123', 'owner-1');
    });
  });

  // ── No owner IDs configured ──

  describe('missing owner IDs', () => {
    it('returns 500 for approve without owners', async () => {
      mockApp.config.trust.ownerIds = [];
      const res = await httpPost(port, '/api/approve/valid-wo-id');
      expect(res.status).toBe(500);
      expect(res.body.error).toContain('No owner IDs');
    });

    it('returns 500 for deny without owners', async () => {
      mockApp.config.trust.ownerIds = [];
      const res = await httpPost(port, '/api/deny/valid-wo-id');
      expect(res.status).toBe(500);
      expect(res.body.error).toContain('No owner IDs');
    });
  });
});

// ── SSE Event Stream Tests ──

describe('SSE: GET /api/events', () => {
  let mockApp: any;
  let server: VedHttpServer;
  let port: number;
  let eventBus: EventBus;

  beforeEach(async () => {
    eventBus = new EventBus();
    mockApp = createMockApp({ eventBus });
    server = new VedHttpServer(mockApp, { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  /** Helper: connect to SSE and collect events */
  function connectSSE(
    path: string = '/api/events',
    options: { token?: string } = {},
  ): Promise<{
    events: Array<{ event: string; data: string; id: string }>;
    raw: string;
    close: () => void;
    waitForEvents: (count: number, timeoutMs?: number) => Promise<void>;
  }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

      const req = request({
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      }, (res) => {
        const events: Array<{ event: string; data: string; id: string }> = [];
        let raw = '';
        let pendingResolve: (() => void) | null = null;
        let targetCount = 0;

        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          raw += text;

          // Parse SSE events
          const lines = text.split('\n');
          let currentEvent = '';
          let currentData = '';
          let currentId = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) currentEvent = line.slice(7);
            else if (line.startsWith('data: ')) currentData = line.slice(6);
            else if (line.startsWith('id: ')) currentId = line.slice(4);
            else if (line === '' && currentData) {
              events.push({ event: currentEvent, data: currentData, id: currentId });
              currentEvent = '';
              currentData = '';
              currentId = '';
              if (pendingResolve && events.length >= targetCount) {
                pendingResolve();
                pendingResolve = null;
              }
            }
          }
        });

        const close = () => { req.destroy(); };

        const waitForEvents = (count: number, timeoutMs = 2000): Promise<void> => {
          if (events.length >= count) return Promise.resolve();
          return new Promise((resolve, reject) => {
            targetCount = count;
            pendingResolve = resolve;
            const timer = setTimeout(() => {
              pendingResolve = null;
              reject(new Error(`Timeout waiting for ${count} events (got ${events.length})`));
            }, timeoutMs);
            // Clear timer if resolved
            const origResolve = pendingResolve;
            pendingResolve = () => { clearTimeout(timer); resolve(); };
          });
        };

        // Wait for initial :ok comment before resolving
        const initTimer = setTimeout(() => resolve({ events, raw, close, waitForEvents }), 100);
        res.once('data', () => {
          clearTimeout(initTimer);
          // Small delay to let initial comment arrive
          setTimeout(() => resolve({ events, raw, close, waitForEvents }), 50);
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  it('returns SSE content type', async () => {
    const sse = await connectSSE();
    try {
      expect(sse.raw).toContain(':ok');
    } finally {
      sse.close();
    }
  });

  it('sends initial :ok comment', async () => {
    const sse = await connectSSE();
    try {
      expect(sse.raw.startsWith(':ok\n\n')).toBe(true);
    } finally {
      sse.close();
    }
  });

  it('delivers events in real-time', async () => {
    const sse = await connectSSE();
    try {
      // Emit an event through the bus
      eventBus.emit({
        id: 'test_001',
        timestamp: Date.now(),
        type: 'message_received',
        actor: 'user1',
        detail: { content: 'hello' },
        hash: 'abc',
      });

      await sse.waitForEvents(1);

      expect(sse.events).toHaveLength(1);
      expect(sse.events[0].event).toBe('message_received');
      expect(sse.events[0].id).toBe('test_001');

      const data = JSON.parse(sse.events[0].data);
      expect(data.type).toBe('message_received');
      expect(data.actor).toBe('user1');
      expect(data.detail.content).toBe('hello');
    } finally {
      sse.close();
    }
  });

  it('delivers multiple events in order', async () => {
    const sse = await connectSSE();
    try {
      eventBus.emit({
        id: 'e1', timestamp: Date.now(), type: 'startup', actor: 'ved', detail: {}, hash: 'h1',
      });
      eventBus.emit({
        id: 'e2', timestamp: Date.now(), type: 'llm_call', actor: 'ved', detail: {}, hash: 'h2',
      });
      eventBus.emit({
        id: 'e3', timestamp: Date.now(), type: 'shutdown', actor: 'ved', detail: {}, hash: 'h3',
      });

      await sse.waitForEvents(3);

      expect(sse.events.map(e => e.id)).toEqual(['e1', 'e2', 'e3']);
      expect(sse.events.map(e => e.event)).toEqual(['startup', 'llm_call', 'shutdown']);
    } finally {
      sse.close();
    }
  });

  it('filters events by type', async () => {
    const sse = await connectSSE('/api/events?types=llm_call,llm_response');
    try {
      eventBus.emit({
        id: 'e1', timestamp: Date.now(), type: 'message_received', actor: 'user', detail: {}, hash: 'h1',
      });
      eventBus.emit({
        id: 'e2', timestamp: Date.now(), type: 'llm_call', actor: 'ved', detail: {}, hash: 'h2',
      });
      eventBus.emit({
        id: 'e3', timestamp: Date.now(), type: 'tool_executed', actor: 'ved', detail: {}, hash: 'h3',
      });
      eventBus.emit({
        id: 'e4', timestamp: Date.now(), type: 'llm_response', actor: 'ved', detail: {}, hash: 'h4',
      });

      await sse.waitForEvents(2);

      expect(sse.events).toHaveLength(2);
      expect(sse.events[0].event).toBe('llm_call');
      expect(sse.events[1].event).toBe('llm_response');
    } finally {
      sse.close();
    }
  });

  it('no filter delivers all events', async () => {
    const sse = await connectSSE('/api/events');
    try {
      eventBus.emit({ id: 'e1', timestamp: Date.now(), type: 'startup', actor: 'ved', detail: {}, hash: 'h1' });
      eventBus.emit({ id: 'e2', timestamp: Date.now(), type: 'shutdown', actor: 'ved', detail: {}, hash: 'h2' });

      await sse.waitForEvents(2);
      expect(sse.events).toHaveLength(2);
    } finally {
      sse.close();
    }
  });

  it('cleans up subscription on client disconnect', async () => {
    const sse = await connectSSE();
    const initialCount = eventBus.subscriberCount;
    expect(initialCount).toBeGreaterThan(0);

    sse.close();

    // Wait for cleanup
    await new Promise(r => setTimeout(r, 100));
    expect(eventBus.subscriberCount).toBe(initialCount - 1);
  });

  it('stats endpoint includes SSE connection count', async () => {
    // Connect an SSE client
    const sse = await connectSSE();
    try {
      const res = await httpGet(port, '/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.sse).toBeDefined();
      expect(res.body.sse.activeConnections).toBe(1);
      expect(res.body.sse.busSubscribers).toBeGreaterThanOrEqual(1);
    } finally {
      sse.close();
    }
  });

  it('stop() closes all SSE connections', async () => {
    const sse = await connectSSE();
    const countBefore = eventBus.subscriberCount;
    expect(countBefore).toBeGreaterThan(0);

    await server.stop();

    // Re-create server for afterEach
    server = new VedHttpServer(mockApp, { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  it('requires auth when token is configured', async () => {
    await server.stop();
    server = new VedHttpServer(mockApp, { port: 0, host: '127.0.0.1', apiToken: 'secret123' });
    port = await server.start();

    // Without token
    const res = await httpGet(port, '/api/events');
    expect(res.status).toBe(401);

    // With token — should connect
    const sse = await connectSSE('/api/events', { token: 'secret123' });
    try {
      expect(sse.raw).toContain(':ok');
    } finally {
      sse.close();
    }
  });
});
