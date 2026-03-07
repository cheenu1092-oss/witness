/**
 * WebhookManager — Event-driven HTTP webhook delivery for Ved.
 *
 * Architecture:
 *   EventBus → WebhookManager.subscriber → per-webhook delivery
 *   → retry with exponential backoff (3 attempts, 10s/60s/300s)
 *   → HMAC-SHA256 signing (optional, per-webhook)
 *   → delivery log in SQLite (webhook_deliveries table)
 *
 * Design constraints:
 * - Zero external deps (node:http / node:https only)
 * - Async non-blocking delivery (never blocks the event bus)
 * - Bounded retries (max 3 → status='dead')
 * - Response body capped at 4KB
 * - Payload size capped at 256KB
 */

import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type Database from 'better-sqlite3';
import type { AuditEventType } from './types/index.js';
import type { VedEvent, EventBus, Subscription } from './event-bus.js';
import { createLogger } from './core/log.js';
import { vedUlid } from './types/ulid.js';

const log = createLogger('webhook');

// ── Constants ──

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000]; // 10s, 1min, 5min
const MAX_RESPONSE_BODY = 4096; // 4KB
const MAX_PAYLOAD_SIZE = 256 * 1024; // 256KB
const DELIVERY_TIMEOUT_MS = 30_000; // 30s per request

// ── Types ──

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  eventTypes: string[]; // ['*'] for all, or specific types
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface WebhookInput {
  name: string;
  url: string;
  secret?: string;
  eventTypes?: string[]; // default: ['*']
  metadata?: Record<string, unknown>;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  attempt: number;
  status: 'pending' | 'success' | 'failed' | 'dead';
  statusCode: number | null;
  requestBody: string;
  responseBody: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  nextRetryAt: number | null;
}

export interface WebhookStats {
  totalWebhooks: number;
  enabledWebhooks: number;
  pendingDeliveries: number;
  failedDeliveries: number;
  deadDeliveries: number;
  successfulLast24h: number;
}

// ── WebhookManager ──

export class WebhookManager {
  private db: Database.Database;
  private eventBus: EventBus;
  private subscription: Subscription | null = null;
  private retryInterval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  // Prepared statements (lazily created)
  private stmts: {
    insertWebhook?: Database.Statement;
    updateWebhook?: Database.Statement;
    deleteWebhook?: Database.Statement;
    getWebhook?: Database.Statement;
    getWebhookByName?: Database.Statement;
    listWebhooks?: Database.Statement;
    listEnabled?: Database.Statement;
    toggleWebhook?: Database.Statement;
    insertDelivery?: Database.Statement;
    updateDelivery?: Database.Statement;
    getRetryable?: Database.Statement;
    getDeliveries?: Database.Statement;
    getDeliveriesByWebhook?: Database.Statement;
    countStats?: Record<string, Database.Statement>;
  } = {};

  constructor(db: Database.Database, eventBus: EventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  /**
   * Start listening to EventBus and delivering webhooks.
   * Also starts the retry timer (checks every 30s for retryable deliveries).
   */
  start(): void {
    if (this.subscription) return; // already started
    this.stopped = false;

    // Subscribe to all events on the bus
    this.subscription = this.eventBus.subscribe((event) => {
      // Fire-and-forget: deliver asynchronously, never block the bus
      this.deliverEvent(event).catch((err) => {
        log.warn('Webhook delivery dispatch error', {
          eventId: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // Start retry timer
    this.retryInterval = setInterval(() => {
      this.processRetries().catch((err) => {
        log.warn('Webhook retry processing error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 30_000);
    this.retryInterval.unref();

    log.info('WebhookManager started');
  }

  /**
   * Stop listening and cancel pending retries.
   */
  stop(): void {
    this.stopped = true;

    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }

    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }

    log.info('WebhookManager stopped');
  }

  // ── CRUD ──

  /**
   * Register a new webhook.
   */
  add(input: WebhookInput): Webhook {
    this.validateUrl(input.url);

    const id = vedUlid();
    const now = Date.now();
    const eventTypes = input.eventTypes ?? ['*'];
    const metadata = input.metadata ?? {};

    const stmt = this.stmts.insertWebhook ??= this.db.prepare(`
      INSERT INTO webhooks (id, name, url, secret, event_types, enabled, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.name,
      input.url,
      input.secret ?? null,
      eventTypes.join(','),
      now,
      now,
      JSON.stringify(metadata),
    );

    log.info('Webhook registered', { id, name: input.name, url: input.url });

    return {
      id, name: input.name, url: input.url,
      secret: input.secret ?? null,
      eventTypes, enabled: true,
      createdAt: now, updatedAt: now, metadata,
    };
  }

  /**
   * Remove a webhook by ID or name.
   */
  remove(idOrName: string): boolean {
    const webhook = this.get(idOrName);
    if (!webhook) return false;

    const stmt = this.stmts.deleteWebhook ??= this.db.prepare(
      'DELETE FROM webhooks WHERE id = ?'
    );
    stmt.run(webhook.id);

    log.info('Webhook removed', { id: webhook.id, name: webhook.name });
    return true;
  }

  /**
   * Get a webhook by ID or name.
   */
  get(idOrName: string): Webhook | null {
    const byId = this.stmts.getWebhook ??= this.db.prepare(
      'SELECT * FROM webhooks WHERE id = ?'
    );
    const byName = this.stmts.getWebhookByName ??= this.db.prepare(
      'SELECT * FROM webhooks WHERE name = ?'
    );

    const row = (byId.get(idOrName) ?? byName.get(idOrName)) as WebhookRow | undefined;
    return row ? this.rowToWebhook(row) : null;
  }

  /**
   * List all webhooks.
   */
  list(): Webhook[] {
    const stmt = this.stmts.listWebhooks ??= this.db.prepare(
      'SELECT * FROM webhooks ORDER BY created_at'
    );
    return (stmt.all() as WebhookRow[]).map(r => this.rowToWebhook(r));
  }

  /**
   * Enable or disable a webhook.
   */
  toggle(idOrName: string, enabled: boolean): Webhook | null {
    const webhook = this.get(idOrName);
    if (!webhook) return null;

    const stmt = this.stmts.toggleWebhook ??= this.db.prepare(
      'UPDATE webhooks SET enabled = ?, updated_at = ? WHERE id = ?'
    );
    stmt.run(enabled ? 1 : 0, Date.now(), webhook.id);

    log.info(`Webhook ${enabled ? 'enabled' : 'disabled'}`, { id: webhook.id, name: webhook.name });
    return { ...webhook, enabled, updatedAt: Date.now() };
  }

  /**
   * Update a webhook's URL, secret, or event types.
   */
  update(idOrName: string, changes: Partial<Pick<WebhookInput, 'url' | 'secret' | 'eventTypes' | 'metadata'>>): Webhook | null {
    const webhook = this.get(idOrName);
    if (!webhook) return null;

    if (changes.url) this.validateUrl(changes.url);

    const url = changes.url ?? webhook.url;
    const secret = changes.secret !== undefined ? changes.secret ?? null : webhook.secret;
    const eventTypes = changes.eventTypes ?? webhook.eventTypes;
    const metadata = changes.metadata ?? webhook.metadata;
    const now = Date.now();

    const stmt = this.stmts.updateWebhook ??= this.db.prepare(`
      UPDATE webhooks SET url = ?, secret = ?, event_types = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(url, secret, eventTypes.join(','), JSON.stringify(metadata), now, webhook.id);

    return { ...webhook, url, secret, eventTypes, metadata, updatedAt: now };
  }

  // ── Delivery ──

  /**
   * Deliver an event to all matching enabled webhooks.
   */
  async deliverEvent(event: VedEvent): Promise<void> {
    const enabledStmt = this.stmts.listEnabled ??= this.db.prepare(
      'SELECT * FROM webhooks WHERE enabled = 1'
    );
    const webhooks = (enabledStmt.all() as WebhookRow[]).map(r => this.rowToWebhook(r));

    for (const wh of webhooks) {
      // Check event type filter
      if (!this.matchesFilter(event.type, wh.eventTypes)) continue;

      // Build payload
      const payload = this.buildPayload(event, wh);
      if (!payload) continue; // skip if too large

      // Record delivery attempt
      const deliveryId = vedUlid();
      this.recordDelivery(deliveryId, wh.id, event.id, event.type, 1, payload);

      // Fire async delivery (don't await — fire and forget)
      this.executeDelivery(deliveryId, wh, payload, 1).catch((err) => {
        log.warn('Webhook delivery error', {
          deliveryId,
          webhookId: wh.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Process retryable deliveries.
   */
  async processRetries(): Promise<number> {
    if (this.stopped) return 0;

    const stmt = this.stmts.getRetryable ??= this.db.prepare(`
      SELECT d.*, w.url, w.secret, w.name as webhook_name, w.metadata as webhook_metadata
      FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'failed'
        AND d.next_retry_at IS NOT NULL
        AND d.next_retry_at <= ?
        AND w.enabled = 1
      ORDER BY d.next_retry_at
      LIMIT 50
    `);

    const rows = stmt.all(Date.now()) as RetryRow[];
    if (rows.length === 0) return 0;

    let processed = 0;
    for (const row of rows) {
      if (this.stopped) break;

      const wh: Webhook = {
        id: row.webhook_id,
        name: row.webhook_name,
        url: row.url,
        secret: row.secret,
        eventTypes: [], // not needed for retry
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        metadata: JSON.parse(row.webhook_metadata || '{}'),
      };

      await this.executeDelivery(row.id, wh, row.request_body, row.attempt + 1);
      processed++;
    }

    if (processed > 0) {
      log.info('Processed webhook retries', { count: processed });
    }
    return processed;
  }

  /**
   * Get delivery history for a webhook.
   */
  deliveries(webhookIdOrName?: string, limit = 20): WebhookDelivery[] {
    if (webhookIdOrName) {
      const webhook = this.get(webhookIdOrName);
      if (!webhook) return [];

      const stmt = this.stmts.getDeliveriesByWebhook ??= this.db.prepare(`
        SELECT * FROM webhook_deliveries WHERE webhook_id = ?
        ORDER BY started_at DESC LIMIT ?
      `);
      return (stmt.all(webhook.id, limit) as DeliveryRow[]).map(r => this.rowToDelivery(r));
    }

    const stmt = this.stmts.getDeliveries ??= this.db.prepare(`
      SELECT * FROM webhook_deliveries ORDER BY started_at DESC LIMIT ?
    `);
    return (stmt.all(limit) as DeliveryRow[]).map(r => this.rowToDelivery(r));
  }

  /**
   * Get webhook delivery stats.
   */
  stats(): WebhookStats {
    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM webhooks').get() as { cnt: number }).cnt;
    const enabled = (this.db.prepare('SELECT COUNT(*) as cnt FROM webhooks WHERE enabled = 1').get() as { cnt: number }).cnt;
    const pending = (this.db.prepare("SELECT COUNT(*) as cnt FROM webhook_deliveries WHERE status = 'pending'").get() as { cnt: number }).cnt;
    const failed = (this.db.prepare("SELECT COUNT(*) as cnt FROM webhook_deliveries WHERE status = 'failed'").get() as { cnt: number }).cnt;
    const dead = (this.db.prepare("SELECT COUNT(*) as cnt FROM webhook_deliveries WHERE status = 'dead'").get() as { cnt: number }).cnt;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const success24h = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM webhook_deliveries WHERE status = 'success' AND finished_at > ?"
    ).get(cutoff) as { cnt: number }).cnt;

    return {
      totalWebhooks: total,
      enabledWebhooks: enabled,
      pendingDeliveries: pending,
      failedDeliveries: failed,
      deadDeliveries: dead,
      successfulLast24h: success24h,
    };
  }

  // ── Internal ──

  private matchesFilter(eventType: AuditEventType, filter: string[]): boolean {
    if (filter.length === 0 || filter.includes('*')) return true;
    return filter.includes(eventType);
  }

  private buildPayload(event: VedEvent, webhook: Webhook): string | null {
    const payload = JSON.stringify({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      actor: event.actor,
      sessionId: event.sessionId,
      detail: event.detail,
      hash: event.hash,
      deliveredAt: Date.now(),
      webhookName: webhook.name,
    });

    if (Buffer.byteLength(payload) > MAX_PAYLOAD_SIZE) {
      log.warn('Webhook payload too large, skipping', {
        webhookId: webhook.id,
        eventId: event.id,
        size: Buffer.byteLength(payload),
      });
      return null;
    }

    return payload;
  }

  private signPayload(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  private recordDelivery(
    id: string,
    webhookId: string,
    eventId: string,
    eventType: string,
    attempt: number,
    requestBody: string,
  ): void {
    const stmt = this.stmts.insertDelivery ??= this.db.prepare(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, event_id, event_type, attempt, status, request_body, started_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    stmt.run(id, webhookId, eventId, eventType, attempt, requestBody, Date.now());
  }

  private async executeDelivery(
    deliveryId: string,
    webhook: Webhook,
    payload: string,
    attempt: number,
  ): Promise<void> {
    const startedAt = Date.now();

    try {
      const result = await this.httpPost(webhook.url, payload, webhook.secret, webhook.metadata);
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;

      if (result.statusCode >= 200 && result.statusCode < 300) {
        // Success
        this.updateDelivery(deliveryId, {
          status: 'success',
          statusCode: result.statusCode,
          responseBody: result.body,
          attempt,
          finishedAt,
          durationMs,
          nextRetryAt: null,
        });
      } else {
        // HTTP error — retry or mark dead
        this.handleFailure(deliveryId, attempt, result.statusCode, result.body, null, finishedAt, durationMs);
      }
    } catch (err) {
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.handleFailure(deliveryId, attempt, null, null, errorMsg, finishedAt, durationMs);
    }
  }

  private handleFailure(
    deliveryId: string,
    attempt: number,
    statusCode: number | null,
    responseBody: string | null,
    error: string | null,
    finishedAt: number,
    durationMs: number,
  ): void {
    const isRetryable = attempt < MAX_ATTEMPTS;
    const status = isRetryable ? 'failed' : 'dead';
    const nextRetryAt = isRetryable
      ? Date.now() + RETRY_DELAYS_MS[attempt - 1]
      : null;

    this.updateDelivery(deliveryId, {
      status,
      statusCode,
      responseBody,
      error: error ?? `HTTP ${statusCode}`,
      attempt,
      finishedAt,
      durationMs,
      nextRetryAt,
    });

    if (!isRetryable) {
      log.warn('Webhook delivery dead (max retries exhausted)', { deliveryId, attempt });
    }
  }

  private updateDelivery(id: string, data: {
    status: string;
    statusCode: number | null;
    responseBody: string | null;
    error?: string | null;
    attempt: number;
    finishedAt: number;
    durationMs: number;
    nextRetryAt: number | null;
  }): void {
    const stmt = this.stmts.updateDelivery ??= this.db.prepare(`
      UPDATE webhook_deliveries
      SET status = ?, status_code = ?, response_body = ?, error = ?,
          attempt = ?, finished_at = ?, duration_ms = ?, next_retry_at = ?
      WHERE id = ?
    `);
    stmt.run(
      data.status,
      data.statusCode,
      data.responseBody?.slice(0, MAX_RESPONSE_BODY) ?? null,
      data.error ?? null,
      data.attempt,
      data.finishedAt,
      data.durationMs,
      data.nextRetryAt,
      id,
    );
  }

  /**
   * HTTP POST with timeout. Uses node:http or node:https based on URL.
   */
  private httpPost(
    url: string,
    body: string,
    secret: string | null,
    metadata: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const doRequest = isHttps ? httpsRequest : httpRequest;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'User-Agent': 'Ved-Webhook/0.1.0',
        'X-Ved-Event-Delivery': 'true',
      };

      // HMAC signature
      if (secret) {
        headers['X-Ved-Signature-256'] = `sha256=${this.signPayload(body, secret)}`;
      }

      // Custom headers from metadata
      const customHeaders = metadata?.headers as Record<string, string> | undefined;
      if (customHeaders && typeof customHeaders === 'object') {
        for (const [key, val] of Object.entries(customHeaders)) {
          if (typeof val === 'string') {
            headers[key] = val;
          }
        }
      }

      const req = doRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers,
          timeout: DELIVERY_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;

          res.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes <= MAX_RESPONSE_BODY) {
              chunks.push(chunk);
            }
          });

          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Webhook delivery timeout'));
      });

      req.write(body);
      req.end();
    });
  }

  private validateUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported protocol: ${parsed.protocol}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Unsupported')) throw err;
      throw new Error(`Invalid webhook URL: ${url}`);
    }
  }

  private rowToWebhook(row: WebhookRow): Webhook {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      secret: row.secret,
      eventTypes: row.event_types === '*' ? ['*'] : row.event_types.split(',').filter(Boolean),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private rowToDelivery(row: DeliveryRow): WebhookDelivery {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      eventId: row.event_id,
      eventType: row.event_type,
      attempt: row.attempt,
      status: row.status as WebhookDelivery['status'],
      statusCode: row.status_code,
      requestBody: row.request_body,
      responseBody: row.response_body,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      nextRetryAt: row.next_retry_at,
    };
  }
}

// ── Row Types ──

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  event_types: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  metadata: string;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  status: string;
  status_code: number | null;
  request_body: string;
  response_body: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  next_retry_at: number | null;
}

interface RetryRow extends DeliveryRow {
  url: string;
  secret: string | null;
  webhook_name: string;
  webhook_metadata: string;
}
