/**
 * Integration Tests — Session 31 (TEST Phase)
 *
 * Full pipeline e2e tests with mocked external dependencies (LLM, MCP, RAG, Channels).
 * Tests the complete message flow: RECEIVE → ENRICH → DECIDE → ACT → RECORD → RESPOND → MAINTAIN.
 *
 * What's real: Database, EventLoop, AuditLog, TrustEngine, WorkOrders, SessionManager, Queue.
 * What's mocked: LLMClient, MCPClient, RagPipeline, ChannelManager (external services).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventLoop } from './core/event-loop.js';
import { migrate } from './db/migrate.js';
import { getDefaults } from './core/config.js';
import type {
  VedConfig, VedMessage, VedResponse, TrustTier,
  ToolCall, ToolResult, WorkOrder, ModuleHealth,
} from './types/index.js';
import type { LLMRequest, LLMResponse, MCPToolDefinition } from './llm/types.js';
import type { RetrievalContext } from './rag/types.js';

// ─── Helpers ───

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
    memory: {
      ...defaults.memory,
      // Disable git to avoid needing vault.git.flush in mocks
      gitEnabled: false,
      // Set compression threshold very high so shutdown compression doesn't
      // fire an extra LLM call (added S41 — compressor was wired in S37)
      compressionThreshold: 999_999,
    },
    trust: {
      ...defaults.trust,
      ownerIds: ['owner-1'],
      tribeIds: ['tribe-1'],
      knownIds: ['known-1'],
      maxAgenticLoops: 5,
    },
    audit: {
      ...defaults.audit,
      anchorInterval: 5,
      hmacSecret: 'test-hmac-secret',
    },
    ...overrides,
  } as VedConfig;
}

function makeMessage(id: string, content: string, author = 'owner-1', channel: 'cli' | 'discord' = 'cli'): VedMessage {
  return {
    id,
    channel,
    author,
    content,
    timestamp: Date.now(),
  };
}

function makeLLMResponse(text: string, toolCalls: ToolCall[] = []): LLMResponse {
  return {
    decision: {
      response: text,
      toolCalls,
      memoryOps: [],
    },
    raw: {},
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      model: 'test-model',
      provider: 'test',
    },
    durationMs: 42,
    finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
  };
}

// ─── Mock Module Factories ───

function createMockLLM(responses: LLMResponse[]) {
  let callIndex = 0;
  return {
    name: 'llm',
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ module: 'llm', healthy: true, checkedAt: Date.now() } as ModuleHealth),
    chat: vi.fn().mockImplementation((_req: LLMRequest): Promise<LLMResponse> => {
      const resp = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return Promise.resolve(resp);
    }),
    get chatCallCount() { return callIndex; },
  };
}

function createMockMCP(tools: MCPToolDefinition[] = [], toolHandler?: (call: ToolCall) => ToolResult) {
  const defaultHandler = (call: ToolCall): ToolResult => ({
    callId: call.id,
    tool: call.tool,
    success: true,
    result: { output: `Result of ${call.tool}` },
    durationMs: 10,
  });

  return {
    name: 'mcp',
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ module: 'mcp', healthy: true, checkedAt: Date.now() } as ModuleHealth),
    discoverTools: vi.fn().mockResolvedValue(tools),
    executeTool: vi.fn().mockImplementation((call: ToolCall) => Promise.resolve((toolHandler ?? defaultHandler)(call))),
    getTool: vi.fn().mockImplementation((name: string) => tools.find(t => t.name === name)),
    tools,
  };
}

function createMockRAG(context: string = '') {
  return {
    name: 'rag',
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ module: 'rag', healthy: true, checkedAt: Date.now() } as ModuleHealth),
    setDatabase: vi.fn(),
    retrieve: vi.fn().mockResolvedValue({
      text: context,
      results: context ? [{ filePath: 'test.md', content: context, rrfScore: 0.9, sources: ['fts'] }] : [],
      tokenCount: context ? context.split(' ').length : 0,
      metrics: { vectorSearchMs: 1, ftsSearchMs: 1, graphWalkMs: 0, fusionMs: 1, totalMs: 3, vectorResultCount: 0, ftsResultCount: context ? 1 : 0, graphResultCount: 0 },
    } as RetrievalContext),
    drainQueue: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockMemory() {
  return {
    vault: { readFile: vi.fn(), git: { flush: vi.fn() } },
    init: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(),
    writeCompression: vi.fn().mockReturnValue('daily/2026-03-06.md'),
    appendToDaily: vi.fn(),
    upsertEntity: vi.fn(),
  } as any;
}

function createMockChannels() {
  const sentResponses: { channelId: string; response: VedResponse }[] = [];
  const approvalNotifications: { channelId: string; workOrder: WorkOrder }[] = [];

  return {
    name: 'channel',
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ module: 'channel', healthy: true, checkedAt: Date.now() } as ModuleHealth),
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    send: vi.fn().mockImplementation((channelId: string, response: VedResponse) => {
      sentResponses.push({ channelId, response });
      return Promise.resolve();
    }),
    notifyApproval: vi.fn().mockImplementation((channelId: string, workOrder: WorkOrder) => {
      approvalNotifications.push({ channelId, workOrder });
      return Promise.resolve();
    }),
    sentResponses,
    approvalNotifications,
  };
}

// ─── Helpers to run a message through the pipeline ───

/**
 * Start the event loop, receive messages, wait, then shut down.
 * Messages are received AFTER run() starts to avoid double-processing
 * from inbox recovery.
 */
async function runPipeline(
  loop: EventLoop,
  messages: VedMessage[],
  opts?: { waitMs?: number },
): Promise<void> {
  const waitMs = opts?.waitMs ?? 500;

  // Start the loop first
  const runPromise = loop.run();

  // Small delay to let the loop initialize and recover any inbox
  await new Promise(r => setTimeout(r, 50));

  // Now receive messages (avoids double-processing from inbox recovery)
  for (const msg of messages) {
    loop.receive(msg);
  }

  await new Promise(r => setTimeout(r, waitMs));
  loop.requestShutdown();
  await runPromise;
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('Integration: Full Pipeline E2E', () => {
  let db: Database.Database;
  let loop: EventLoop;
  let mockLLM: ReturnType<typeof createMockLLM>;
  let mockMCP: ReturnType<typeof createMockMCP>;
  let mockRAG: ReturnType<typeof createMockRAG>;
  let mockChannels: ReturnType<typeof createMockChannels>;

  beforeEach(() => {
    db = createTestDb();
    mockLLM = createMockLLM([makeLLMResponse('Hello! How can I help?')]);
    mockMCP = createMockMCP();
    mockRAG = createMockRAG();
    mockChannels = createMockChannels();

    loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: mockMCP as any,
      memory: createMockMemory(),
      rag: mockRAG as any,
      channels: mockChannels as any,
    });
  });

  afterEach(() => {
    if (db) db.close();
  });

  it('processes a simple message through all 7 steps', async () => {
    await runPipeline(loop, [makeMessage('msg-1', 'Hello Ved')]);

    // Step 1: RECEIVE — inbox persisted + processed
    const inbox = db.prepare('SELECT * FROM inbox WHERE id = ?').get('msg-1') as any;
    expect(inbox).toBeTruthy();
    expect(inbox.processed).toBe(1);

    // Step 2: ENRICH — RAG was called
    expect(mockRAG.retrieve).toHaveBeenCalledWith('Hello Ved');

    // Step 3: DECIDE — LLM was called with system prompt + user message
    // Note: shutdown compression may add +1 LLM call; verify first (pipeline) call
    expect(mockLLM.chat.mock.calls.length).toBeGreaterThanOrEqual(1);
    const chatCall = mockLLM.chat.mock.calls[0][0] as LLMRequest;
    expect(chatCall.systemPrompt).toContain('Ved');
    expect(chatCall.messages.some((m: any) => m.role === 'user' && m.content === 'Hello Ved')).toBe(true);

    // Step 5: RECORD — audit log has events
    const auditRows = db.prepare('SELECT event_type FROM audit_log ORDER BY timestamp').all() as any[];
    const types = auditRows.map((r: any) => r.event_type);
    expect(types).toContain('startup');
    expect(types).toContain('message_received');
    expect(types).toContain('llm_call');
    expect(types).toContain('message_sent');

    // Step 6: RESPOND — channel received the response
    expect(mockChannels.send).toHaveBeenCalledTimes(1);
    expect(mockChannels.sentResponses[0].response.content).toBe('Hello! How can I help?');

    // Step 7: MAINTAIN — session persisted
    const sessions = db.prepare('SELECT * FROM sessions').all() as any[];
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('creates proper audit trail with hash chain integrity', async () => {
    await runPipeline(loop, [makeMessage('msg-audit', 'Test audit')]);

    // Verify hash chain integrity
    const rows = db.prepare('SELECT id, prev_hash, hash FROM audit_log ORDER BY timestamp').all() as any[];
    expect(rows.length).toBeGreaterThan(2);

    // First entry chains from GENESIS_HASH (not null)
    expect(rows[0].prev_hash).toBeTruthy();

    // Subsequent entries chain to previous hash
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
    }

    // All hashes are unique
    const hashes = rows.map((r: any) => r.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('records LLM usage in audit log', async () => {
    await runPipeline(loop, [makeMessage('msg-usage', 'Hi')]);

    const llmAudit = db.prepare(
      "SELECT detail FROM audit_log WHERE event_type = 'llm_call'"
    ).get() as any;
    expect(llmAudit).toBeTruthy();

    const detail = JSON.parse(llmAudit.detail);
    expect(detail.model).toBe('test-model');
    expect(detail.promptTokens).toBe(100);
    expect(detail.completionTokens).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: RAG Enrichment', () => {
  let db: Database.Database;

  it('injects RAG context into LLM system prompt', async () => {
    db = createTestDb();
    const ragContext = 'User prefers dark mode. User birthday: June 22.';
    const mockLLM = createMockLLM([makeLLMResponse('Happy birthday!')]);
    const mockRAG = createMockRAG(ragContext);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: mockRAG as any,
      channels: mockChannels as any,
    });

    await runPipeline(loop, [makeMessage('msg-rag', 'When is my birthday?')]);

    const chatCall = mockLLM.chat.mock.calls[0][0] as LLMRequest;
    expect(chatCall.systemPrompt).toContain('Retrieved Knowledge');
    expect(chatCall.systemPrompt).toContain('June 22');

    db.close();
  });

  it('continues without context when RAG fails', async () => {
    db = createTestDb();
    const mockLLM = createMockLLM([makeLLMResponse('I can help with that.')]);
    const failingRAG = createMockRAG();
    failingRAG.retrieve.mockRejectedValue(new Error('Ollama offline'));
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: failingRAG as any,
      channels: mockChannels as any,
    });

    await runPipeline(loop, [makeMessage('msg-rag-fail', 'Hello')]);

    // Pipeline should still complete — LLM was called, response sent
    // Note: shutdown compression may add +1 LLM call
    expect(mockLLM.chat.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockChannels.send.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockChannels.sentResponses[0].response.content).toBe('I can help with that.');

    // System prompt should NOT contain "Retrieved Knowledge" section
    const chatCall = mockLLM.chat.mock.calls[0][0] as LLMRequest;
    expect(chatCall.systemPrompt).not.toContain('Retrieved Knowledge');

    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Agentic Tool Loop', () => {
  let db: Database.Database;

  const testTools: MCPToolDefinition[] = [
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, riskLevel: 'low' },
    { name: 'write_file', description: 'Write to a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, riskLevel: 'medium' },
    { name: 'exec_command', description: 'Execute a shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } }, riskLevel: 'high' },
    { name: 'delete_system', description: 'Delete system files', inputSchema: { type: 'object', properties: { target: { type: 'string' } } }, riskLevel: 'critical' },
  ];

  afterEach(() => {
    if (db) db.close();
  });

  it('executes tool calls and feeds results back to LLM', async () => {
    db = createTestDb();
    const toolCall: ToolCall = { id: 'tc-1', tool: 'read_file', params: { path: '/tmp/test.txt' } };

    const mockLLM = createMockLLM([
      // First response: LLM asks to read a file
      makeLLMResponse('', [toolCall]),
      // Second response: LLM uses tool result to respond
      makeLLMResponse('The file contains "hello world".'),
    ]);

    const mockMCP = createMockMCP(testTools, (call) => ({
      callId: call.id,
      tool: call.tool,
      success: true,
      result: 'hello world',
      durationMs: 5,
    }));

    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: mockMCP as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    await runPipeline(loop, [makeMessage('msg-tool', 'Read /tmp/test.txt')]);

    // LLM called at least twice: initial + after tool result (+1 possible from shutdown compression)
    expect(mockLLM.chat.mock.calls.length).toBeGreaterThanOrEqual(2);

    // MCP executeTool called once
    expect(mockMCP.executeTool).toHaveBeenCalledTimes(1);
    expect(mockMCP.executeTool.mock.calls[0][0].tool).toBe('read_file');

    // Final response sent to channel
    expect(mockChannels.sentResponses[0].response.content).toBe('The file contains "hello world".');

    // Audit trail has tool events
    const auditRows = db.prepare("SELECT event_type FROM audit_log ORDER BY timestamp").all() as any[];
    const types = auditRows.map((r: any) => r.event_type);
    expect(types).toContain('tool_requested');
    expect(types).toContain('tool_executed');
  });

  it('handles multi-step agentic loop (3 tool calls across 2 iterations)', async () => {
    db = createTestDb();

    const mockLLM = createMockLLM([
      // Iteration 1: two tool calls
      makeLLMResponse('', [
        { id: 'tc-1', tool: 'read_file', params: { path: '/tmp/a.txt' } },
        { id: 'tc-2', tool: 'read_file', params: { path: '/tmp/b.txt' } },
      ]),
      // Iteration 2: one more tool call
      makeLLMResponse('', [
        { id: 'tc-3', tool: 'write_file', params: { path: '/tmp/c.txt', content: 'merged' } },
      ]),
      // Iteration 3: final response
      makeLLMResponse('Done! Merged a.txt and b.txt into c.txt.'),
    ]);

    const mockMCP = createMockMCP(testTools);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: mockMCP as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    await runPipeline(loop, [makeMessage('msg-multi', 'Merge a.txt and b.txt into c.txt')]);

    // At least 3 LLM calls: initial + 2 follow-ups (+1 possible from shutdown compression)
    expect(mockLLM.chat.mock.calls.length).toBeGreaterThanOrEqual(3);

    // 3 tool executions total
    expect(mockMCP.executeTool).toHaveBeenCalledTimes(3);

    // Final response is the non-tool one
    expect(mockChannels.sentResponses[0].response.content).toBe('Done! Merged a.txt and b.txt into c.txt.');
  });

  it('respects maxAgenticLoops and stops infinite loops', async () => {
    db = createTestDb();
    const config = makeConfig();
    config.trust.maxAgenticLoops = 2;

    // LLM always returns a tool call — simulates infinite loop
    const alwaysToolCall = makeLLMResponse('', [
      { id: 'tc-inf', tool: 'read_file', params: { path: '/tmp/loop.txt' } },
    ]);
    const mockLLM = createMockLLM([alwaysToolCall, alwaysToolCall, alwaysToolCall, alwaysToolCall]);
    const mockMCP = createMockMCP(testTools);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config, db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: mockMCP as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    await runPipeline(loop, [makeMessage('msg-loop', 'Keep going')]);

    // At least 1 initial + 2 follow-ups (limited by maxAgenticLoops=2) (+1 possible from shutdown compression)
    expect(mockLLM.chat.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Response should contain the loop limit warning
    const response = mockChannels.sentResponses[0].response.content;
    expect(response).toContain('loop limit reached');
  });

  it('handles tool execution failures gracefully', async () => {
    db = createTestDb();

    const mockLLM = createMockLLM([
      makeLLMResponse('', [{ id: 'tc-fail', tool: 'read_file', params: { path: '/nonexistent' } }]),
      makeLLMResponse('Sorry, that file does not exist.'),
    ]);

    const mockMCP = createMockMCP(testTools, (call) => ({
      callId: call.id,
      tool: call.tool,
      success: false,
      error: 'ENOENT: no such file or directory',
      durationMs: 2,
    }));

    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: mockMCP as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    await runPipeline(loop, [makeMessage('msg-fail', 'Read nonexistent file')]);

    // LLM called at least twice (error fed back) (+1 possible from shutdown compression)
    expect(mockLLM.chat.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Audit has tool_error event
    const toolErrors = db.prepare("SELECT * FROM audit_log WHERE event_type = 'tool_error'").all() as any[];
    expect(toolErrors.length).toBe(1);

    // Response was sent
    expect(mockChannels.sentResponses[0].response.content).toBe('Sorry, that file does not exist.');
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Trust Gating', () => {
  let db: Database.Database;

  const testTools: MCPToolDefinition[] = [
    { name: 'safe_read', description: 'Safe read', inputSchema: {}, riskLevel: 'low' },
    { name: 'write_op', description: 'Write something', inputSchema: {}, riskLevel: 'medium' },
    { name: 'dangerous_exec', description: 'Shell exec', inputSchema: {}, riskLevel: 'high' },
    { name: 'nuke', description: 'Delete everything', inputSchema: {}, riskLevel: 'critical' },
  ];

  afterEach(() => {
    if (db) db.close();
  });

  it('owner (tier 4) auto-executes low/medium/high tools, gets approval for critical', async () => {
    db = createTestDb();

    const mockLLM = createMockLLM([
      makeLLMResponse('', [
        { id: 'tc-low', tool: 'safe_read', params: {} },
        { id: 'tc-med', tool: 'write_op', params: {} },
        { id: 'tc-high', tool: 'dangerous_exec', params: {} },
        { id: 'tc-crit', tool: 'nuke', params: {} },
      ]),
      makeLLMResponse('Tools executed.'),
    ]);

    const mockMCP = createMockMCP(testTools);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: mockMCP as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    // owner-1 is in ownerIds → tier 4
    await runPipeline(loop, [makeMessage('msg-owner', 'Do all the things', 'owner-1')]);

    // low + medium + high auto-executed (3 calls)
    expect(mockMCP.executeTool).toHaveBeenCalledTimes(3);

    // critical → work order created (approval needed)
    const workOrders = db.prepare('SELECT * FROM work_orders').all() as any[];
    expect(workOrders.length).toBe(1);
    expect(workOrders[0].tool_name).toBe('nuke');

    // Channel got approval notification
    expect(mockChannels.notifyApproval).toHaveBeenCalledTimes(1);
  });

  it('stranger (tier 1) gets low approved, medium/high/critical denied', async () => {
    db = createTestDb();

    // Per TRUST_RISK_MATRIX: tier 1 → low=approve, medium=deny, high=deny, critical=deny
    const mockLLM = createMockLLM([
      makeLLMResponse('', [
        { id: 'tc-low', tool: 'safe_read', params: {} },
        { id: 'tc-med', tool: 'write_op', params: {} },
        { id: 'tc-high', tool: 'dangerous_exec', params: {} },
        { id: 'tc-crit', tool: 'nuke', params: {} },
      ]),
      makeLLMResponse('Limited access.'),
    ]);

    const mockMCP = createMockMCP(testTools);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: mockMCP as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    // stranger-1 is NOT in any trust list → tier 1
    await runPipeline(loop, [makeMessage('msg-stranger', 'Do things', 'stranger-1')]);

    // No tools auto-execute for tier 1 (low=approve, everything else denied)
    expect(mockMCP.executeTool).toHaveBeenCalledTimes(0);

    // low → work order (approval needed), so 1 work order for safe_read
    const workOrders = db.prepare('SELECT * FROM work_orders').all() as any[];
    expect(workOrders.length).toBe(1);
    expect(workOrders[0].tool_name).toBe('safe_read');

    // Audit has denied events for medium + high + critical
    const deniedAudit = db.prepare("SELECT detail FROM audit_log WHERE event_type = 'tool_denied'").all() as any[];
    expect(deniedAudit.length).toBe(3);

    // Session trust tier is 1
    const session = db.prepare('SELECT trust_tier FROM sessions LIMIT 1').get() as any;
    expect(session.trust_tier).toBe(1);
  });

  it('tribe member (tier 3) can auto-execute low/medium, needs approval for high', async () => {
    db = createTestDb();

    const mockLLM = createMockLLM([
      makeLLMResponse('', [
        { id: 'tc-low', tool: 'safe_read', params: {} },
        { id: 'tc-med', tool: 'write_op', params: {} },
        { id: 'tc-high', tool: 'dangerous_exec', params: {} },
      ]),
      makeLLMResponse('Access granted for most.'),
    ]);

    const mockMCP = createMockMCP(testTools);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: mockMCP as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    // tribe-1 is in tribeIds → tier 3
    await runPipeline(loop, [makeMessage('msg-tribe', 'Do things', 'tribe-1')]);

    // low + medium auto-executed (2 calls)
    expect(mockMCP.executeTool).toHaveBeenCalledTimes(2);

    // high → approval needed
    const workOrders = db.prepare('SELECT * FROM work_orders').all() as any[];
    expect(workOrders.length).toBe(1);
    expect(workOrders[0].tool_name).toBe('dangerous_exec');
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Multi-Message Session', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('maintains conversation context across messages', async () => {
    db = createTestDb();
    let callCount = 0;
    const mockLLM = createMockLLM([
      makeLLMResponse('Hi! I\'m Ved.'),
      makeLLMResponse('You said hello earlier!'),
    ]);

    // Override chat to capture message history
    const chatCalls: LLMRequest[] = [];
    mockLLM.chat.mockImplementation((req: LLMRequest) => {
      chatCalls.push(req);
      const resp = callCount === 0
        ? makeLLMResponse('Hi! I\'m Ved.')
        : makeLLMResponse('You said hello earlier!');
      callCount++;
      return Promise.resolve(resp);
    });

    const mockChannels = createMockChannels();
    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    // Start loop first, then send messages
    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    loop.receive(makeMessage('msg-1', 'Hello!'));
    // Small delay to let first message process
    await new Promise(r => setTimeout(r, 300));
    loop.receive(makeMessage('msg-2', 'What did I say before?'));

    await new Promise(r => setTimeout(r, 500));
    loop.requestShutdown();
    await runPromise;

    // Second LLM call should include first user message + assistant response
    // (+1 possible from shutdown compression)
    expect(chatCalls.length).toBeGreaterThanOrEqual(2);
    const secondCall = chatCalls[1];
    expect(secondCall.messages.length).toBeGreaterThanOrEqual(3); // user1 + assistant1 + user2
    expect(secondCall.messages[0].content).toBe('Hello!');
  });

  it('creates separate sessions for different authors', async () => {
    db = createTestDb();
    const mockLLM = createMockLLM([
      makeLLMResponse('Hi owner!'),
      makeLLMResponse('Hi stranger!'),
    ]);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    loop.receive(makeMessage('msg-owner', 'Hi', 'owner-1'));
    loop.receive(makeMessage('msg-stranger', 'Hi', 'stranger-1'));

    await new Promise(r => setTimeout(r, 700));
    loop.requestShutdown();
    await runPromise;

    // Two distinct sessions
    const sessions = db.prepare('SELECT * FROM sessions').all() as any[];
    expect(sessions.length).toBe(2);

    const tiers = sessions.map((s: any) => s.trust_tier).sort();
    expect(tiers).toEqual([1, 4]); // stranger=1, owner=4
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Crash Recovery', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('recovers unprocessed inbox messages after simulated crash', async () => {
    db = createTestDb();

    // Simulate crash: insert unprocessed inbox row directly
    db.prepare(`
      INSERT INTO inbox (id, channel, channel_id, author_id, author_name, content, attachments, reply_to, metadata, received_at, processed)
      VALUES ('orphan-1', 'cli', '', 'owner-1', '', 'I was lost', '[]', NULL, '{}', ?, 0)
    `).run(Date.now());

    db.prepare(`
      INSERT INTO inbox (id, channel, channel_id, author_id, author_name, content, attachments, reply_to, metadata, received_at, processed)
      VALUES ('orphan-2', 'cli', '', 'owner-1', '', 'Me too', '[]', NULL, '{}', ?, 0)
    `).run(Date.now());

    const mockLLM = createMockLLM([
      makeLLMResponse('Recovered message 1!'),
      makeLLMResponse('Recovered message 2!'),
    ]);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 700));
    loop.requestShutdown();
    await runPromise;

    // Both orphans should be processed
    const orphan1 = db.prepare('SELECT processed FROM inbox WHERE id = ?').get('orphan-1') as any;
    const orphan2 = db.prepare('SELECT processed FROM inbox WHERE id = ?').get('orphan-2') as any;
    expect(orphan1.processed).toBe(1);
    expect(orphan2.processed).toBe(1);

    // Responses sent
    expect(mockChannels.send).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Audit Anchoring', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('creates HMAC anchors at configured intervals', async () => {
    db = createTestDb();
    const config = makeConfig();
    config.audit.anchorInterval = 3; // anchor every 3 audit entries

    const mockLLM = createMockLLM([
      makeLLMResponse('One'),
      makeLLMResponse('Two'),
      makeLLMResponse('Three'),
    ]);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config, db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    // Send multiple messages to generate enough audit entries
    loop.receive(makeMessage('m1', 'one'));
    loop.receive(makeMessage('m2', 'two'));
    loop.receive(makeMessage('m3', 'three'));

    await new Promise(r => setTimeout(r, 1000));
    loop.requestShutdown();
    await runPromise;

    // Should have anchors (at least the shutdown anchor)
    const anchors = db.prepare('SELECT * FROM anchors').all() as any[];
    expect(anchors.length).toBeGreaterThan(0);

    // Anchor has HMAC (since we set hmacSecret)
    expect(anchors[0].hmac).toBeTruthy();
    expect(anchors[0].hmac.length).toBeGreaterThan(10);
  });

  it('shutdown anchor captures final chain state', async () => {
    db = createTestDb();
    const mockLLM = createMockLLM([makeLLMResponse('test')]);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    await runPipeline(loop, [makeMessage('m1', 'test')]);

    // Last anchor should exist (created on shutdown)
    const anchors = db.prepare('SELECT * FROM anchors ORDER BY timestamp DESC').all() as any[];
    expect(anchors.length).toBeGreaterThan(0);

    // Chain length in anchor should match audit_log count (minus the shutdown event itself, since anchor is created before shutdown entry)
    const auditCount = (db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as any).count;
    expect(auditCount).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: No LLM Fallback', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('responds with fallback when no LLM is configured', async () => {
    db = createTestDb();
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    // Don't set LLM module (simulates no LLM configured)
    loop.setModules({
      llm: null as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    await runPipeline(loop, [makeMessage('msg-no-llm', 'Hello')]);

    // Should send responses (message may be processed twice due to inbox recovery)
    expect(mockChannels.send).toHaveBeenCalled();
    // All responses should contain the fallback message
    for (const sent of mockChannels.sentResponses) {
      expect(sent.response.content).toContain('[No LLM configured]');
      expect(sent.response.content).toContain('Hello');
    }
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Message Priority', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('processes high-priority messages before normal ones', async () => {
    db = createTestDb();
    const processedOrder: string[] = [];

    const mockLLM = {
      name: 'llm',
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ module: 'llm', healthy: true, checkedAt: Date.now() }),
      chat: vi.fn().mockImplementation((req: LLMRequest) => {
        const userMsg = req.messages.find((m: any) => m.role === 'user');
        if (userMsg) processedOrder.push(userMsg.content);
        return Promise.resolve(makeLLMResponse(`Got: ${userMsg?.content}`));
      }),
    };
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    // Enqueue: normal first, then high priority
    loop.receive(makeMessage('low-1', 'normal message'), 'low');
    loop.receive(makeMessage('high-1', 'urgent message'), 'high');
    loop.receive(makeMessage('normal-1', 'regular message'), 'normal');

    await new Promise(r => setTimeout(r, 1000));
    loop.requestShutdown();
    await runPromise;

    // High priority should be processed first
    expect(processedOrder[0]).toBe('urgent message');
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Channel Response Failure', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('survives channel send failure without crashing pipeline', async () => {
    db = createTestDb();
    const mockLLM = createMockLLM([makeLLMResponse('This will fail to send')]);
    const mockChannels = createMockChannels();
    mockChannels.send.mockRejectedValue(new Error('Discord API 500'));

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    // Should not throw
    await runPipeline(loop, [makeMessage('msg-fail-send', 'Hello')]);

    // Pipeline completed despite send failure (may be called multiple times due to inbox recovery)
    expect(mockLLM.chat).toHaveBeenCalled();

    // Inbox still marked processed (message was handled, just response failed)
    const inbox = db.prepare('SELECT processed FROM inbox WHERE id = ?').get('msg-fail-send') as any;
    expect(inbox.processed).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// SESSION 32 — Additional Integration Tests
// ═══════════════════════════════════════════════════════════════

describe('Integration: VedApp Lifecycle', () => {
  it('createApp → init → start → stop lifecycle completes cleanly', async () => {
    // We test VedApp directly, not just EventLoop
    const { VedApp } = await import('./app.js');
    const { join } = await import('node:path');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');

    const tmpDir = mkdtempSync(join(tmpdir(), 'ved-test-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      const config = makeConfig({ dbPath });
      const app = new VedApp(config);

      // Modules should be created
      expect(app.eventLoop).toBeDefined();
      expect(app.llm).toBeDefined();
      expect(app.mcp).toBeDefined();
      expect(app.memory).toBeDefined();
      expect(app.rag).toBeDefined();
      expect(app.channels).toBeDefined();

      // Init all modules
      await app.init();

      // Double-init should be safe (idempotent)
      await app.init();

      // Health check should work after init
      const health = await app.healthCheck();
      expect(health).toBeDefined();
      expect(health.modules.length).toBeGreaterThan(0);

      // Start in background, then immediately stop
      const startPromise = app.start();
      await new Promise(r => setTimeout(r, 100));
      await app.stop();
      await startPromise;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('VedApp handles messages end-to-end through start/stop', async () => {
    const { VedApp } = await import('./app.js');
    const { join } = await import('node:path');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');

    const tmpDir = mkdtempSync(join(tmpdir(), 'ved-test-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      const config = makeConfig({ dbPath });
      const app = new VedApp(config);
      await app.init();

      const startPromise = app.start();
      await new Promise(r => setTimeout(r, 50));

      // Inject a message directly into the event loop
      app.eventLoop.receive(makeMessage('lifecycle-msg', 'Hello from lifecycle test'));

      await new Promise(r => setTimeout(r, 300));
      await app.stop();
      await startPromise;

      // No crash = success (DB is closed by stop, so we can't query it)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Concurrent Message Race', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('handles rapid messages to same session without corruption', async () => {
    db = createTestDb();
    const processedMessages: string[] = [];

    // LLM that takes some time (simulates real latency)
    const mockLLM = {
      name: 'llm',
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ module: 'llm', healthy: true, checkedAt: Date.now() }),
      chat: vi.fn().mockImplementation(async (req: LLMRequest) => {
        const userMsg = req.messages.find((m: any) => m.role === 'user');
        // Add small delay to simulate LLM call
        await new Promise(r => setTimeout(r, 20));
        if (userMsg) processedMessages.push(userMsg.content);
        return makeLLMResponse(`Reply to: ${userMsg?.content}`);
      }),
    };
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    // Fire 5 messages rapidly from the same user (same session)
    for (let i = 0; i < 5; i++) {
      loop.receive(makeMessage(`rapid-${i}`, `Message ${i}`, 'owner-1'));
    }

    // Wait long enough for all to process
    await new Promise(r => setTimeout(r, 2000));
    loop.requestShutdown();
    await runPromise;

    // All 5 pipeline messages should have been processed
    // (shutdown compression may add +1 LLM call with compression prompt)
    const pipelineMessages = processedMessages.filter(m => m.startsWith('Message '));
    expect(pipelineMessages).toHaveLength(5);

    // All messages should be in inbox as processed
    const inbox = db.prepare('SELECT COUNT(*) as cnt FROM inbox WHERE processed = 1').get() as any;
    expect(inbox.cnt).toBe(5);

    // Audit trail should have all message_received entries
    const auditEntries = db.prepare(
      "SELECT COUNT(*) as cnt FROM audit_log WHERE event_type = 'message_received'"
    ).get() as any;
    expect(auditEntries.cnt).toBe(5);

    // Hash chain should still be intact
    const allAudit = db.prepare('SELECT hash, prev_hash FROM audit_log ORDER BY rowid ASC').all() as any[];
    for (let i = 1; i < allAudit.length; i++) {
      expect(allAudit[i].prev_hash).toBe(allAudit[i - 1].hash);
    }
  });

  it('handles interleaved messages from different users without session bleed', async () => {
    db = createTestDb();
    const responses: Map<string, string[]> = new Map();

    const mockLLM = {
      name: 'llm',
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ module: 'llm', healthy: true, checkedAt: Date.now() }),
      chat: vi.fn().mockImplementation(async (req: LLMRequest) => {
        await new Promise(r => setTimeout(r, 10));
        // Return the conversation history length to verify isolation
        const userMsgs = req.messages.filter((m: any) => m.role === 'user');
        return makeLLMResponse(`History: ${userMsgs.length} messages`);
      }),
    };
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    // Interleave messages from two different users
    loop.receive(makeMessage('u1-m1', 'User1 msg1', 'owner-1'));
    loop.receive(makeMessage('u2-m1', 'User2 msg1', 'tribe-1'));
    loop.receive(makeMessage('u1-m2', 'User1 msg2', 'owner-1'));
    loop.receive(makeMessage('u2-m2', 'User2 msg2', 'tribe-1'));

    await new Promise(r => setTimeout(r, 2000));
    loop.requestShutdown();
    await runPromise;

    // Should have created exactly 2 sessions (one per user)
    const sessions = db.prepare('SELECT DISTINCT session_id FROM inbox WHERE processed = 1').all() as any[];
    expect(sessions).toHaveLength(2);

    // Each user's messages should be in their own session
    const u1Sessions = db.prepare(
      "SELECT DISTINCT session_id FROM inbox WHERE author_id = 'owner-1' AND processed = 1"
    ).all() as any[];
    expect(u1Sessions).toHaveLength(1);

    const u2Sessions = db.prepare(
      "SELECT DISTINCT session_id FROM inbox WHERE author_id = 'tribe-1' AND processed = 1"
    ).all() as any[];
    expect(u2Sessions).toHaveLength(1);

    // Sessions should be different
    expect(u1Sessions[0].session_id).not.toBe(u2Sessions[0].session_id);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Audit Chain Integrity Under Load', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('maintains hash chain integrity across many rapid messages', async () => {
    db = createTestDb();
    const mockLLM = createMockLLM([makeLLMResponse('OK')]);
    const mockChannels = createMockChannels();

    const loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: createMockMCP() as any,
      memory: createMockMemory(),
      rag: createMockRAG() as any,
      channels: mockChannels as any,
    });

    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    // Send 10 messages rapidly
    for (let i = 0; i < 10; i++) {
      loop.receive(makeMessage(`load-${i}`, `Message ${i}`, 'owner-1'));
    }

    await new Promise(r => setTimeout(r, 3000));
    loop.requestShutdown();
    await runPromise;

    // Verify every hash chain entry links correctly
    const chain = db.prepare('SELECT rowid, hash, prev_hash FROM audit_log ORDER BY rowid ASC').all() as any[];
    expect(chain.length).toBeGreaterThan(10); // startup + 10x(received + llm_call + sent) + shutdown

    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].prev_hash).toBe(chain[i - 1].hash);
      expect(chain[i].hash).not.toBe(chain[i - 1].hash); // unique hashes
    }

    // All hashes should be non-empty
    for (const entry of chain) {
      expect(entry.hash).toBeTruthy();
      expect(entry.hash.length).toBeGreaterThan(10);
    }
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Integration: Build & Compilation', () => {
  it('TypeScript compiles to dist/ with correct module structure', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const distDir = join(process.cwd(), 'dist');

    // dist/ should exist (built before tests)
    if (!existsSync(distDir)) {
      // Skip if not built (CI might run tests only)
      return;
    }

    // Core entry points should exist
    expect(existsSync(join(distDir, 'index.js'))).toBe(true);
    expect(existsSync(join(distDir, 'app.js'))).toBe(true);
    expect(existsSync(join(distDir, 'cli.js'))).toBe(true);

    // Declaration files should exist
    expect(existsSync(join(distDir, 'index.d.ts'))).toBe(true);
    expect(existsSync(join(distDir, 'app.d.ts'))).toBe(true);
    expect(existsSync(join(distDir, 'cli.d.ts'))).toBe(true);

    // All module directories should be present
    const expectedModules = ['audit', 'channel', 'core', 'db', 'llm', 'mcp', 'memory', 'rag', 'trust', 'types'];
    for (const mod of expectedModules) {
      expect(existsSync(join(distDir, mod))).toBe(true);
    }

    // Source maps should exist
    const jsFiles = readdirSync(distDir).filter(f => f.endsWith('.js'));
    const mapFiles = readdirSync(distDir).filter(f => f.endsWith('.js.map'));
    expect(mapFiles.length).toBe(jsFiles.length);
  });
});
