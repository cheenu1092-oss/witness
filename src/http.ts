/**
 * Ved HTTP API Server — lightweight REST API on top of VedApp.
 *
 * Built with node:http (zero external deps). Provides:
 *   GET  /api/events           — SSE event stream (real-time audit events)
 *   GET  /api/health           — Health check
 *   GET  /api/stats            — System stats
 *   GET  /api/search?q=&n=     — RAG search
 *   GET  /api/history          — Audit history (with filters)
 *   GET  /api/vault/files      — List vault files
 *   GET  /api/vault/file?path= — Read a vault file
 *   GET  /api/doctor           — Run diagnostics
 *   POST /api/approve/:id      — Approve a work order
 *   POST /api/deny/:id         — Deny a work order
 *
 * Auth: optional Bearer token (set via VED_API_TOKEN env or config).
 * CORS: permissive by default (configurable).
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createLogger } from './core/log.js';
import type { VedApp } from './app.js';
import type { AuditEventType } from './types/index.js';
import type { Subscription } from './event-bus.js';
import { getDashboardHtml } from './dashboard.js';

const log = createLogger('http');

// ── Types ──

export interface HttpServerConfig {
  /** Port to listen on (default: 3141) */
  port: number;
  /** Host to bind to (default: '127.0.0.1') */
  host: string;
  /** Bearer token for auth (empty = no auth) */
  apiToken: string;
  /** CORS origin (default: '*') */
  corsOrigin: string;
}

export const DEFAULT_HTTP_CONFIG: HttpServerConfig = {
  port: 3141,
  host: '127.0.0.1',
  apiToken: '',
  corsOrigin: '*',
};

interface RouteMatch {
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;
  params: Record<string, string>;
}

// ── Server ──

export class VedHttpServer {
  private server: Server | null = null;
  private readonly app: VedApp;
  private readonly config: HttpServerConfig;
  /** Active SSE connections for cleanup on stop. */
  private readonly sseSubscriptions: Map<string, { sub: Subscription; res: ServerResponse }> = new Map();

  constructor(app: VedApp, config?: Partial<HttpServerConfig>) {
    this.app = app;
    this.config = { ...DEFAULT_HTTP_CONFIG, ...config };
  }

  /**
   * Start listening. Returns the actual port (useful if port 0 was requested).
   */
  async start(): Promise<number> {
    if (this.server) throw new Error('HTTP server already running');

    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          log.error('Unhandled request error', { error: err instanceof Error ? err.message : String(err) });
          if (!res.writableEnded) {
            this.json(res, 500, { error: 'Internal server error' });
          }
        });
      });

      server.on('error', reject);

      server.listen(this.config.port, this.config.host, () => {
        this.server = server;
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.config.port;
        log.info('HTTP API server started', { host: this.config.host, port });
        resolve(port);
      });
    });
  }

  /**
   * Stop the server gracefully.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    // Close all SSE connections
    for (const [id, { sub, res }] of this.sseSubscriptions) {
      sub.unsubscribe();
      if (!res.writableEnded) res.end();
      this.sseSubscriptions.delete(id);
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        log.info('HTTP API server stopped');
        resolve();
      });
    });
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  // ── Request Routing ──

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', this.config.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    if (this.config.apiToken) {
      const authHeader = req.headers.authorization ?? '';
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';

      if (token !== this.config.apiToken) {
        this.json(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    // Route matching
    const route = this.matchRoute(req.method ?? 'GET', req.url ?? '/');
    if (!route) {
      this.json(res, 404, { error: 'Not found' });
      return;
    }

    await route.handler(req, res, route.params);
  }

  private matchRoute(method: string, rawUrl: string): RouteMatch | null {
    // Parse URL (strip query string for path matching)
    const [path] = rawUrl.split('?');
    const cleanPath = path.replace(/\/+$/, '') || '/'; // strip trailing slashes

    // GET routes
    if (method === 'GET') {
      if (cleanPath === '/' || cleanPath === '/dashboard') return { handler: this.getDashboard, params: {} };
      if (cleanPath === '/api/health') return { handler: this.getHealth, params: {} };
      if (cleanPath === '/api/stats') return { handler: this.getStats, params: {} };
      if (cleanPath === '/api/search') return { handler: this.getSearch, params: {} };
      if (cleanPath === '/api/history') return { handler: this.getHistory, params: {} };
      if (cleanPath === '/api/vault/files') return { handler: this.getVaultFiles, params: {} };
      if (cleanPath === '/api/vault/file') return { handler: this.getVaultFile, params: {} };
      if (cleanPath === '/api/doctor') return { handler: this.getDoctor, params: {} };
      if (cleanPath === '/api/events') return { handler: this.getEvents, params: {} };
      if (cleanPath === '/api/webhooks') return { handler: this.getWebhooks, params: {} };
      if (cleanPath === '/api/webhooks/stats') return { handler: this.getWebhookStats, params: {} };
      // GET /api/webhooks/:id/deliveries
      const whDelMatch = cleanPath.match(/^\/api\/webhooks\/(.+)\/deliveries$/);
      if (whDelMatch) {
        return { handler: this.getWebhookDeliveries, params: { id: decodeURIComponent(whDelMatch[1]) } };
      }
    }

    // POST routes (with path params)
    if (method === 'POST') {
      if (cleanPath === '/api/webhooks') return { handler: this.postWebhook, params: {} };
      const approveMatch = cleanPath.match(/^\/api\/approve\/(.+)$/);
      if (approveMatch) {
        return { handler: this.postApprove, params: { id: decodeURIComponent(approveMatch[1]) } };
      }
      const denyMatch = cleanPath.match(/^\/api\/deny\/(.+)$/);
      if (denyMatch) {
        return { handler: this.postDeny, params: { id: decodeURIComponent(denyMatch[1]) } };
      }
    }

    // DELETE routes
    if (method === 'DELETE') {
      const whDeleteMatch = cleanPath.match(/^\/api\/webhooks\/(.+)$/);
      if (whDeleteMatch) {
        return { handler: this.deleteWebhook, params: { id: decodeURIComponent(whDeleteMatch[1]) } };
      }
    }

    return null;
  }

  // ── Handlers ──

  private getDashboard = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const html = getDashboardHtml('');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(html);
  };

  private getHealth = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const health = await this.app.healthCheck();
      this.json(res, health.healthy ? 200 : 503, {
        status: health.healthy ? 'healthy' : 'unhealthy',
        modules: health.modules.map(m => ({
          module: m.module,
          healthy: m.healthy,
          details: m.details,
        })),
      });
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private getStats = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const stats = this.app.getStats();
      this.json(res, 200, {
        ...stats,
        sse: {
          activeConnections: this.sseSubscriptions.size,
          busSubscribers: this.app.eventBus.subscriberCount,
        },
      });
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private getSearch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const params = this.parseQuery(req.url ?? '');
    const query = params.get('q') ?? params.get('query') ?? '';
    const topK = parseInt(params.get('n') ?? params.get('limit') ?? '5', 10);
    const ftsOnly = params.get('fts_only') === 'true' || params.get('fts_only') === '1';

    if (!query) {
      this.json(res, 400, { error: 'Missing required query parameter: q' });
      return;
    }

    if (isNaN(topK) || topK <= 0 || topK > 100) {
      this.json(res, 400, { error: 'Parameter n must be between 1 and 100' });
      return;
    }

    try {
      const context = await this.app.search(query, {
        vectorTopK: topK,
        ftsTopK: topK,
        sources: ftsOnly ? ['fts'] : undefined,
      });

      this.json(res, 200, {
        query,
        resultCount: context.results.length,
        tokenCount: context.tokenCount,
        metrics: context.metrics,
        results: context.results.map(r => ({
          filePath: r.filePath,
          heading: r.heading,
          content: r.content,
          rrfScore: r.rrfScore,
          sources: r.sources,
        })),
      });
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private getHistory = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const params = this.parseQuery(req.url ?? '');
    const type = params.get('type') ?? undefined;
    const limit = parseInt(params.get('limit') ?? params.get('n') ?? '20', 10);
    const fromStr = params.get('from');
    const toStr = params.get('to');
    const verify = params.get('verify') === 'true' || params.get('verify') === '1';

    if (isNaN(limit) || limit <= 0 || limit > 1000) {
      this.json(res, 400, { error: 'Parameter limit must be between 1 and 1000' });
      return;
    }

    // Verify chain integrity
    if (verify) {
      try {
        const result = this.app.verifyAuditChain();
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 500, { error: this.errMsg(err) });
      }
      return;
    }

    const from = fromStr ? new Date(fromStr).getTime() : undefined;
    const to = toStr ? (new Date(toStr).getTime() + 86400000 - 1) : undefined;

    if (fromStr && (from === undefined || isNaN(from))) {
      this.json(res, 400, { error: `Invalid from date: ${fromStr}` });
      return;
    }
    if (toStr && (to === undefined || isNaN(to))) {
      this.json(res, 400, { error: `Invalid to date: ${toStr}` });
      return;
    }

    try {
      const entries = this.app.getHistory({ type, from, to, limit });
      this.json(res, 200, { count: entries.length, entries });
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private getVaultFiles = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const params = this.parseQuery(req.url ?? '');
    const folder = params.get('folder') ?? undefined;

    try {
      const files = this.app['memory'].vault.listFiles(folder);
      this.json(res, 200, { count: files.length, files });
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private getVaultFile = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const params = this.parseQuery(req.url ?? '');
    const filePath = params.get('path') ?? '';

    if (!filePath) {
      this.json(res, 400, { error: 'Missing required query parameter: path' });
      return;
    }

    try {
      // Path safety is enforced by VaultManager.assertPathSafe
      const file = this.app['memory'].vault.readFile(filePath);
      this.json(res, 200, {
        path: file.path,
        frontmatter: file.frontmatter,
        body: file.body,
        links: file.links,
      });
    } catch (err) {
      const msg = this.errMsg(err);
      if (msg.includes('Path traversal') || msg.includes('outside vault')) {
        this.json(res, 403, { error: 'Path traversal denied' });
      } else if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('does not exist')) {
        this.json(res, 404, { error: `File not found: ${filePath}` });
      } else {
        this.json(res, 500, { error: msg });
      }
    }
  };

  private getDoctor = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const result = await this.app.doctor();
      this.json(res, result.failed > 0 ? 503 : 200, result);
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  // ── SSE Event Stream ──

  private getEvents = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Parse optional filter from query: ?types=message_received,llm_call
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const typesParam = url.searchParams.get('types');
    const filter: AuditEventType[] | undefined = typesParam
      ? typesParam.split(',').map(t => t.trim()).filter(Boolean) as AuditEventType[]
      : undefined;

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': this.config.corsOrigin,
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Send initial comment (keeps connection alive through proxies)
    res.write(':ok\n\n');

    // Subscribe to event bus
    const sub = this.app.eventBus.subscribe((event) => {
      if (res.writableEnded) return;
      const data = JSON.stringify(event);
      res.write(`event: ${event.type}\ndata: ${data}\nid: ${event.id}\n\n`);
    }, filter);

    // Track for cleanup
    this.sseSubscriptions.set(sub.id, { sub, res });

    // Set up keepalive (every 30s)
    const keepalive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepalive);
        return;
      }
      res.write(':keepalive\n\n');
    }, 30_000);

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(keepalive);
      sub.unsubscribe();
      this.sseSubscriptions.delete(sub.id);
      log.debug('SSE client disconnected', { subId: sub.id });
    });

    log.info('SSE client connected', { subId: sub.id, filter: filter ?? 'all' });
  };

  // ── Webhook Endpoints ──

  private getWebhooks = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const webhooks = this.app.webhookList();
      this.json(res, 200, { count: webhooks.length, webhooks });
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private getWebhookStats = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const stats = this.app.webhookStats();
      this.json(res, 200, stats);
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private getWebhookDeliveries = async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> => {
    const webhookId = params.id;
    const query = this.parseQuery(req.url ?? '');
    const limit = parseInt(query.get('limit') ?? '20', 10);

    try {
      const deliveries = this.app.webhookDeliveries(webhookId, limit);
      this.json(res, 200, { count: deliveries.length, deliveries });
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private postWebhook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = await this.readBody(req);
      if (!body || !body.name || !body.url) {
        this.json(res, 400, { error: 'Missing required fields: name, url' });
        return;
      }

      const webhook = this.app.webhookAdd({
        name: body.name as string,
        url: body.url as string,
        secret: body.secret as string | undefined,
        eventTypes: body.eventTypes as string[] | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });

      this.json(res, 201, webhook);
    } catch (err) {
      const msg = this.errMsg(err);
      if (msg.includes('UNIQUE constraint')) {
        this.json(res, 409, { error: `Webhook name already exists` });
      } else {
        this.json(res, 500, { error: msg });
      }
    }
  };

  private deleteWebhook = async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> => {
    const idOrName = params.id;

    try {
      const removed = this.app.webhookRemove(idOrName);
      if (!removed) {
        this.json(res, 404, { error: `Webhook not found: ${idOrName}` });
        return;
      }
      this.json(res, 200, { removed: true, id: idOrName });
    } catch (err) {
      this.json(res, 500, { error: this.errMsg(err) });
    }
  };

  private postApprove = async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> => {
    const workOrderId = params.id;

    try {
      // Read body (reason is for informational purposes only; WorkOrderManager.approve doesn't use it)
      await this.readBody(req);

      // Use the event loop's work order manager to approve
      const workOrders = this.app.eventLoop['workOrders'];
      if (!workOrders) {
        this.json(res, 500, { error: 'Work order manager not available' });
        return;
      }

      const ownerIds = this.app.config.trust?.ownerIds ?? [];
      if (ownerIds.length === 0) {
        this.json(res, 500, { error: 'No owner IDs configured' });
        return;
      }

      // Approve as the first configured owner
      const result = workOrders.approve(workOrderId, ownerIds[0]);
      if (!result) {
        this.json(res, 404, { error: `Work order not found or already resolved: ${workOrderId}` });
        return;
      }

      this.json(res, 200, { approved: true, workOrderId, approvedBy: ownerIds[0] });
    } catch (err) {
      const msg = this.errMsg(err);
      if (msg.includes('expired') || msg.includes('already resolved')) {
        this.json(res, 409, { error: msg });
      } else {
        this.json(res, 500, { error: msg });
      }
    }
  };

  private postDeny = async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> => {
    const workOrderId = params.id;

    try {
      const body = await this.readBody(req);
      const reason = (body?.reason as string) ?? 'Denied via API';

      const workOrders = this.app.eventLoop['workOrders'];
      if (!workOrders) {
        this.json(res, 500, { error: 'Work order manager not available' });
        return;
      }

      const ownerIds = this.app.config.trust?.ownerIds ?? [];
      if (ownerIds.length === 0) {
        this.json(res, 500, { error: 'No owner IDs configured' });
        return;
      }

      const result = workOrders.deny(workOrderId, ownerIds[0]);
      if (!result) {
        this.json(res, 404, { error: `Work order not found or already resolved: ${workOrderId}` });
        return;
      }

      this.json(res, 200, { denied: true, workOrderId, deniedBy: ownerIds[0], reason });
    } catch (err) {
      const msg = this.errMsg(err);
      if (msg.includes('expired') || msg.includes('already resolved')) {
        this.json(res, 409, { error: msg });
      } else {
        this.json(res, 500, { error: msg });
      }
    }
  };

  // ── Utilities ──

  private json(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Powered-By': 'Ved',
    });
    res.end(body);
  }

  private parseQuery(url: string): Map<string, string> {
    const qIndex = url.indexOf('?');
    if (qIndex === -1) return new Map();

    const params = new Map<string, string>();
    const qs = url.slice(qIndex + 1);

    for (const part of qs.split('&')) {
      const eqIndex = part.indexOf('=');
      if (eqIndex === -1) {
        params.set(decodeURIComponent(part), '');
      } else {
        const key = decodeURIComponent(part.slice(0, eqIndex).replace(/\+/g, ' '));
        const value = decodeURIComponent(part.slice(eqIndex + 1).replace(/\+/g, ' '));
        params.set(key, value);
      }
    }

    return params;
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_BODY = 1024 * 1024; // 1 MB

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (totalBytes === 0) {
          resolve(null);
          return;
        }
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });

      req.on('error', () => resolve(null));
    });
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
