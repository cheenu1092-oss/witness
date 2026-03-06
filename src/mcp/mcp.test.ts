/**
 * MCP module tests — client, transports, tool discovery, execution.
 *
 * Tests use mocks (no real MCP servers) to validate:
 * - MCPClient: init, discover, execute, shutdown lifecycle
 * - Tool namespacing and deduplication
 * - Server state management
 * - Error handling (unreachable servers, failed tools)
 * - LLM tool formatting
 * - Transport factory
 * - StdioTransport: config validation, shell metacharacter rejection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPClient } from './client.js';
import { StdioTransport, HttpTransport, createTransport } from './transport.js';
import type { VedConfig, MCPConfig, MCPServerEntry } from '../types/index.js';
import { VedError } from '../types/errors.js';

// ── Helpers ──

function makeVedConfig(mcpOverrides: Partial<MCPConfig> = {}): VedConfig {
  return {
    name: 'Ved',
    version: '0.1.0',
    dbPath: ':memory:',
    logLevel: 'error',
    logFormat: 'json',
    logFile: null,
    llm: {
      provider: 'anthropic',
      model: 'test',
      apiKey: null,
      baseUrl: null,
      maxTokensPerMessage: 4096,
      maxTokensPerSession: 100000,
      temperature: 0.7,
      systemPromptPath: null,
    },
    memory: {
      vaultPath: '/tmp/test-vault',
      workingMemoryMaxTokens: 4000,
      ragContextMaxTokens: 2000,
      compressionThreshold: 3000,
      sessionIdleMinutes: 30,
      gitEnabled: false,
      gitAutoCommitIntervalMinutes: 5,
    },
    trust: {
      ownerIds: ['owner-1'],
      tribeIds: [],
      knownIds: [],
      defaultTier: 1,
      approvalTimeoutMs: 300000,
      maxToolCallsPerMessage: 10,
      maxAgenticLoops: 5,
    },
    audit: {
      anchorInterval: 100,
      hmacSecret: null,
    },
    rag: {
      vectorTopK: 10,
      ftsTopK: 10,
      graphMaxDepth: 1,
      graphMaxNodes: 5,
      maxContextTokens: 2000,
      rrfK: 60,
      embedding: {
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434',
        batchSize: 32,
        dimensions: 768,
      },
      chunking: {
        maxTokens: 1024,
        minTokens: 64,
        frontmatterPrefix: true,
      },
    },
    channels: [],
    mcp: {
      servers: [],
      ...mcpOverrides,
    },
  };
}

function makeServerEntry(overrides: Partial<MCPServerEntry> = {}): MCPServerEntry {
  return {
    name: 'test-server',
    transport: 'stdio',
    command: 'node',
    args: ['test-server.js'],
    enabled: true,
    ...overrides,
  };
}

// ── MCPClient Tests ──

describe('MCPClient', () => {
  let client: MCPClient;

  beforeEach(() => {
    client = new MCPClient();
  });

  afterEach(async () => {
    await client.shutdown();
  });

  describe('init', () => {
    it('registers enabled servers from config', async () => {
      const config = makeVedConfig({
        servers: [
          makeServerEntry({ name: 'fs-server' }),
          makeServerEntry({ name: 'web-server' }),
        ],
      });

      await client.init(config);
      const servers = client.getServers();
      expect(servers).toHaveLength(2);
      expect(servers[0].name).toBe('fs-server');
      expect(servers[0].state).toBe('idle');
      expect(servers[1].name).toBe('web-server');
    });

    it('skips disabled servers', async () => {
      const config = makeVedConfig({
        servers: [
          makeServerEntry({ name: 'enabled', enabled: true }),
          makeServerEntry({ name: 'disabled', enabled: false }),
        ],
      });

      await client.init(config);
      expect(client.getServers()).toHaveLength(1);
      expect(client.getServers()[0].name).toBe('enabled');
    });

    it('initializes with no servers', async () => {
      await client.init(makeVedConfig());
      expect(client.tools).toHaveLength(0);
      expect(client.getServers()).toHaveLength(0);
    });
  });

  describe('healthCheck', () => {
    it('reports healthy with no servers', async () => {
      await client.init(makeVedConfig());
      const health = await client.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.module).toBe('mcp');
    });
  });

  describe('getTool', () => {
    it('returns undefined for unknown tool', async () => {
      await client.init(makeVedConfig());
      expect(client.getTool('nonexistent')).toBeUndefined();
    });
  });

  describe('executeTool', () => {
    it('returns error for unknown tool', async () => {
      await client.init(makeVedConfig());
      const result = await client.executeTool({
        id: 'call-1',
        tool: 'unknown.tool',
        params: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
      expect(result.callId).toBe('call-1');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('formatToolsForLLM', () => {
    it('returns empty array when no tools discovered', async () => {
      await client.init(makeVedConfig());
      expect(client.formatToolsForLLM()).toEqual([]);
    });
  });

  describe('shutdown', () => {
    it('clears all servers and tools', async () => {
      await client.init(makeVedConfig({
        servers: [makeServerEntry()],
      }));

      await client.shutdown();
      expect(client.tools).toHaveLength(0);
      expect(client.getServers()).toHaveLength(0);
    });
  });

  describe('serverHealth', () => {
    it('returns false for unknown server', async () => {
      await client.init(makeVedConfig());
      expect(await client.serverHealth('nonexistent')).toBe(false);
    });

    it('returns false for idle server', async () => {
      await client.init(makeVedConfig({
        servers: [makeServerEntry({ name: 'idle-server' })],
      }));
      expect(await client.serverHealth('idle-server')).toBe(false);
    });
  });
});

// ── Transport Tests ──

describe('StdioTransport', () => {
  it('rejects command with shell metacharacters', () => {
    expect(() => new StdioTransport({
      name: 'bad',
      transport: 'stdio',
      command: 'node; rm -rf /',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    })).toThrow(/shell metacharacters/);
  });

  it('rejects command with pipe', () => {
    expect(() => new StdioTransport({
      name: 'bad',
      transport: 'stdio',
      command: 'cat | grep secret',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    })).toThrow(/shell metacharacters/);
  });

  it('rejects command with backtick', () => {
    expect(() => new StdioTransport({
      name: 'bad',
      transport: 'stdio',
      command: 'echo `whoami`',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    })).toThrow(/shell metacharacters/);
  });

  it('rejects missing command', () => {
    expect(() => new StdioTransport({
      name: 'bad',
      transport: 'stdio',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    })).toThrow(/requires 'command'/);
  });

  it('accepts safe command', () => {
    const transport = new StdioTransport({
      name: 'safe',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });
    expect(transport.connected).toBe(false);
  });

  it('send throws when not connected', async () => {
    const transport = new StdioTransport({
      name: 'test',
      transport: 'stdio',
      command: 'node',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });

    await expect(transport.send('tools/list'))
      .rejects.toThrow(/Not connected/);
  });
});

describe('HttpTransport', () => {
  it('rejects missing url', () => {
    expect(() => new HttpTransport({
      name: 'bad',
      transport: 'http',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    })).toThrow(/requires 'url'/);
  });

  it('accepts valid url', () => {
    const transport = new HttpTransport({
      name: 'valid',
      transport: 'http',
      url: 'http://localhost:3100/mcp',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });
    expect(transport.connected).toBe(false);
  });

  it('send throws when not connected', async () => {
    const transport = new HttpTransport({
      name: 'test',
      transport: 'http',
      url: 'http://localhost:3100/mcp',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });

    await expect(transport.send('tools/list'))
      .rejects.toThrow(/No session URL/);
  });
});

describe('createTransport', () => {
  it('creates StdioTransport for stdio', () => {
    const t = createTransport({
      name: 'test',
      transport: 'stdio',
      command: 'node',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });
    expect(t).toBeInstanceOf(StdioTransport);
  });

  it('creates HttpTransport for http', () => {
    const t = createTransport({
      name: 'test',
      transport: 'http',
      url: 'http://localhost:3100',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    });
    expect(t).toBeInstanceOf(HttpTransport);
  });

  it('throws for unknown transport', () => {
    expect(() => createTransport({
      name: 'test',
      transport: 'unknown' as 'stdio',
      timeout: 5000,
      riskLevel: 'low',
      enabled: true,
    })).toThrow(/Unknown MCP transport/);
  });
});
