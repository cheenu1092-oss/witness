/**
 * Ollama provider adapter.
 *
 * Uses Ollama's OpenAI-compatible /api/chat endpoint.
 * No API key required (local inference).
 * Tool use support depends on the model (llama3.1+, qwen2+, etc.).
 */

import type {
  LLMProviderAdapter, LLMRequest, LLMResponse, ProviderConfig,
  ConversationMessage, MCPToolDefinition,
} from './types.js';
import type { LLMUsage, ToolCall } from '../types/index.js';
import { VedError } from '../types/errors.js';

// === Ollama API types ===

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  stream: false;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
  tools?: OllamaTool[];
}

interface OllamaResponse {
  model: string;
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama adapter for local model inference.
 * Uses /api/chat endpoint with stream=false for simplicity.
 */
export class OllamaAdapter implements LLMProviderAdapter {
  readonly provider = 'ollama';

  formatRequest(request: LLMRequest): OllamaRequest {
    const messages: OllamaMessage[] = [];

    // System prompt
    messages.push({ role: 'system', content: request.systemPrompt });

    // Conversation messages
    for (const msg of request.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool' && msg.toolCallId) {
        messages.push({ role: 'tool', content: msg.content });
        continue;
      }

      messages.push({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      });
    }

    // Tool results
    if (request.toolResults) {
      for (const tr of request.toolResults) {
        messages.push({
          role: 'tool',
          content: tr.success ? JSON.stringify(tr.result ?? '') : `Error: ${tr.error}`,
        });
      }
    }

    const formatted: OllamaRequest = {
      model: '', // filled by caller
      messages,
      stream: false,
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens ?? 4096,
      },
    };

    if (request.tools && request.tools.length > 0) {
      formatted.tools = request.tools.map(this.convertTool);
    }

    return formatted;
  }

  parseResponse(raw: unknown): LLMResponse {
    const resp = raw as OllamaResponse;

    const toolCalls: ToolCall[] = [];
    if (resp.message.tool_calls) {
      for (let i = 0; i < resp.message.tool_calls.length; i++) {
        const tc = resp.message.tool_calls[i];
        toolCalls.push({
          id: `ollama-tc-${i}`,
          tool: tc.function.name,
          params: tc.function.arguments,
        });
      }
    }

    // Ollama reports tokens differently
    const promptTokens = resp.prompt_eval_count ?? 0;
    const completionTokens = resp.eval_count ?? 0;

    const usage: LLMUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: resp.model,
      provider: 'ollama',
    };

    const finishReason = toolCalls.length > 0 ? 'tool_use' as const :
      resp.done_reason === 'length' ? 'max_tokens' as const : 'stop' as const;

    return {
      decision: {
        response: resp.message.content || undefined,
        toolCalls,
        memoryOps: [],
        usage,
      },
      raw,
      usage,
      durationMs: resp.total_duration ? Math.round(resp.total_duration / 1_000_000) : 0,
      finishReason,
    };
  }

  async call(formattedRequest: unknown, config: ProviderConfig): Promise<unknown> {
    const req = formattedRequest as OllamaRequest;
    req.model = config.model;
    if (config.maxTokens && req.options) {
      req.options.num_predict = config.maxTokens;
    }
    if (config.temperature !== undefined && req.options) {
      req.options.temperature = config.temperature;
    }

    const baseUrl = config.baseUrl ?? 'http://localhost:11434';
    const url = `${baseUrl}/api/chat`;

    // Ollama doesn't require API key — it's local
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new VedError('LLM_REQUEST_FAILED', `Ollama error ${response.status}: ${body}`);
    }

    return response.json();
  }

  // ── Private ──

  private convertTool(tool: MCPToolDefinition): OllamaTool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }
}
