/**
 * Dashboard Tests — validates HTML generation and HTTP serving.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDashboardHtml } from './dashboard.js';
import { VedHttpServer } from './http.js';
import { EventBus } from './event-bus.js';
import http from 'node:http';

// ── getDashboardHtml unit tests ──

describe('getDashboardHtml', () => {
  it('returns valid HTML document', () => {
    const html = getDashboardHtml();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html).toContain('<title>Ved — Dashboard</title>');
  });

  it('contains all navigation panels', () => {
    const html = getDashboardHtml();
    expect(html).toContain('data-panel="overview"');
    expect(html).toContain('data-panel="events"');
    expect(html).toContain('data-panel="search"');
    expect(html).toContain('data-panel="history"');
    expect(html).toContain('data-panel="vault"');
    expect(html).toContain('data-panel="doctor"');
  });

  it('contains panel containers matching nav buttons', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="panel-overview"');
    expect(html).toContain('id="panel-events"');
    expect(html).toContain('id="panel-search"');
    expect(html).toContain('id="panel-history"');
    expect(html).toContain('id="panel-vault"');
    expect(html).toContain('id="panel-doctor"');
  });

  it('includes SSE connection indicator', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="sse-dot"');
    expect(html).toContain('id="sse-status"');
    expect(html).toContain('EventSource');
  });

  it('includes search functionality', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="search-input"');
    expect(html).toContain('id="search-btn"');
    expect(html).toContain('/api/search');
  });

  it('includes history functionality with verify', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="history-btn"');
    expect(html).toContain('id="history-verify-btn"');
    expect(html).toContain('id="history-type"');
    expect(html).toContain('/api/history');
  });

  it('includes doctor functionality', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="doctor-btn"');
    expect(html).toContain('/api/doctor');
  });

  it('includes vault file browser', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="vault-list"');
    expect(html).toContain('id="vault-content"');
    expect(html).toContain('/api/vault/files');
    expect(html).toContain('/api/vault/file');
  });

  it('accepts empty baseUrl (default)', () => {
    const html = getDashboardHtml();
    expect(html).toContain("const BASE = \"\"");
  });

  it('accepts custom baseUrl', () => {
    const html = getDashboardHtml('http://localhost:3000');
    expect(html).toContain("const BASE = \"http://localhost:3000\"");
  });

  it('embeds baseUrl via JSON.stringify', () => {
    const html = getDashboardHtml('http://example.com/path?a=1&b=2');
    // JSON.stringify preserves the URL as-is (& is valid in JS strings)
    expect(html).toContain('const BASE = "http://example.com/path?a=1&b=2"');
  });

  it('includes API endpoint references for all panels', () => {
    const html = getDashboardHtml();
    const endpoints = [
      '/api/stats', '/api/events', '/api/search',
      '/api/history', '/api/vault/files', '/api/vault/file', '/api/doctor',
    ];
    for (const ep of endpoints) {
      expect(html).toContain(ep);
    }
  });

  it('includes CSS styles', () => {
    const html = getDashboardHtml();
    expect(html).toContain('<style>');
    expect(html).toContain('--bg:');
    expect(html).toContain('--accent:');
  });

  it('includes JavaScript', () => {
    const html = getDashboardHtml();
    expect(html).toContain('<script>');
    expect(html).toContain('function connectSSE()');
    expect(html).toContain('async function loadStats()');
    expect(html).toContain('async function doSearch()');
  });

  it('includes auth token support from query params', () => {
    const html = getDashboardHtml();
    expect(html).toContain("new URLSearchParams(window.location.search).get('token')");
    expect(html).toContain('Authorization');
    expect(html).toContain('Bearer');
  });

  it('includes event type listener registrations', () => {
    const html = getDashboardHtml();
    expect(html).toContain('message_received');
    expect(html).toContain('llm_call');
    expect(html).toContain('tool_call');
    expect(html).toContain('memory_write');
    expect(html).toContain('trust_change');
  });

  it('overview panel is active by default', () => {
    const html = getDashboardHtml();
    // The overview nav button has class="active"
    expect(html).toMatch(/button class="active" data-panel="overview"/);
    // The overview panel has class="panel active"
    expect(html).toMatch(/class="panel active" id="panel-overview"/);
  });

  it('has responsive CSS media query', () => {
    const html = getDashboardHtml();
    expect(html).toContain('@media (max-width: 768px)');
  });

  it('includes XSS protection via esc() function', () => {
    const html = getDashboardHtml();
    expect(html).toContain('function esc(s)');
    expect(html).toContain('textContent');
  });

  it('limits event stream to maxEvents', () => {
    const html = getDashboardHtml();
    expect(html).toContain('const maxEvents = 200');
    expect(html).toContain('while (stream.children.length > maxEvents)');
  });
});

// ── HTTP Integration: Dashboard served at / and /dashboard ──

function createMockApp(): any {
  return {
    eventBus: new EventBus(),
    config: {
      trust: { ownerIds: ['owner-1'] },
      memory: { vaultPath: '/tmp/test-vault', gitEnabled: false },
      dbPath: '/tmp/test.db',
    },
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      modules: [{ module: 'test', healthy: true, details: 'ok' }],
    }),
    getStats: vi.fn().mockReturnValue({}),
    searchRag: vi.fn().mockResolvedValue([]),
    getAuditHistory: vi.fn().mockReturnValue([]),
    verifyAuditChain: vi.fn().mockReturnValue({ valid: true, count: 0 }),
    listVaultFiles: vi.fn().mockReturnValue([]),
    readVaultFile: vi.fn().mockReturnValue(null),
    runDoctor: vi.fn().mockResolvedValue([]),
    approveWorkOrder: vi.fn(),
    denyWorkOrder: vi.fn(),
  };
}

describe('Dashboard HTTP serving', () => {
  let server: VedHttpServer;
  let port: number;

  beforeAll(async () => {
    const app = createMockApp();
    server = new VedHttpServer(app, { port: 0 });
    port = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  function get(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      }).on('error', reject);
    });
  }

  it('serves dashboard at /', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('Ved — Dashboard');
  });

  it('serves dashboard at /dashboard', async () => {
    const res = await get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Ved — Dashboard');
  });

  it('dashboard does not cache', async () => {
    const res = await get('/');
    expect(res.headers['cache-control']).toContain('no-cache');
  });

  it('API endpoints still work alongside dashboard', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('status');
  });

  it('dashboard HTML contains all expected API paths', async () => {
    const res = await get('/');
    expect(res.body).toContain('/api/stats');
    expect(res.body).toContain('/api/events');
    expect(res.body).toContain('/api/search');
    expect(res.body).toContain('/api/history');
    expect(res.body).toContain('/api/doctor');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await get('/unknown');
    expect(res.status).toBe(404);
  });
});
