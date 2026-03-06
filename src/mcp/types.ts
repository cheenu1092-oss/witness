/**
 * MCP module types — transport, server, tool definitions.
 */

import type { RiskLevel } from '../types/index.js';

// === MCP Protocol Types ===

export interface MCPJsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface MCPJsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: MCPJsonRpcError;
}

export interface MCPJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// === Server Configuration ===

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  timeout: number; // ms, default 30000
  riskLevel: RiskLevel; // default risk for tools from this server
  toolOverrides?: Record<string, { riskLevel: RiskLevel }>;
  enabled: boolean;
}

// === Server Lifecycle ===

export type ServerState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'failed';

export interface ServerInfo {
  name: string;
  state: ServerState;
  transport: 'stdio' | 'http';
  toolCount: number;
  lastConnected?: number; // unix ms
  lastError?: string;
  reconnectAttempts: number;
}

// === Tool Definitions ===

export interface MCPToolDefinition {
  /** Namespaced: serverName.toolName */
  name: string;
  /** Original tool name from MCP server */
  originalName: string;
  /** Server this tool belongs to */
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  riskLevel: RiskLevel;
}

// === Transport Interface ===

export interface MCPTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(method: string, params?: unknown): Promise<unknown>;
  readonly connected: boolean;
}

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

// === MCP Server Response Types ===

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

export interface MCPToolsListResult {
  tools: MCPRawTool[];
}

export interface MCPRawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPToolCallResult {
  content: MCPContent[];
  isError?: boolean;
}

export interface MCPContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
