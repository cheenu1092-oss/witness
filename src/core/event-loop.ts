/**
 * EventLoop — The central orchestrator for Ved.
 *
 * Implements the 7-step pipeline:
 *   1. RECEIVE  — dequeue message, persist to inbox, get/create session
 *   2. ENRICH   — load working memory, RAG context, assemble prompt
 *   3. DECIDE   — call LLM with assembled context
 *   4. ACT      — trust gate → execute tool calls → agentic sub-loop
 *   5. RECORD   — audit all operations to T4
 *   6. RESPOND  — send response to originating channel
 *   7. MAINTAIN — compress memory, re-index, git commit, close stale sessions
 *
 * This file implements the loop skeleton and steps 1, 5, 7.
 * Steps 2-4 and 6 depend on modules not yet built (LLM, MCP, Memory, Channel)
 * and are stubbed with TODO markers.
 */

import Database from 'better-sqlite3';
import { createLogger } from './log.js';
import { MessageQueue, type MessagePriority } from './queue.js';
import { SessionManager, type Session } from './session.js';
import { AuditLog } from '../audit/store.js';
import { AnchorManager } from '../audit/anchor.js';
import { TrustEngine } from '../trust/engine.js';
import { WorkOrderManager } from '../trust/work-orders.js';
import type {
  VedConfig,
  VedMessage,
  ChannelId,
  ModuleHealth,
} from '../types/index.js';

const log = createLogger('core');

// === Inbox persistence (crash-safe receipt) ===

interface InboxRow {
  id: string;
  channel: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  content: string;
  attachments: string;
  reply_to: string | null;
  metadata: string;
  received_at: number;
  processed: number;
  error: string | null;
  session_id: string | null;
}

// === EventLoop options ===

export interface EventLoopOptions {
  config: VedConfig;
  db: Database.Database;
}

/**
 * EventLoop — Ved's core runtime.
 *
 * Owns the message queue, session manager, audit log, trust engine,
 * and orchestrates the 7-step pipeline for every incoming message.
 */
export class EventLoop {
  readonly name = 'core';

  private config: VedConfig;
  private db: Database.Database;
  private running = false;
  private shuttingDown = false;

  // Owned components
  readonly queue: MessageQueue;
  readonly sessions: SessionManager;
  readonly audit: AuditLog;
  readonly anchors: AnchorManager;
  readonly trust: TrustEngine;
  readonly workOrders: WorkOrderManager;

  // Prepared statements
  private stmtInboxInsert: Database.Statement;
  private stmtInboxProcessed: Database.Statement;
  private stmtInboxError: Database.Statement;
  private stmtInboxUnprocessed: Database.Statement;
  // @ts-expect-error -- assigned now, used when respond step is implemented
  private stmtOutboxInsert: Database.Statement;

  // Loop control
  private loopResolve?: () => void;
  private pollIntervalMs: number = 100; // how often to check the queue

  constructor(opts: EventLoopOptions) {
    this.config = opts.config;
    this.db = opts.db;

    // Initialize components
    this.queue = new MessageQueue();

    this.audit = new AuditLog(this.db);
    this.anchors = new AnchorManager(this.db);

    this.trust = new TrustEngine(this.db, this.config.trust);
    this.workOrders = new WorkOrderManager(this.db, this.config.trust.approvalTimeoutMs);

    this.sessions = new SessionManager(this.db, {
      workingMemoryMaxTokens: this.config.memory.workingMemoryMaxTokens,
      onAudit: (input) => this.audit.append(input),
    });

    // Prepare inbox statements
    this.stmtInboxInsert = this.db.prepare(`
      INSERT INTO inbox (id, channel, channel_id, author_id, author_name, content, attachments, reply_to, metadata, received_at, processed)
      VALUES (@id, @channel, @channelId, @authorId, @authorName, @content, @attachments, @replyTo, @metadata, @receivedAt, 0)
    `);

    this.stmtInboxProcessed = this.db.prepare(`
      UPDATE inbox SET processed = 1, session_id = @sessionId WHERE id = @id
    `);

    this.stmtInboxError = this.db.prepare(`
      UPDATE inbox SET processed = -1, error = @error WHERE id = @id
    `);

    this.stmtInboxUnprocessed = this.db.prepare(`
      SELECT * FROM inbox WHERE processed = 0 ORDER BY received_at ASC
    `);

    this.stmtOutboxInsert = this.db.prepare(`
      INSERT INTO outbox (id, session_id, channel, channel_id, content, attachments, reply_to, metadata, status, created_at)
      VALUES (@id, @sessionId, @channel, @channelId, @content, @attachments, @replyTo, @metadata, 'pending', @createdAt)
    `);
  }

  /** Whether the event loop is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Start the main loop. Blocks until requestShutdown() is called.
   *
   * On start:
   * 1. Log startup audit event
   * 2. Recover unprocessed inbox messages
   * 3. Enter loop: dequeue → process → repeat
   */
  async run(): Promise<void> {
    if (this.running) throw new Error('EventLoop is already running');

    this.running = true;
    this.shuttingDown = false;

    this.audit.append({
      eventType: 'startup',
      actor: 'ved',
      detail: { version: this.config.version, model: this.config.llm.model },
    });

    log.info('Ved starting', { version: this.config.version });

    // Recover unprocessed messages from last crash
    this.recoverInbox();

    // Main loop
    await new Promise<void>((resolve) => {
      this.loopResolve = resolve;
      this.tick();
    });

    // Shutdown sequence
    await this.shutdown();
  }

  /**
   * Request graceful shutdown. Completes current message, then stops.
   */
  requestShutdown(): void {
    log.info('Shutdown requested');
    this.shuttingDown = true;
    // If the loop is idle (waiting on timer), resolve immediately
    if (this.loopResolve && this.queue.isEmpty) {
      this.running = false;
      this.loopResolve();
    }
  }

  /**
   * Graceful shutdown: close stale sessions, anchor audit chain, log shutdown.
   */
  private async shutdown(): Promise<void> {
    log.info('Shutting down...');

    // Close all active sessions
    const stale = this.sessions.closeStale(0);
    if (stale.length > 0) {
      log.info('Closed sessions on shutdown', { count: stale.length });
    }

    // Expire pending work orders
    const expired = this.workOrders.sweepExpired();
    if (expired > 0) {
      log.info('Expired work orders on shutdown', { count: expired });
    }

    // Create final anchor
    const head = this.audit.getChainHead();
    if (head.count > 0) {
      this.anchors.createAnchor(head, this.config.audit.hmacSecret);
    }

    this.audit.append({
      eventType: 'shutdown',
      actor: 'ved',
      detail: { reason: 'graceful' },
    });

    this.running = false;
    log.info('Ved stopped');
  }

  // =========================================================================
  // Loop tick
  // =========================================================================

  private tick(): void {
    if (this.shuttingDown && this.queue.isEmpty) {
      this.running = false;
      this.loopResolve?.();
      return;
    }

    const msg = this.queue.dequeue();
    if (msg) {
      this.processMessage(msg);
    }

    // Schedule next tick
    setTimeout(() => this.tick(), msg ? 0 : this.pollIntervalMs);
  }

  // =========================================================================
  // Step 1: RECEIVE
  // =========================================================================

  /**
   * Persist a message to the inbox (crash-safe) and enqueue it.
   * Channel adapters call this method.
   */
  receive(msg: VedMessage, priority: MessagePriority = 'normal'): void {
    // Persist to inbox first (crash-safe)
    this.stmtInboxInsert.run({
      id: msg.id,
      channel: msg.channel,
      channelId: '', // filled by channel adapter if needed
      authorId: msg.author,
      authorName: '',
      content: msg.content,
      attachments: JSON.stringify(msg.attachments ?? []),
      replyTo: msg.replyTo ?? null,
      metadata: '{}',
      receivedAt: msg.timestamp,
    });

    // Enqueue for processing
    this.queue.enqueue(msg, priority);

    log.debug('Message received', { messageId: msg.id, channel: msg.channel, priority });
  }

  /**
   * Recover unprocessed inbox messages from a previous crash.
   * Re-enqueues them for processing.
   */
  private recoverInbox(): void {
    const rows = this.stmtInboxUnprocessed.all() as InboxRow[];
    if (rows.length === 0) return;

    log.warn('Recovering unprocessed inbox messages', { count: rows.length });

    for (const row of rows) {
      const msg: VedMessage = {
        id: row.id,
        channel: row.channel as ChannelId,
        author: row.author_id,
        content: row.content,
        attachments: JSON.parse(row.attachments),
        replyTo: row.reply_to ?? undefined,
        timestamp: row.received_at,
      };
      this.queue.enqueue(msg, 'normal');
    }
  }

  // =========================================================================
  // Message processing (Steps 1-7)
  // =========================================================================

  /**
   * Process a single message through the 7-step pipeline.
   */
  private processMessage(msg: VedMessage): void {
    log.info('Processing message', { messageId: msg.id, channel: msg.channel, author: msg.author });

    try {
      // Step 1: RECEIVE — get/create session
      const trustTier = this.trust.resolveTier(msg.channel, msg.author);
      const session = this.sessions.getOrCreate(
        msg.channel,
        '', // channelId — filled by adapter
        msg.author,
        trustTier,
      );

      // Mark inbox as processed
      this.stmtInboxProcessed.run({ id: msg.id, sessionId: session.id });

      // Add user message to working memory
      session.workingMemory.addMessage({
        role: 'user',
        content: msg.content,
        timestamp: msg.timestamp,
      });

      // Step 2: ENRICH — TODO: RAG query, load episodic context
      // const ragContext = await this.rag.query(msg.content);
      // const prompt = this.assemblePrompt(session, ragContext);

      // Step 3: DECIDE — TODO: Call LLM
      // const decision = await this.llm.chat({ systemPrompt, messages, tools });

      // Step 4: ACT — TODO: Trust gate → execute tool calls → agentic loop
      // for (const toolCall of decision.toolCalls) {
      //   const risk = this.trust.assessRisk(toolCall.tool, toolCall.params);
      //   const trustDecision = this.trust.getTrustDecision(trustTier, risk.level);
      //   if (trustDecision === 'auto') { execute } else if (trustDecision === 'approve') { queue work order }
      // }

      // Step 5: RECORD
      this.audit.append({
        eventType: 'message_received',
        actor: msg.author,
        sessionId: session.id,
        detail: { messageId: msg.id, channel: msg.channel, contentLength: msg.content.length },
      });

      // Step 6: RESPOND — TODO: Send response to channel
      // For now, just add a placeholder assistant message
      // session.workingMemory.addMessage({ role: 'assistant', content: decision.response, timestamp: Date.now() });

      // Step 7: MAINTAIN
      this.maintain(session);

      // Persist session state
      this.sessions.persist(session);

      log.info('Message processed', { messageId: msg.id, sessionId: session.id });

    } catch (err) {
      log.error('Message processing failed', {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });

      this.stmtInboxError.run({
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });

      this.audit.append({
        eventType: 'error',
        actor: 'ved',
        detail: {
          messageId: msg.id,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // =========================================================================
  // Step 7: MAINTAIN
  // =========================================================================

  /**
   * Post-message maintenance tasks.
   * - Check if working memory needs compression
   * - Expire stale work orders
   * - Periodic anchor creation
   */
  private maintain(_session: Session): void {
    // Expire stale work orders
    this.workOrders.sweepExpired();

    // Create anchor if we've passed the interval
    const head = this.audit.getChainHead();
    if (head.count > 0 && head.count % this.config.audit.anchorInterval === 0) {
      this.anchors.createAnchor(head, this.config.audit.hmacSecret);
      log.debug('Anchor created', { chainLength: head.count });
    }

    // TODO: Check compression threshold
    // if (session.workingMemory.isOverThreshold(this.config.memory.compressionThreshold)) {
    //   const compressed = await this.llm.compress(session.workingMemory.toPromptSection(), 'Summarize this conversation');
    //   // Write to T2 (episodic daily note)
    //   // Clear old messages from T1, keep compressed summary as fact
    // }

    // TODO: Close stale sessions periodically (not on every message)
    // TODO: Trigger RAG re-index if vault files changed
    // TODO: Git auto-commit if interval elapsed
  }

  // =========================================================================
  // Health check
  // =========================================================================

  /**
   * Check core module health.
   */
  healthCheck(): ModuleHealth {
    const chainVerification = this.audit.verifyChain(100);
    const anchorVerification = this.anchors.verifyLatestAnchor(
      this.audit.getChainHead().hash,
      this.audit.getChainHead().count,
      this.config.audit.hmacSecret,
    );

    const healthy = chainVerification.intact && anchorVerification.valid;

    return {
      module: this.name,
      healthy,
      details: healthy
        ? `Chain: ${chainVerification.total} entries, anchor valid`
        : `Chain intact: ${chainVerification.intact}, Anchor valid: ${anchorVerification.valid} (${anchorVerification.reason ?? ''})`,
      checkedAt: Date.now(),
    };
  }
}
