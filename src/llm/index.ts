/**
 * ved-llm — Multi-provider LLM client.
 *
 * Exports:
 * - LLMClient: main client with chat(), compress(), extract()
 * - Provider adapters: AnthropicAdapter, OpenAIAdapter, OllamaAdapter
 * - Types: LLMRequest, LLMResponse, etc.
 */

export { LLMClient } from './client.js';
export { AnthropicAdapter } from './anthropic.js';
export { OpenAIAdapter } from './openai.js';
export { OllamaAdapter } from './ollama.js';
export type {
  LLMRequest,
  LLMResponse,
  LLMProviderAdapter,
  ProviderConfig,
  ConversationMessage,
  MCPToolDefinition,
  ToolResultInput,
  ExtractionResult,
  ExtractedFact,
  ExtractedEntity,
  ExtractedDecision,
} from './types.js';
