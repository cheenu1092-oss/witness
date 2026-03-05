/**
 * LLMClient — Multi-provider LLM client.
 *
 * Manages provider selection, request formatting, response parsing,
 * and usage tracking. Also provides compress() and extract() methods
 * for memory operations.
 *
 * Stateless per-call: each chat() call is independent.
 * Session-level usage tracking is maintained in-memory.
 */

import type { VedConfig, LLMConfig, VedModule, ModuleHealth, LLMUsage } from '../types/index.js';
import { VedError } from '../types/errors.js';
import type {
  LLMRequest, LLMResponse, LLMProviderAdapter, ProviderConfig,
  ExtractionResult,
} from './types.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { OllamaAdapter } from './ollama.js';

/**
 * Multi-provider LLM client implementing the VedModule lifecycle.
 */
export class LLMClient implements VedModule {
  readonly name = 'llm';

  private adapter: LLMProviderAdapter | null = null;
  private providerConfig: ProviderConfig | null = null;
  private llmConfig: LLMConfig | null = null;
  private _sessionUsage: LLMUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    model: '',
    provider: '',
  };

  get provider(): string {
    return this.adapter?.provider ?? 'none';
  }

  get model(): string {
    return this.llmConfig?.model ?? 'none';
  }

  get sessionUsage(): LLMUsage {
    return { ...this._sessionUsage };
  }

  async init(config: VedConfig): Promise<void> {
    this.llmConfig = config.llm;
    this.adapter = this.createAdapter(config.llm.provider);
    this.providerConfig = {
      apiKey: config.llm.apiKey,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      maxTokens: config.llm.maxTokensPerMessage,
      temperature: config.llm.temperature,
    };
    this._sessionUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: config.llm.model,
      provider: config.llm.provider,
    };
  }

  async shutdown(): Promise<void> {
    this.adapter = null;
    this.providerConfig = null;
  }

  async healthCheck(): Promise<ModuleHealth> {
    return {
      module: 'llm',
      healthy: this.adapter !== null,
      details: this.adapter
        ? `Provider: ${this.adapter.provider}, Model: ${this.llmConfig?.model}`
        : 'Not initialized',
      checkedAt: Date.now(),
    };
  }

  /**
   * Send a conversation to the LLM and get a structured decision.
   * Handles provider-specific formatting and response parsing.
   */
  async chat(request: LLMRequest): Promise<LLMResponse> {
    if (!this.adapter || !this.providerConfig) {
      throw new VedError('INTERNAL_ERROR', 'LLMClient not initialized — call init() first');
    }

    // Check session budget
    if (this.llmConfig && this._sessionUsage.totalTokens >= this.llmConfig.maxTokensPerSession) {
      throw new VedError('LLM_BUDGET_EXCEEDED',
        `Session token budget exhausted: ${this._sessionUsage.totalTokens}/${this.llmConfig.maxTokensPerSession}`);
    }

    const formatted = this.adapter.formatRequest(request);
    const startMs = Date.now();

    let raw: unknown;
    try {
      raw = await this.adapter.call(formatted, this.providerConfig);
    } catch (err) {
      if (err instanceof VedError) throw err;
      throw new VedError('LLM_REQUEST_FAILED',
        `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined);
    }

    const durationMs = Date.now() - startMs;

    let response: LLMResponse;
    try {
      response = this.adapter.parseResponse(raw);
    } catch (err) {
      throw new VedError('LLM_INVALID_RESPONSE',
        `Failed to parse LLM response: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined);
    }

    response.durationMs = durationMs;

    // Track session usage
    this._sessionUsage.promptTokens += response.usage.promptTokens;
    this._sessionUsage.completionTokens += response.usage.completionTokens;
    this._sessionUsage.totalTokens += response.usage.totalTokens;

    return response;
  }

  /**
   * Compress text (used for T1→T2 compression).
   * Uses a dedicated system prompt for summarization.
   */
  async compress(text: string, instructions: string): Promise<string> {
    const response = await this.chat({
      systemPrompt: instructions,
      messages: [{ role: 'user', content: text, timestamp: Date.now() }],
      maxTokens: 2048,
      temperature: 0.3, // lower temp for compression
    });

    return response.decision.response ?? text;
  }

  /**
   * Extract entities/facts from text (used for T3 extraction).
   * Returns structured extraction result.
   */
  async extract(text: string, instructions: string): Promise<ExtractionResult> {
    const response = await this.chat({
      systemPrompt: instructions + '\n\nRespond with valid JSON matching this schema: { "facts": [...], "entities": [...], "decisions": [...] }',
      messages: [{ role: 'user', content: text, timestamp: Date.now() }],
      maxTokens: 4096,
      temperature: 0.2, // low temp for extraction
    });

    const content = response.decision.response ?? '{}';

    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { facts: [], entities: [], decisions: [] };
      }
      const parsed = JSON.parse(jsonMatch[0]) as Partial<ExtractionResult>;
      return {
        facts: parsed.facts ?? [],
        entities: parsed.entities ?? [],
        decisions: parsed.decisions ?? [],
      };
    } catch {
      return { facts: [], entities: [], decisions: [] };
    }
  }

  // ── Private ──

  private createAdapter(provider: string): LLMProviderAdapter {
    switch (provider) {
      case 'anthropic':
        return new AnthropicAdapter();
      case 'openai':
        return new OpenAIAdapter('openai');
      case 'openrouter':
        return new OpenAIAdapter('openrouter');
      case 'ollama':
        return new OllamaAdapter();
      default:
        throw new VedError('CONFIG_INVALID', `Unknown LLM provider: ${provider}`);
    }
  }
}
