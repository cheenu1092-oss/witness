/**
 * Tests for post-approval tool execution (Session 41).
 *
 * Validates the full HITL loop:
 *   approve command → work order resolved → tool executed → result sent to channel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ulid } from 'ulid';
import { EventLoop, type EventLoopOptions } from './event-loop.js';
import type { VedConfig, VedMessage, VedResponse, WorkOrder, ToolResult } from '../types/index.js';
import type { LLMClient } from '../llm/client.js';
import type { MCPClient } from '../mcp/client.js';
import type { MemoryManager } from '../memory/manager.js';
import type { RagPipeline } from '../rag/pipeline.js';
import type { ChannelManager } from '../channel/manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === Test config ===

function testConfig(): VedConfig {
  return {
    version: '0.1.0-test',
    dataDir: '/tmp/ved-test',
    llm: {
      provider: 'ollama',
      model: 'test',
      baseUrl: 'http://localhost:11434',
      systemPromptPath: '',
      maxTokens: 4096,
      temperature: 0.7,
    },
    mcp: { servers: [], toolTimeout: 5000 },
    memory: {
      vaultPath: '/tmp/ved-vault',
      workingMemoryMaxTokens: 8000,
      compressionThreshold: 6000,
      sessionIdleMinutes: 30,
      gitEnabled: false,
      gitAutoCommitIntervalMinutes: 5,
    },
    trust: {
      ownerIds: ['owner-1'],
      defaultTier: 1 as const,
      channelRules: [
        { channel: 'discord' as const, authorPattern: 'owner-1', tier: 4 as const },
      ],
      maxAgenticLoops: 5,
      approvalTimeoutMs: 300000,
    },
    audit: {
      hmacSecret: 'test-hmac-secret',
      anchorInterval: 100,
      retentionDays: 90,
    },
    channels: { discord: { token: '', guildId: '' } },
  };
}

function testDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Load the actual migration SQL for schema consistency
  const migrationPath = resolve(__dirname, '../db/migrations/v001_initial.sql');
  const sql = readFileSync(migrationPath, 'utf-8');
  db.exec(sql);

  return db;
}

// === Mock factories ===

function mockMCP() {
  return {
    name: 'mcp',
    init: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(),
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {},
        riskLevel: 'low' as const,
        serverName: 'fs',
      },
    ],
    getTool: vi.fn((name: string) => ({
      name,
      description: 'test tool',
      inputSchema: {},
      riskLevel: 'medium' as const,
      serverName: 'test-server',
    })),
    executeTool: vi.fn(async () => ({
      callId: 'test-call',
      tool: 'read_file',
      success: true,
      result: 'file contents here',
      durationMs: 42,
    })),
  } as unknown as MCPClient;
}

function mockLLM() {
  return {
    name: 'llm',
    init: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(),
    chat: vi.fn(async () => ({
      decision: { response: 'LLM response', toolCalls: [], memoryOps: [] },
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, model: 'test', provider: 'test' },
      durationMs: 100,
    })),
  } as unknown as LLMClient;
}

function mockChannels() {
  return {
    name: 'channels',
    init: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(),
    send: vi.fn(async () => {}),
    notifyApproval: vi.fn(async () => {}),
  } as unknown as ChannelManager;
}

function mockMemory() {
  return {
    name: 'memory',
    init: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(),
    vault: { readFile: vi.fn(), git: { flush: vi.fn() } },
    writeCompression: vi.fn(() => 'daily/2026-03-05.md'),
    appendToDaily: vi.fn(),
    upsertEntity: vi.fn(),
  } as unknown as MemoryManager;
}

function mockRag() {
  return {
    name: 'rag',
    init: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(),
    retrieve: vi.fn(async () => ({ text: '', results: [], tokenCount: 0, metrics: { totalMs: 0 } })),
    drainQueue: vi.fn(async () => {}),
  } as unknown as RagPipeline;
}

// === Helper to run messages through the loop ===

async function runPipeline(
  loop: EventLoop,
  messages: VedMessage[],
  opts?: { waitMs?: number },
): Promise<void> {
  const waitMs = opts?.waitMs ?? 500;
  const runPromise = loop.run();
  await new Promise(r => setTimeout(r, 50));
  for (const msg of messages) {
    loop.receive(msg);
  }
  await new Promise(r => setTimeout(r, waitMs));
  loop.requestShutdown();
  await runPromise;
}

// === Tests ===

describe('Post-Approval Tool Execution', () => {
  let db: Database.Database;
  let loop: EventLoop;
  let mcp: ReturnType<typeof mockMCP>;
  let channels: ReturnType<typeof mockChannels>;
  let llm: ReturnType<typeof mockLLM>;

  beforeEach(() => {
    db = testDb();
    const config = testConfig();
    loop = new EventLoop({ config, db });

    mcp = mockMCP();
    llm = mockLLM();
    channels = mockChannels();
    const memory = mockMemory();
    const rag = mockRag();

    loop.setModules({
      llm: llm as unknown as LLMClient,
      mcp: mcp as unknown as MCPClient,
      memory: memory as unknown as MemoryManager,
      rag: rag as unknown as RagPipeline,
      channels: channels as unknown as ChannelManager,
    });
  });

  afterEach(async () => {
    if (loop.isRunning) {
      loop.requestShutdown();
      // Wait for shutdown to complete before closing DB
      await new Promise(r => setTimeout(r, 200));
    }
    db.close();
  });

  // Helper: create a work order
  function createWorkOrder(tool = 'read_file', params: Record<string, unknown> = { path: '/test.txt' }): WorkOrder {
    return loop.workOrders.create(
      'test-session',
      'test-msg',
      tool,
      params,
      { level: 'medium', reasons: ['test'] },
      2 as any, // trust tier 2
      'test-server',
    );
  }

  it('executes tool after approval and sends result to channel', async () => {
    const wo = createWorkOrder();

    const approveMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: `approve ${wo.id}`,
      timestamp: Date.now(),
    };

    await runPipeline(loop, [approveMsg]);

    // Verify tool was executed via MCP
    expect(mcp.executeTool).toHaveBeenCalledOnce();
    const toolCall = (mcp.executeTool as any).mock.calls[0][0];
    expect(toolCall.tool).toBe('read_file');
    expect(toolCall.params).toEqual({ path: '/test.txt' });

    // Verify result was sent to channel (2 sends: approval ack + tool result)
    expect(channels.send).toHaveBeenCalledTimes(2);

    // First call: approval acknowledgment
    const ackResponse = (channels.send as any).mock.calls[0][1] as VedResponse;
    expect(ackResponse.content).toContain('Approved');

    // Second call: tool result
    const resultResponse = (channels.send as any).mock.calls[1][1] as VedResponse;
    expect(resultResponse.content).toContain('completed');
    expect(resultResponse.content).toContain('file contents here');
  });

  it('updates work order status to completed on success', async () => {
    const wo = createWorkOrder();

    const approveMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: `approve ${wo.id}`,
      timestamp: Date.now(),
    };

    await runPipeline(loop, [approveMsg]);

    const updated = loop.workOrders.getById(wo.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
  });

  it('updates work order status to failed on tool error', async () => {
    (mcp.executeTool as any).mockResolvedValueOnce({
      callId: 'test-call',
      tool: 'read_file',
      success: false,
      error: 'File not found: /test.txt',
      durationMs: 5,
    });

    const wo = createWorkOrder();

    const approveMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: `approve ${wo.id}`,
      timestamp: Date.now(),
    };

    await runPipeline(loop, [approveMsg]);

    const updated = loop.workOrders.getById(wo.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toContain('File not found');

    // Result message should indicate failure
    const resultCall = (channels.send as any).mock.calls.find(
      (c: any[]) => c[1].content.includes('failed')
    );
    expect(resultCall).toBeTruthy();
  });

  it('audits both tool_requested and tool_executed for post-approval', async () => {
    const wo = createWorkOrder();

    const approveMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: `approve ${wo.id}`,
      timestamp: Date.now(),
    };

    await runPipeline(loop, [approveMsg]);

    const entries = db.prepare(
      `SELECT * FROM audit_log WHERE detail LIKE '%post_approval%' ORDER BY timestamp ASC`
    ).all() as any[];

    expect(entries.length).toBeGreaterThanOrEqual(2);

    const requested = entries.find(e => e.event_type === 'tool_requested');
    expect(requested).toBeTruthy();
    const reqDetail = JSON.parse(requested.detail);
    expect(reqDetail.trigger).toBe('post_approval');
    expect(reqDetail.workOrderId).toBe(wo.id);

    const executed = entries.find(e => e.event_type === 'tool_executed');
    expect(executed).toBeTruthy();
    const execDetail = JSON.parse(executed.detail);
    expect(execDetail.trigger).toBe('post_approval');
    expect(execDetail.success).toBe(true);
  });

  it('handles MCP execution throwing an exception', async () => {
    (mcp.executeTool as any).mockRejectedValueOnce(new Error('MCP connection lost'));

    const wo = createWorkOrder();

    const approveMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: `approve ${wo.id}`,
      timestamp: Date.now(),
    };

    await runPipeline(loop, [approveMsg]);

    // Should not crash — error is caught and logged
    // Approval ack should still have been sent
    expect(channels.send).toHaveBeenCalledTimes(1); // only ack, no result (exception)
  });

  it('does not execute tool when denied', async () => {
    const wo = createWorkOrder();

    const denyMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: `deny ${wo.id} not now`,
      timestamp: Date.now(),
    };

    await runPipeline(loop, [denyMsg]);

    // Tool should NOT be executed
    expect(mcp.executeTool).not.toHaveBeenCalled();

    // Work order should be denied
    const updated = loop.workOrders.getById(wo.id);
    expect(updated!.status).toBe('denied');
  });

  it('preserves original tool params through approval cycle', async () => {
    const complexParams = {
      path: '/data/important.json',
      encoding: 'utf-8',
      nested: { depth: 3, keys: ['a', 'b'] },
    };
    const wo = createWorkOrder('read_file', complexParams);

    const approveMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: `approve ${wo.id}`,
      timestamp: Date.now(),
    };

    await runPipeline(loop, [approveMsg]);

    const toolCall = (mcp.executeTool as any).mock.calls[0][0];
    expect(toolCall.params).toEqual(complexParams);
  });

  it('adds tool result to session working memory', async () => {
    // Create a session by sending a message, then approve a work order in the SAME run cycle.
    // This avoids shutdown compression clearing the session between runs.
    const initMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: 'hello',
      timestamp: Date.now(),
    };

    // Start single pipeline run
    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    // Send init message to create a session
    loop.receive(initMsg);
    await new Promise(r => setTimeout(r, 500));

    // Find the session that was created
    const sessions = db.prepare(`SELECT id FROM sessions WHERE author_id = 'owner-1'`).all() as any[];
    const sessionId = sessions[0]?.id;
    expect(sessionId).toBeTruthy();

    // Create work order with that session ID
    const wo = loop.workOrders.create(
      sessionId,
      'test-msg',
      'read_file',
      { path: '/test.txt' },
      { level: 'medium', reasons: ['test'] },
      2 as any,
      'test-server',
    );

    // Approve within the same run cycle
    const approveMsg: VedMessage = {
      id: ulid(),
      channel: 'discord',
      author: 'owner-1',
      content: `approve ${wo.id}`,
      timestamp: Date.now(),
    };
    loop.receive(approveMsg);
    // Wait long enough for approval processing + async post-approval tool execution
    await new Promise(r => setTimeout(r, 1000));

    // The session's working memory should now contain the tool result
    const session = loop.sessions.get(sessionId);
    expect(session).toBeTruthy();
    const toolMsg = session!.workingMemory.messages.find(
      m => m.role === 'tool' && m.content.includes('file contents here')
    );
    expect(toolMsg).toBeTruthy();

    loop.requestShutdown();
    await runPromise;
  });
});
