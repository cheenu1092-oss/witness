/**
 * LLM module internal types.
 *
 * Extends ved-types with LLM-specific interfaces not needed by other modules.
 */

import type { ToolCall, MemoryOp, LLMUsage, RiskLevel } from '../types/index.js';

// === LLM Request/Response ===

export interface LLMRequest {
  systemPrompt: string;
  messages: ConversationMessage[];
  tools?: MCPToolDefinition[];
  toolResults?: ToolResultInput[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  decision: LLMDecision;
  raw: unknown;
  usage: LLMUsage;
  durationMs: number;
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
}

export interface LLMDecision {
  response?: string;
  toolCalls: ToolCall[];
  memoryOps: MemoryOp[];
  reasoning?: string;
  usage?: LLMUsage;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  timestamp: number;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: RiskLevel;
}

export interface ToolResultInput {
  callId: string;
  tool: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

// === Provider Adapter ===

export interface LLMProviderAdapter {
  readonly provider: string;

  /** Format a VedRequest into provider-specific API body */
  formatRequest(request: LLMRequest): unknown;

  /** Parse provider raw response into LLMResponse */
  parseResponse(raw: unknown): LLMResponse;

  /** Make the HTTP call to the provider */
  call(formattedRequest: unknown, config: ProviderConfig): Promise<unknown>;
}

export interface ProviderConfig {
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  maxTokens: number;
  temperature: number;
}

// === Extraction ===

export interface ExtractionResult {
  facts: ExtractedFact[];
  entities: ExtractedEntity[];
  decisions: ExtractedDecision[];
}

export interface ExtractedFact {
  fact: string;
  entity: string;
  entityType: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExtractedEntity {
  filename: string;
  folder: string;
  action: 'create' | 'update';
  name: string;
  type: string;
}

export interface ExtractedDecision {
  title: string;
  filename: string;
  context: string;
  reasoning: string;
}
