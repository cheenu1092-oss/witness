/**
 * MCPClient — MCP tool discovery and execution.
 *
 * Manages server lifecycle (lazy connect, reconnect), tool discovery,
 * namespacing, and execution routing. Implements VedModule lifecycle.
 */

import type { VedConfig, VedModule, ModuleHealth, ToolCall, ToolResult } from '../types/index.js';
import { VedError } from '../types/errors.js';
import { createTransport } from './transport.js';
import type {
  MCPTransport, MCPServerConfig, MCPToolDefinition,
  ServerState, ServerInfo, MCPToolsListResult, MCPRawTool,
  MCPToolCallResult, MCPContent,
} from './types.js';

const MAX_RECONNECT_ATTEMPTS = 3;

interface ManagedServer {
  config: MCPServerConfig;
  transport: MCPTransport;
  state: ServerState;
  tools: MCPToolDefinition[];
  lastConnected?: number;
  lastError?: string;
  reconnectAttempts: number;
}

export class MCPClient implements VedModule {
  readonly name = 'mcp';

  private servers = new Map<string, ManagedServer>();
  private toolIndex = new Map<string, MCPToolDefinition>(); // full name → def
  private toolToServer = new Map<string, string>(); // full name → server name
  private _tools: MCPToolDefinition[] = [];

  /** All discovered tools (cached) */
  get tools(): MCPToolDefinition[] {
    return [...this._tools];
  }

  async init(config: VedConfig): Promise<void> {
    // Register servers from config but don't connect yet (lazy)
    for (const entry of config.mcp.servers) {
      if (!entry.enabled) continue;

      const serverConfig: MCPServerConfig = {
        name: entry.name,
        transport: entry.transport,
        command: entry.command,
        args: entry.args,
        url: entry.url,
        timeout: 30_000,
        riskLevel: 'medium',
        enabled: true,
      };

      const transport = createTransport(serverConfig);

      this.servers.set(entry.name, {
        config: serverConfig,
        transport,
        state: 'idle',
        tools: [],
        reconnectAttempts: 0,
      });
    }
  }

  async shutdown(): Promise<void> {
    const disconnects: Promise<void>[] = [];
    for (const server of this.servers.values()) {
      if (server.transport.connected) {
        disconnects.push(server.transport.disconnect());
      }
    }
    await Promise.allSettled(disconnects);
    this.servers.clear();
    this.toolIndex.clear();
    this.toolToServer.clear();
    this._tools = [];
  }

  async healthCheck(): Promise<ModuleHealth> {
    const total = this.servers.size;
    const ready = [...this.servers.values()].filter(s => s.state === 'ready').length;
    const toolCount = this._tools.length;

    return {
      module: 'mcp',
      healthy: total === 0 || ready > 0, // healthy if no servers or at least one ready
      details: `${ready}/${total} servers ready, ${toolCount} tools discovered`,
      checkedAt: Date.now(),
    };
  }

  /**
   * Discover all available tools from configured MCP servers.
   * Connects to each server, runs tools/list, caches results.
   * Called during EventLoop init (eager discovery).
   */
  async discoverTools(): Promise<MCPToolDefinition[]> {
    this.toolIndex.clear();
    this.toolToServer.clear();
    this._tools = [];

    const results: MCPToolDefinition[] = [];

    for (const [serverName, server] of this.servers) {
      try {
        await this.connectServer(serverName);

        const raw = await server.transport.send('tools/list', {}) as MCPToolsListResult;
        const tools = (raw?.tools ?? []).map((t: MCPRawTool) =>
          this.mapTool(t, server.config)
        );

        server.tools = tools;

        for (const tool of tools) {
          if (this.toolIndex.has(tool.name)) {
            // Duplicate: first server wins, log warning
            continue;
          }
          this.toolIndex.set(tool.name, tool);
          this.toolToServer.set(tool.name, serverName);
          results.push(tool);
        }
      } catch (err) {
        // Server failed — continue without it
        server.state = 'failed';
        server.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    this._tools = results;
    return results;
  }

  /**
   * Execute a single tool call.
   * Lazy-connects to the server if needed. Routes by namespaced tool name.
   */
  async executeTool(call: ToolCall): Promise<ToolResult> {
    const startMs = Date.now();
    const serverName = this.toolToServer.get(call.tool);

    if (!serverName) {
      return {
        callId: call.id,
        tool: call.tool,
        success: false,
        error: `Unknown tool: ${call.tool}`,
        durationMs: Date.now() - startMs,
      };
    }

    const server = this.servers.get(serverName);
    if (!server) {
      return {
        callId: call.id,
        tool: call.tool,
        success: false,
        error: `Server "${serverName}" not registered`,
        durationMs: Date.now() - startMs,
      };
    }

    // Lazy connect
    if (server.state === 'idle') {
      try {
        await this.connectServer(serverName);
      } catch (err) {
        return {
          callId: call.id,
          tool: call.tool,
          success: false,
          error: `Failed to connect to "${serverName}": ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - startMs,
        };
      }
    }

    if (server.state === 'failed') {
      return {
        callId: call.id,
        tool: call.tool,
        success: false,
        error: `Server "${serverName}" is in failed state: ${server.lastError ?? 'unknown error'}`,
        durationMs: Date.now() - startMs,
      };
    }

    // Get original tool name (strip server prefix)
    const toolDef = this.toolIndex.get(call.tool);
    const originalName = toolDef?.originalName ?? call.tool.split('.').slice(1).join('.');

    try {
      const result = await server.transport.send('tools/call', {
        name: originalName,
        arguments: call.params,
      }) as MCPToolCallResult;

      const text = this.extractContent(result);

      return {
        callId: call.id,
        tool: call.tool,
        success: !result.isError,
        result: text,
        error: result.isError ? text : undefined,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      // If transport error, try reconnect once
      if (err instanceof VedError && err.code === 'MCP_TRANSPORT_ERROR') {
        server.state = 'failed';
        server.lastError = err.message;
      }

      return {
        callId: call.id,
        tool: call.tool,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      };
    }
  }

  /** Get tool definition by namespaced name */
  getTool(name: string): MCPToolDefinition | undefined {
    return this.toolIndex.get(name);
  }

  /** Check if a specific MCP server is healthy */
  async serverHealth(serverName: string): Promise<boolean> {
    const server = this.servers.get(serverName);
    if (!server) return false;
    return server.state === 'ready' && server.transport.connected;
  }

  /** Get info about all managed servers */
  getServers(): ServerInfo[] {
    return [...this.servers.values()].map(s => ({
      name: s.config.name,
      state: s.state,
      transport: s.config.transport,
      toolCount: s.tools.length,
      lastConnected: s.lastConnected,
      lastError: s.lastError,
      reconnectAttempts: s.reconnectAttempts,
    }));
  }

  /**
   * Format tools for LLM system prompt (function definitions).
   * Returns tool definitions in the format expected by LLM providers.
   */
  formatToolsForLLM(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this._tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  // ── Private ──

  private async connectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) throw new VedError('INTERNAL_ERROR', `Unknown server: ${name}`);
    if (server.state === 'ready' && server.transport.connected) return;

    server.state = 'connecting';

    try {
      await server.transport.connect();
      server.state = 'ready';
      server.lastConnected = Date.now();
      server.reconnectAttempts = 0;
    } catch (err) {
      server.reconnectAttempts++;
      if (server.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        server.state = 'failed';
        server.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      }
      server.state = 'reconnecting';
      server.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private mapTool(raw: MCPRawTool, serverConfig: MCPServerConfig): MCPToolDefinition {
    const fullName = `${serverConfig.name}.${raw.name}`;
    const override = serverConfig.toolOverrides?.[raw.name];

    return {
      name: fullName,
      originalName: raw.name,
      serverName: serverConfig.name,
      description: raw.description ?? '',
      inputSchema: raw.inputSchema ?? { type: 'object', properties: {} },
      riskLevel: override?.riskLevel ?? serverConfig.riskLevel,
    };
  }

  private extractContent(result: MCPToolCallResult): string {
    if (!result.content || result.content.length === 0) return '';

    return result.content
      .map((c: MCPContent) => {
        if (c.type === 'text' && c.text) return c.text;
        if (c.type === 'image' && c.data) return `[image: ${c.mimeType ?? 'unknown'}]`;
        if (c.type === 'resource' && c.text) return c.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
}
