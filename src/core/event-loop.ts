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
 */

import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { createLogger } from './log.js';
import { MessageQueue, type MessagePriority } from './queue.js';
import { SessionManager, type Session } from './session.js';
import { Compressor } from './compressor.js';
import { SessionIdleTimer } from './idle-timer.js';
import { parseApprovalCommand, executeApprovalCommand } from './approval-parser.js';
import { AuditLog } from '../audit/store.js';
import { AnchorManager } from '../audit/anchor.js';
import { TrustEngine } from '../trust/engine.js';
import { WorkOrderManager } from '../trust/work-orders.js';
import type { LLMClient } from '../llm/client.js';
import type { MCPClient } from '../mcp/client.js';
import type { MemoryManager } from '../memory/manager.js';
import type { RagPipeline } from '../rag/pipeline.js';
import type { ChannelManager } from '../channel/manager.js';
import type {
  VedConfig,
  VedMessage,
  VedResponse,
  ChannelId,
  ModuleHealth,
  ToolCall,
  ToolResult,
  WorkOrder,
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

  // External modules (set via setModules)
  private llm: LLMClient | null = null;
  private mcp: MCPClient | null = null;
  private memory: MemoryManager | null = null;
  private rag: RagPipeline | null = null;
  private channels: ChannelManager | null = null;

  // Compressor (created when modules are wired)
  private compressor: Compressor | null = null;

  // Idle timer (proactive session idle detection)
  private idleTimer: SessionIdleTimer | null = null;

  // Session idle tracking (legacy maintain() path — still used as fallback)
  private lastStaleCheck = 0;
  private staleCheckIntervalMs = 60_000; // check every 60s
  private lastGitCommit = 0;

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

  /**
   * Wire external modules into the event loop.
   * Called by VedApp after module initialization.
   */
  setModules(modules: {
    llm: LLMClient;
    mcp: MCPClient;
    memory: MemoryManager;
    rag: RagPipeline;
    channels: ChannelManager;
  }): void {
    this.llm = modules.llm;
    this.mcp = modules.mcp;
    this.memory = modules.memory;
    this.rag = modules.rag;
    this.channels = modules.channels;

    // Create compressor now that LLM + memory are available
    this.compressor = new Compressor({
      llm: modules.llm,
      memory: modules.memory,
      onAudit: (input) => this.audit.append(input),
    });

    // Create idle timer for proactive session management
    this.idleTimer = new SessionIdleTimer(
      {
        sessionIdleMinutes: this.config.memory.sessionIdleMinutes,
        checkIntervalMs: this.staleCheckIntervalMs,
      },
      {
        sessions: this.sessions,
        audit: this.audit,
        compressor: this.compressor,
      },
    );
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

    // Start idle timer for proactive session management
    if (this.idleTimer) {
      this.idleTimer.start();
    }

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

    // Stop idle timer first
    if (this.idleTimer) {
      this.idleTimer.stop();
    }

    // Close all active sessions and compress their T1 → T2
    const stale = this.sessions.closeStale(0);
    if (stale.length > 0) {
      log.info('Closed sessions on shutdown', { count: stale.length });

      // Compress each session's working memory
      if (this.compressor) {
        for (const session of stale) {
          if (session.workingMemory.messageCount < 2) continue;
          try {
            await this.compressor.compress(
              session.workingMemory,
              session.id,
              'shutdown',
            );
          } catch (err) {
            log.warn('Shutdown compression failed', {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
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
    // Track message ID to prevent double-processing on recovery (VULN-12)
    this.recoveredIds.add(msg.id);

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

  // Track inbox message IDs to prevent double-processing (VULN-12)
  private recoveredIds: Set<string> = new Set();

  /**
   * Recover unprocessed inbox messages from a previous crash.
   * Re-enqueues them for processing.
   *
   * SECURITY (VULN-12): Tracks recovered message IDs to prevent
   * double-processing if receive() was called before recovery.
   */
  private recoverInbox(): void {
    const rows = this.stmtInboxUnprocessed.all() as InboxRow[];
    if (rows.length === 0) return;

    log.warn('Recovering unprocessed inbox messages', { count: rows.length });

    for (const row of rows) {
      // Skip if this message was already enqueued via receive() (VULN-12 fix)
      if (this.recoveredIds.has(row.id)) continue;
      this.recoveredIds.add(row.id);

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

    // Run async pipeline — schedule as microtask
    this.processMessageAsync(msg).catch((err) => {
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
    });
  }

  /**
   * Async implementation of the 7-step pipeline.
   */
  private async processMessageAsync(msg: VedMessage): Promise<void> {
    // ─── Step 1: RECEIVE ───
    const trustTier = this.trust.resolveTier(msg.channel, msg.author);
    const session = this.sessions.getOrCreate(
      msg.channel,
      '', // channelId — filled by adapter
      msg.author,
      trustTier,
    );

    // Mark inbox as processed
    this.stmtInboxProcessed.run({ id: msg.id, sessionId: session.id });

    // ─── Check for approval commands (bypass LLM) ───
    const command = parseApprovalCommand(msg.content);
    if (command) {
      const result = executeApprovalCommand(command, msg.channel, msg.author, {
        workOrders: this.workOrders,
        trust: this.trust,
        audit: this.audit,
        onApproved: (wo) => this.executeApprovedWorkOrder(wo, msg.channel),
      });

      // Send command response via channel
      if (this.channels) {
        const response: VedResponse = {
          id: ulid(),
          inReplyTo: msg.id,
          content: result.response,
          actions: [],
          memoryOps: [],
          channelRef: '',
        };
        try {
          await this.channels.send(msg.channel, response);
        } catch (err) {
          log.error('Failed to send approval response', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.info('Approval command handled', {
        messageId: msg.id,
        action: command.action,
        workOrderId: command.workOrderId,
      });
      return;
    }

    // Add user message to working memory
    session.workingMemory.addMessage({
      role: 'user',
      content: msg.content,
      timestamp: msg.timestamp,
    });

    // Audit: message received
    this.audit.append({
      eventType: 'message_received',
      actor: msg.author,
      sessionId: session.id,
      detail: { messageId: msg.id, channel: msg.channel, contentLength: msg.content.length },
    });

    // ─── Step 2: ENRICH ───
    let ragContext = '';
    if (this.rag) {
      try {
        const retrieval = await this.rag.retrieve(msg.content);
        ragContext = retrieval.text;
        if (retrieval.results.length > 0) {
          log.debug('RAG context retrieved', {
            results: retrieval.results.length,
            tokens: retrieval.tokenCount,
            ms: retrieval.metrics.totalMs,
          });
        }
      } catch (err) {
        log.warn('RAG retrieval failed — continuing without context', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Build messages array and system prompt for LLM
    const messages = session.workingMemory.messages;
    const systemPrompt = this.buildSystemPrompt(ragContext);
    const mcpTools = this.mcp ? this.mcp.tools : [];
    // Map MCP tool definitions to LLM format
    const tools = mcpTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      riskLevel: t.riskLevel,
    }));

    // ─── Step 3: DECIDE ───
    let responseText = '';
    let toolCalls: ToolCall[] = [];

    if (this.llm) {
      const llmResponse = await this.llm.chat({
        systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      responseText = llmResponse.decision.response ?? '';
      toolCalls = llmResponse.decision.toolCalls;

      this.audit.append({
        eventType: 'llm_call',
        actor: 'ved',
        sessionId: session.id,
        detail: {
          model: llmResponse.usage.model,
          promptTokens: llmResponse.usage.promptTokens,
          completionTokens: llmResponse.usage.completionTokens,
          toolCallCount: toolCalls.length,
          durationMs: llmResponse.durationMs,
        },
      });

      // ─── Step 4: ACT (agentic loop) ───
      let loopCount = 0;
      const maxLoops = this.config.trust.maxAgenticLoops;

      while (toolCalls.length > 0 && loopCount < maxLoops) {
        loopCount++;
        const toolResults: ToolResult[] = [];

        for (const call of toolCalls) {
          const toolDef = this.mcp?.getTool(call.tool);
          const riskLevel = toolDef?.riskLevel ?? 'medium';
          const trustDecision = this.trust.getTrustDecision(trustTier, riskLevel);

          if (trustDecision === 'deny') {
            toolResults.push({
              callId: call.id, tool: call.tool, success: false,
              error: `Denied: insufficient trust (tier ${trustTier}) for ${riskLevel}-risk tool`,
              durationMs: 0,
            });
            this.audit.append({
              eventType: 'tool_denied', actor: 'ved', sessionId: session.id,
              detail: { tool: call.tool, riskLevel, trustTier },
            });
            continue;
          }

          if (trustDecision === 'approve') {
            const workOrder = this.workOrders.create(
              session.id,
              msg.id,
              call.tool,
              call.params,
              { level: riskLevel, reasons: [`Trust tier ${trustTier}, risk ${riskLevel}`] },
              trustTier,
              toolDef?.serverName ?? '',
            );

            if (this.channels) {
              await this.channels.notifyApproval(msg.channel, workOrder);
            }

            toolResults.push({
              callId: call.id, tool: call.tool, success: false,
              error: `Awaiting approval (work order ${workOrder.id})`,
              durationMs: 0,
            });
            this.audit.append({
              eventType: 'work_order_created', actor: 'ved', sessionId: session.id,
              detail: { workOrderId: workOrder.id, tool: call.tool, riskLevel },
            });
            continue;
          }

          // auto — execute immediately
          this.audit.append({
            eventType: 'tool_requested', actor: 'ved', sessionId: session.id,
            detail: { tool: call.tool, params: call.params },
          });

          const result = await this.mcp!.executeTool(call);
          toolResults.push(result);

          this.audit.append({
            eventType: result.success ? 'tool_executed' : 'tool_error',
            actor: 'ved', sessionId: session.id,
            detail: { tool: call.tool, success: result.success, durationMs: result.durationMs, error: result.error },
          });
        }

        // Feed tool results back to LLM — add as tool messages
        const toolMessages = toolResults.map(r => ({
          role: 'tool' as const,
          content: r.success ? String(r.result ?? '') : `Error: ${r.error}`,
          name: r.tool,
          toolCallId: r.callId,
          timestamp: Date.now(),
        }));

        const followUp = await this.llm.chat({
          systemPrompt,
          messages: [...messages, ...toolMessages],
          tools: tools.length > 0 ? tools : undefined,
          toolResults: toolResults.map(r => ({
            callId: r.callId,
            tool: r.tool,
            success: r.success,
            result: r.result,
            error: r.error,
          })),
        });

        responseText = followUp.decision.response ?? responseText;
        toolCalls = followUp.decision.toolCalls;

        this.audit.append({
          eventType: 'llm_call', actor: 'ved', sessionId: session.id,
          detail: {
            agenticLoop: loopCount,
            model: followUp.usage.model,
            promptTokens: followUp.usage.promptTokens,
            completionTokens: followUp.usage.completionTokens,
            toolCallCount: toolCalls.length,
          },
        });
      }

      if (loopCount >= maxLoops && toolCalls.length > 0) {
        log.warn('Agentic loop limit reached', { maxLoops, sessionId: session.id });
        responseText += '\n\n⚠️ Tool call loop limit reached. Some actions may be incomplete.';
      }
    } else {
      responseText = `[No LLM configured] Received: ${msg.content}`;
    }

    // ─── Step 5: RECORD ───
    // Add assistant message to working memory
    if (responseText) {
      session.workingMemory.addMessage({
        role: 'assistant',
        content: responseText,
        timestamp: Date.now(),
      });
    }

    // ─── Step 6: RESPOND ───
    if (responseText && this.channels) {
      const response: VedResponse = {
        id: ulid(),
        inReplyTo: msg.id,
        content: responseText,
        actions: [],
        memoryOps: [],
        channelRef: '', // channel adapter fills this
      };

      try {
        await this.channels.send(msg.channel, response);
        this.audit.append({
          eventType: 'message_sent',
          actor: 'ved',
          sessionId: session.id,
          detail: { responseId: response.id, channel: msg.channel, contentLength: responseText.length },
        });
      } catch (err) {
        log.error('Failed to send response', {
          channel: msg.channel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ─── Step 7: MAINTAIN ───
    this.maintain(session);

    // Persist session state
    this.sessions.persist(session);

    log.info('Message processed', { messageId: msg.id, sessionId: session.id });
  }

  // =========================================================================
  // Post-Approval Tool Execution
  // =========================================================================

  /**
   * Execute a tool call after a work order has been approved.
   *
   * This completes the HITL loop:
   *   1. Retrieve the approved work order's tool + params
   *   2. Execute the tool via MCP
   *   3. Update work order status (completed/failed)
   *   4. Send the result back to the originating channel
   *   5. Audit everything
   *
   * Runs as a fire-and-forget async task — the approval response is sent
   * immediately, and the tool result follows when execution completes.
   */
  private executeApprovedWorkOrder(wo: WorkOrder, approvalChannel: ChannelId): void {
    if (!this.mcp) {
      log.warn('Cannot execute approved work order — no MCP client', { workOrderId: wo.id });
      return;
    }

    // Fire-and-forget — don't block the approval response
    this.executeApprovedWorkOrderAsync(wo, approvalChannel).catch((err) => {
      log.error('Post-approval execution failed', {
        workOrderId: wo.id,
        tool: wo.tool,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async executeApprovedWorkOrderAsync(wo: WorkOrder, approvalChannel: ChannelId): Promise<void> {
    const toolCall: ToolCall = {
      id: `post-approve-${wo.id}`,
      tool: wo.tool,
      params: wo.params,
    };

    // Audit: tool execution starting
    this.audit.append({
      eventType: 'tool_requested',
      actor: 'ved',
      sessionId: wo.sessionId,
      detail: {
        tool: wo.tool,
        params: wo.params,
        workOrderId: wo.id,
        trigger: 'post_approval',
      },
    });

    // Execute the tool
    const result = await this.mcp!.executeTool(toolCall);

    // Audit: tool result
    this.audit.append({
      eventType: result.success ? 'tool_executed' : 'tool_error',
      actor: 'ved',
      sessionId: wo.sessionId,
      detail: {
        tool: wo.tool,
        workOrderId: wo.id,
        success: result.success,
        durationMs: result.durationMs,
        error: result.error,
        trigger: 'post_approval',
      },
    });

    // Update work order status in DB
    this.updateWorkOrderResult(wo.id, result);

    // Build result message for the channel
    const resultText = result.success
      ? `🔧 **Work order \`${wo.id}\` completed**\nTool: \`${wo.tool}\`\n\n${formatToolResult(result.result)}`
      : `❌ **Work order \`${wo.id}\` failed**\nTool: \`${wo.tool}\`\nError: ${result.error}`;

    // Send result to the channel where approval happened
    if (this.channels) {
      const response: VedResponse = {
        id: ulid(),
        inReplyTo: wo.messageId,
        content: resultText,
        actions: [],
        memoryOps: [],
        channelRef: '',
      };

      try {
        await this.channels.send(approvalChannel, response);
      } catch (err) {
        log.error('Failed to send post-approval result', {
          workOrderId: wo.id,
          channel: approvalChannel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Add result to the session's working memory so the LLM has context
    const session = this.sessions.get(wo.sessionId);
    if (session) {
      session.workingMemory.addMessage({
        role: 'tool',
        content: result.success
          ? `[Approved tool result for ${wo.tool}]: ${formatToolResult(result.result)}`
          : `[Approved tool ${wo.tool} failed]: ${result.error}`,
        name: wo.tool,
        toolCallId: toolCall.id,
        timestamp: Date.now(),
      });
      // Persist the updated working memory so the tool result survives
      this.sessions.persist(session);
    }

    log.info('Post-approval execution complete', {
      workOrderId: wo.id,
      tool: wo.tool,
      success: result.success,
      durationMs: result.durationMs,
    });
  }

  /**
   * Update a work order's result/error and final status in the DB.
   */
  private updateWorkOrderResult(workOrderId: string, result: ToolResult): void {
    try {
      this.db.prepare(`
        UPDATE work_orders
        SET status = @status, result = @result, error = @error
        WHERE id = @id
      `).run({
        id: workOrderId,
        status: result.success ? 'completed' : 'failed',
        result: result.result !== undefined ? JSON.stringify(result.result) : null,
        error: result.error ?? null,
      });
    } catch (err) {
      log.error('Failed to update work order result', {
        workOrderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // =========================================================================
  // Step 7: MAINTAIN
  // =========================================================================

  /**
   * Post-message maintenance tasks.
   * - Check if working memory needs compression (T1→T2)
   * - Close stale sessions (T1→T2 flush)
   * - Expire stale work orders
   * - Periodic anchor creation
   * - RAG re-indexing
   * - Git auto-commit
   */
  private maintain(session: Session): void {
    // 1. Check T1 compression threshold → compress to T2
    if (this.compressor && this.compressor.shouldCompress(
      session.workingMemory,
      this.config.memory.compressionThreshold,
    )) {
      log.info('Working memory exceeded threshold — compressing', {
        sessionId: session.id,
        tokenCount: session.workingMemory.tokenCount,
        threshold: this.config.memory.compressionThreshold,
      });

      this.compressor.compress(
        session.workingMemory,
        session.id,
        'threshold',
      ).catch((err: unknown) => {
        log.error('T1→T2 compression failed', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // 2. Close stale sessions periodically (every 60s)
    const now = Date.now();
    if (now - this.lastStaleCheck > this.staleCheckIntervalMs) {
      this.lastStaleCheck = now;
      this.closeAndCompressStale();
    }

    // 3. Expire stale work orders
    this.workOrders.sweepExpired();

    // 4. Create anchor if we've passed the interval
    const head = this.audit.getChainHead();
    if (head.count > 0 && head.count % this.config.audit.anchorInterval === 0) {
      this.anchors.createAnchor(head, this.config.audit.hmacSecret);
      log.debug('Anchor created', { chainLength: head.count });
    }

    // 5. Drain RAG re-index queue (non-blocking)
    if (this.rag && this.memory) {
      const vault = this.memory.vault;
      this.rag.drainQueue(async (path: string) => {
        try {
          return vault.readFile(path);
        } catch {
          return null;
        }
      }).catch((err: unknown) => {
        log.warn('RAG drain queue failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // 6. Git auto-commit if interval elapsed
    if (this.memory && this.config.memory.gitEnabled) {
      const commitInterval = this.config.memory.gitAutoCommitIntervalMinutes * 60_000;
      if (now - this.lastGitCommit > commitInterval) {
        this.lastGitCommit = now;
        this.memory.vault.git.flush('ved: auto-commit — periodic vault sync');
      }
    }
  }

  /**
   * Close stale sessions and compress their T1 → T2.
   * Called periodically from maintain().
   */
  private closeAndCompressStale(): void {
    const staleSessions = this.sessions.closeStale(this.config.memory.sessionIdleMinutes);

    if (staleSessions.length === 0) return;

    log.info('Closing stale sessions', { count: staleSessions.length });

    for (const session of staleSessions) {
      if (!this.compressor) continue;
      if (session.workingMemory.messageCount < 2) continue;

      this.compressor.compress(
        session.workingMemory,
        session.id,
        'idle',
      ).catch((err: unknown) => {
        log.warn('Stale session compression failed', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // =========================================================================
  // Prompt Assembly
  // =========================================================================

  /**
   * Build the system prompt with RAG context injected.
   */
  private buildSystemPrompt(ragContext: string): string {
    const parts: string[] = [];

    parts.push('You are Ved, a personal AI assistant. You remember everything and prove it.');
    parts.push('');
    parts.push('## Rules');
    parts.push('- Be concise, accurate, and helpful.');
    parts.push('- Use tools when they help answer the question. Do not hallucinate tool results.');
    parts.push('- When asked to remember something, acknowledge and confirm.');
    parts.push('- Cite your knowledge sources when relevant (e.g. "From your vault: ...")');
    parts.push('');

    if (ragContext) {
      parts.push('## Retrieved Knowledge (from your vault)');
      parts.push(ragContext);
      parts.push('');
    }

    // TODO: Load custom system prompt from config.llm.systemPromptPath
    // TODO: Inject working memory facts section

    return parts.join('\n');
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

// === Helpers ===

/**
 * Format a tool result for display. Handles JSON objects, strings, and unknown types.
 */
function formatToolResult(result: unknown): string {
  if (result === undefined || result === null) return '(no output)';
  if (typeof result === 'string') return result.slice(0, 2000);
  try {
    const json = JSON.stringify(result, null, 2);
    return json.length > 2000 ? json.slice(0, 2000) + '\n...(truncated)' : json;
  } catch {
    return String(result).slice(0, 2000);
  }
}
