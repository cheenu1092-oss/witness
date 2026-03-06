/**
 * OpenAI-compatible provider adapter.
 *
 * Works with:
 * - OpenAI (api.openai.com)
 * - OpenRouter (openrouter.ai/api) — via baseUrl override
 *
 * Handles the chat completions format with tool_calls in assistant messages.
 */

import type {
  LLMProviderAdapter, LLMRequest, LLMResponse, ProviderConfig,
  MCPToolDefinition,
} from './types.js';
import type { LLMUsage, ToolCall } from '../types/index.js';
import { VedError } from '../types/errors.js';

// === OpenAI API types ===

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: OpenAITool[];
}

interface OpenAIResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI-compatible adapter. Works with OpenAI and OpenRouter.
 */
export class OpenAIAdapter implements LLMProviderAdapter {
  readonly provider: string;

  constructor(provider: 'openai' | 'openrouter' = 'openai') {
    this.provider = provider;
  }

  formatRequest(request: LLMRequest): OpenAIRequest {
    const messages = this.convertMessages(request);

    const formatted: OpenAIRequest = {
      model: '', // filled by caller
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (request.tools && request.tools.length > 0) {
      formatted.tools = request.tools.map(this.convertTool);
    }

    return formatted;
  }

  parseResponse(raw: unknown): LLMResponse {
    const resp = raw as OpenAIResponse;
    const choice = resp.choices[0];

    if (!choice) {
      throw new VedError('LLM_INVALID_RESPONSE', 'No choices in OpenAI response');
    }

    const toolCalls: ToolCall[] = [];
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          params = { _raw: tc.function.arguments };
        }
        toolCalls.push({
          id: tc.id,
          tool: tc.function.name,
          params,
        });
      }
    }

    const usage: LLMUsage = {
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
      totalTokens: resp.usage?.total_tokens ?? 0,
      model: resp.model,
      provider: this.provider,
    };

    const finishReason = this.mapFinishReason(choice.finish_reason);

    return {
      decision: {
        response: choice.message.content ?? undefined,
        toolCalls,
        memoryOps: [],
        usage,
      },
      raw,
      usage,
      durationMs: 0,
      finishReason,
    };
  }

  async call(formattedRequest: unknown, config: ProviderConfig): Promise<unknown> {
    const req = formattedRequest as OpenAIRequest;
    req.model = config.model;
    if (config.maxTokens) req.max_tokens = config.maxTokens;
    if (config.temperature !== undefined) req.temperature = config.temperature;

    const baseUrl = config.baseUrl ?? this.defaultBaseUrl();
    const url = `${baseUrl}/chat/completions`;

    if (!config.apiKey) {
      throw new VedError('LLM_API_KEY_MISSING', `${this.provider} API key not configured`);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    };

    // OpenRouter requires additional headers
    if (this.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/cheenu1092-oss/ved';
      headers['X-Title'] = 'Ved';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        throw new VedError('LLM_RATE_LIMITED', `${this.provider} rate limited: ${body}`);
      }
      throw new VedError('LLM_REQUEST_FAILED', `${this.provider} API error ${response.status}: ${body}`);
    }

    return response.json();
  }

  // ── Private ──

  private defaultBaseUrl(): string {
    return this.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : 'https://api.openai.com/v1';
  }

  private convertMessages(request: LLMRequest): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    // System prompt as first message
    result.push({ role: 'system', content: request.systemPrompt });

    for (const msg of request.messages) {
      if (msg.role === 'system') continue; // already added above

      if (msg.role === 'tool' && msg.toolCallId) {
        result.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId,
        });
        continue;
      }

      result.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    // Append tool results if provided separately
    if (request.toolResults) {
      for (const tr of request.toolResults) {
        result.push({
          role: 'tool',
          content: tr.success ? JSON.stringify(tr.result ?? '') : `Error: ${tr.error ?? 'Unknown error'}`,
          tool_call_id: tr.callId,
        });
      }
    }

    return result;
  }

  private convertTool(tool: MCPToolDefinition): OpenAITool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }

  private mapFinishReason(reason: string): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_tokens';
      default: return 'stop';
    }
  }
}
