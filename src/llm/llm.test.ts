/**
 * LLM module tests — adapters, client, request/response formatting.
 *
 * Tests use mock responses (no real API calls) to validate:
 * - Anthropic adapter: request formatting, response parsing, tool use
 * - OpenAI adapter: request formatting, response parsing, tool calls
 * - Ollama adapter: request formatting, response parsing
 * - LLMClient: initialization, chat flow, usage tracking, error handling
 * - Compress and extract helper methods
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { OllamaAdapter } from './ollama.js';
import { LLMClient } from './client.js';
import type { LLMRequest, ProviderConfig } from './types.js';
import type { VedConfig, LLMConfig } from '../types/index.js';
import { VedError } from '../types/errors.js';

// ── Helpers ──

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: 'You are Ved, a helpful AI assistant.',
    messages: [
      { role: 'user', content: 'Hello!', timestamp: Date.now() },
    ],
    ...overrides,
  };
}

function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    apiKey: 'test-key',
    baseUrl: null,
    model: 'test-model',
    maxTokens: 4096,
    temperature: 0.7,
    ...overrides,
  };
}

function makeVedConfig(llmOverrides: Partial<LLMConfig> = {}): VedConfig {
  return {
    name: 'Ved',
    version: '0.1.0',
    dbPath: ':memory:',
    logLevel: 'error',
    logFormat: 'json',
    logFile: null,
    llm: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test-key',
      baseUrl: null,
      maxTokensPerMessage: 4096,
      maxTokensPerSession: 100000,
      temperature: 0.7,
      systemPromptPath: null,
      ...llmOverrides,
    },
    memory: {
      vaultPath: '/tmp/test-vault',
      workingMemoryMaxTokens: 8000,
      ragContextMaxTokens: 4000,
      compressionThreshold: 6000,
      sessionIdleMinutes: 30,
      gitEnabled: false,
      gitAutoCommitIntervalMinutes: 5,
    },
    trust: {
      ownerIds: ['owner1'],
      tribeIds: [],
      knownIds: [],
      defaultTier: 1,
      approvalTimeoutMs: 300000,
      maxToolCallsPerMessage: 10,
      maxAgenticLoops: 10,
    },
    audit: { anchorInterval: 100, hmacSecret: null },
    rag: {
      vectorTopK: 10, ftsTopK: 10, graphMaxDepth: 2, graphMaxNodes: 20,
      maxContextTokens: 4000, rrfK: 60,
      embedding: { model: 'nomic-embed-text', baseUrl: 'http://localhost:11434', batchSize: 32, dimensions: 768 },
      chunking: { maxTokens: 1024, minTokens: 64, frontmatterPrefix: true },
    },
    channels: [{ type: 'cli', enabled: true, config: {} }],
    mcp: { servers: [] },
  };
}

// ── Anthropic Adapter ──

describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter();

  it('formats basic request with system prompt separate', () => {
    const req = makeRequest();
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    expect(formatted['system']).toBe('You are Ved, a helpful AI assistant.');
    const messages = formatted['messages'] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]['role']).toBe('user');
    expect(messages[0]['content']).toBe('Hello!');
  });

  it('converts tools to Anthropic format', () => {
    const req = makeRequest({
      tools: [{
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        riskLevel: 'low',
      }],
    });
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    const tools = formatted['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]['name']).toBe('web_search');
    expect(tools[0]['input_schema']).toBeDefined();
  });

  it('skips system messages in message array', () => {
    const req = makeRequest({
      messages: [
        { role: 'system', content: 'System context', timestamp: Date.now() },
        { role: 'user', content: 'Hi', timestamp: Date.now() },
      ],
    });
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    const messages = formatted['messages'] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]['role']).toBe('user');
  });

  it('converts tool results to Anthropic tool_result blocks', () => {
    const req = makeRequest({
      messages: [
        { role: 'user', content: 'Search for X', timestamp: Date.now() },
        { role: 'tool', content: '{"results": []}', toolCallId: 'tc-1', timestamp: Date.now() },
      ],
    });
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    const messages = formatted['messages'] as Array<Record<string, unknown>>;
    // Tool result should be a content block in a user message
    expect(messages.length).toBe(2);
    expect(messages[1]['role']).toBe('user');
    const content = messages[1]['content'] as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]['type']).toBe('tool_result');
    expect(content[0]['tool_use_id']).toBe('tc-1');
  });

  it('parses text response', () => {
    const raw = {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello! How can I help?' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 8 },
    };
    const response = adapter.parseResponse(raw);
    expect(response.decision.response).toBe('Hello! How can I help?');
    expect(response.decision.toolCalls).toEqual([]);
    expect(response.usage.promptTokens).toBe(10);
    expect(response.usage.completionTokens).toBe(8);
    expect(response.finishReason).toBe('stop');
  });

  it('parses tool use response', () => {
    const raw = {
      id: 'msg_02',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search for that.' },
        { type: 'tool_use', id: 'toolu_01', name: 'web_search', input: { query: 'Ved AI' } },
      ],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 30 },
    };
    const response = adapter.parseResponse(raw);
    expect(response.decision.response).toBe('Let me search for that.');
    expect(response.decision.toolCalls).toHaveLength(1);
    expect(response.decision.toolCalls[0].id).toBe('toolu_01');
    expect(response.decision.toolCalls[0].tool).toBe('web_search');
    expect(response.decision.toolCalls[0].params).toEqual({ query: 'Ved AI' });
    expect(response.finishReason).toBe('tool_use');
  });

  it('parses max_tokens stop reason', () => {
    const raw = {
      id: 'msg_03',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Truncated...' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 4096 },
    };
    const response = adapter.parseResponse(raw);
    expect(response.finishReason).toBe('max_tokens');
  });

  it('throws on missing API key', async () => {
    const config = makeProviderConfig({ apiKey: null });
    await expect(adapter.call({}, config)).rejects.toThrow(VedError);
  });
});

// ── OpenAI Adapter ──

describe('OpenAIAdapter', () => {
  const adapter = new OpenAIAdapter('openai');

  it('formats request with system message first', () => {
    const req = makeRequest();
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    const messages = formatted['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]['role']).toBe('system');
    expect(messages[0]['content']).toBe('You are Ved, a helpful AI assistant.');
    expect(messages[1]['role']).toBe('user');
  });

  it('converts tools to OpenAI function format', () => {
    const req = makeRequest({
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        riskLevel: 'low',
      }],
    });
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    const tools = formatted['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]['type']).toBe('function');
    const fn = tools[0]['function'] as Record<string, unknown>;
    expect(fn['name']).toBe('read_file');
  });

  it('converts tool results to tool role messages', () => {
    const req = makeRequest({
      messages: [
        { role: 'user', content: 'Read file', timestamp: Date.now() },
        { role: 'tool', content: 'file contents', toolCallId: 'tc-1', timestamp: Date.now() },
      ],
    });
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    const messages = formatted['messages'] as Array<Record<string, unknown>>;
    const toolMsg = messages.find(m => m['role'] === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!['tool_call_id']).toBe('tc-1');
  });

  it('parses text response', () => {
    const raw = {
      id: 'chatcmpl-01',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hi there!' },
        finish_reason: 'stop',
      }],
      model: 'gpt-4',
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
    };
    const response = adapter.parseResponse(raw);
    expect(response.decision.response).toBe('Hi there!');
    expect(response.decision.toolCalls).toEqual([]);
    expect(response.usage.totalTokens).toBe(20);
    expect(response.finishReason).toBe('stop');
  });

  it('parses tool calls response', () => {
    const raw = {
      id: 'chatcmpl-02',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_01',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path": "/tmp/test.txt"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      model: 'gpt-4',
      usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
    };
    const response = adapter.parseResponse(raw);
    expect(response.decision.response).toBeUndefined(); // null content → undefined
    expect(response.decision.toolCalls).toHaveLength(1);
    expect(response.decision.toolCalls[0].tool).toBe('read_file');
    expect(response.decision.toolCalls[0].params).toEqual({ path: '/tmp/test.txt' });
    expect(response.finishReason).toBe('tool_use');
  });

  it('handles malformed tool call arguments gracefully', () => {
    const raw = {
      id: 'chatcmpl-03',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_02',
            type: 'function',
            function: { name: 'broken', arguments: 'not json{{{' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      model: 'gpt-4',
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
    const response = adapter.parseResponse(raw);
    expect(response.decision.toolCalls[0].params).toEqual({ _raw: 'not json{{{' });
  });

  it('throws on empty choices', () => {
    const raw = { id: 'x', choices: [], model: 'gpt-4', usage: {} };
    expect(() => adapter.parseResponse(raw)).toThrow(VedError);
  });

  it('throws on missing API key', async () => {
    const config = makeProviderConfig({ apiKey: null });
    await expect(adapter.call({}, config)).rejects.toThrow(VedError);
  });
});

// ── OpenRouter Adapter ──

describe('OpenRouterAdapter', () => {
  it('sets provider to openrouter', () => {
    const adapter = new OpenAIAdapter('openrouter');
    expect(adapter.provider).toBe('openrouter');
  });
});

// ── Ollama Adapter ──

describe('OllamaAdapter', () => {
  const adapter = new OllamaAdapter();

  it('formats request with stream=false', () => {
    const req = makeRequest();
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    expect(formatted['stream']).toBe(false);
    const messages = formatted['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]['role']).toBe('system');
    expect(messages[1]['role']).toBe('user');
  });

  it('sets options for temperature and num_predict', () => {
    const req = makeRequest({ temperature: 0.5, maxTokens: 2048 });
    const formatted = adapter.formatRequest(req) as Record<string, unknown>;
    const options = formatted['options'] as Record<string, unknown>;
    expect(options['temperature']).toBe(0.5);
    expect(options['num_predict']).toBe(2048);
  });

  it('parses text response', () => {
    const raw = {
      model: 'llama3.1',
      message: { role: 'assistant', content: 'Hello from Ollama!' },
      done: true,
      done_reason: 'stop',
      total_duration: 1500000000, // 1.5s in nanoseconds
      prompt_eval_count: 20,
      eval_count: 10,
    };
    const response = adapter.parseResponse(raw);
    expect(response.decision.response).toBe('Hello from Ollama!');
    expect(response.usage.promptTokens).toBe(20);
    expect(response.usage.completionTokens).toBe(10);
    expect(response.durationMs).toBe(1500);
    expect(response.finishReason).toBe('stop');
  });

  it('parses tool use response', () => {
    const raw = {
      model: 'qwen2.5',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: { name: 'read', arguments: { path: '/tmp/x' } },
        }],
      },
      done: true,
      prompt_eval_count: 15,
      eval_count: 8,
    };
    const response = adapter.parseResponse(raw);
    expect(response.decision.toolCalls).toHaveLength(1);
    expect(response.decision.toolCalls[0].tool).toBe('read');
    expect(response.decision.toolCalls[0].params).toEqual({ path: '/tmp/x' });
    expect(response.finishReason).toBe('tool_use');
  });

  it('handles missing usage gracefully', () => {
    const raw = {
      model: 'llama3.1',
      message: { role: 'assistant', content: 'Hi' },
      done: true,
    };
    const response = adapter.parseResponse(raw);
    expect(response.usage.promptTokens).toBe(0);
    expect(response.usage.completionTokens).toBe(0);
  });
});

// ── LLMClient ──

describe('LLMClient', () => {
  let client: LLMClient;

  beforeEach(async () => {
    client = new LLMClient();
  });

  it('initializes with anthropic provider', async () => {
    await client.init(makeVedConfig({ provider: 'anthropic' }));
    expect(client.provider).toBe('anthropic');
    expect(client.model).toBe('claude-sonnet-4-20250514');
  });

  it('initializes with openai provider', async () => {
    await client.init(makeVedConfig({ provider: 'openai', model: 'gpt-4' }));
    expect(client.provider).toBe('openai');
    expect(client.model).toBe('gpt-4');
  });

  it('initializes with openrouter provider', async () => {
    await client.init(makeVedConfig({ provider: 'openrouter', model: 'auto' }));
    expect(client.provider).toBe('openrouter');
  });

  it('initializes with ollama provider', async () => {
    await client.init(makeVedConfig({ provider: 'ollama', model: 'llama3.1' }));
    expect(client.provider).toBe('ollama');
  });

  it('throws for unknown provider', async () => {
    await expect(client.init(makeVedConfig({ provider: 'unknown' as never })))
      .rejects.toThrow(VedError);
  });

  it('healthCheck reports healthy after init', async () => {
    await client.init(makeVedConfig());
    const health = await client.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.details).toContain('anthropic');
  });

  it('healthCheck reports unhealthy before init', async () => {
    const health = await client.healthCheck();
    expect(health.healthy).toBe(false);
  });

  it('throws on chat before init', async () => {
    await expect(client.chat(makeRequest())).rejects.toThrow('not initialized');
  });

  it('tracks session usage across calls', async () => {
    await client.init(makeVedConfig());

    // Mock the adapter.call to return a fake response
    const mockCall = vi.fn().mockResolvedValue({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    // Replace the adapter's call method
    const adapter = (client as unknown as { adapter: { call: typeof mockCall } }).adapter;
    adapter.call = mockCall;

    await client.chat(makeRequest());
    expect(client.sessionUsage.promptTokens).toBe(50);
    expect(client.sessionUsage.completionTokens).toBe(20);
    expect(client.sessionUsage.totalTokens).toBe(70);

    // Second call accumulates
    await client.chat(makeRequest());
    expect(client.sessionUsage.totalTokens).toBe(140);
  });

  it('throws on budget exceeded', async () => {
    await client.init(makeVedConfig({ maxTokensPerSession: 100 }));

    // Mock call that returns usage > budget
    const mockCall = vi.fn().mockResolvedValue({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Verbose response...' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 80, output_tokens: 30 },
    });

    const adapter = (client as unknown as { adapter: { call: typeof mockCall } }).adapter;
    adapter.call = mockCall;

    // First call succeeds (brings total to 110)
    await client.chat(makeRequest());

    // Second call should throw budget exceeded
    await expect(client.chat(makeRequest())).rejects.toThrow('budget');
  });

  it('shutdown clears state', async () => {
    await client.init(makeVedConfig());
    expect(client.provider).toBe('anthropic');
    await client.shutdown();
    const health = await client.healthCheck();
    expect(health.healthy).toBe(false);
  });

  it('sessionUsage returns a copy', async () => {
    await client.init(makeVedConfig());
    const usage1 = client.sessionUsage;
    const usage2 = client.sessionUsage;
    expect(usage1).not.toBe(usage2);
    expect(usage1).toEqual(usage2);
  });
});

// ── Compress and Extract ──

describe('LLMClient.compress', () => {
  it('returns compressed text via chat', async () => {
    const client = new LLMClient();
    await client.init(makeVedConfig());

    const mockCall = vi.fn().mockResolvedValue({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Session summary: discussed X and Y.' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 15 },
    });
    const adapter = (client as unknown as { adapter: { call: typeof mockCall } }).adapter;
    adapter.call = mockCall;

    const result = await client.compress('Long conversation...', 'Summarize this.');
    expect(result).toBe('Session summary: discussed X and Y.');
  });
});

describe('LLMClient.extract', () => {
  it('parses extraction JSON from response', async () => {
    const client = new LLMClient();
    await client.init(makeVedConfig());

    const mockCall = vi.fn().mockResolvedValue({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'text',
        text: '{"facts": [{"fact": "Ved uses SQLite", "entity": "ved", "entityType": "project", "confidence": "high"}], "entities": [], "decisions": []}',
      }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const adapter = (client as unknown as { adapter: { call: typeof mockCall } }).adapter;
    adapter.call = mockCall;

    const result = await client.extract('Some conversation text', 'Extract facts.');
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].fact).toBe('Ved uses SQLite');
  });

  it('handles non-JSON response gracefully', async () => {
    const client = new LLMClient();
    await client.init(makeVedConfig());

    const mockCall = vi.fn().mockResolvedValue({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'No JSON here, just text.' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    const adapter = (client as unknown as { adapter: { call: typeof mockCall } }).adapter;
    adapter.call = mockCall;

    const result = await client.extract('Text', 'Extract.');
    expect(result.facts).toEqual([]);
    expect(result.entities).toEqual([]);
    expect(result.decisions).toEqual([]);
  });
});
