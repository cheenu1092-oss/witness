/**
 * Anthropic Claude provider adapter.
 *
 * Handles Anthropic's unique API format:
 * - Separate system prompt (not in messages array)
 * - Tool use format: content blocks with type='tool_use'
 * - Tool results: role='user' with content blocks type='tool_result'
 */

import type {
  LLMProviderAdapter, LLMRequest, LLMResponse, ProviderConfig,
  ConversationMessage, MCPToolDefinition, ToolResultInput,
} from './types.js';
import type { LLMUsage, ToolCall } from '../types/index.js';
import { VedError } from '../types/errors.js';

// === Anthropic API types ===

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Converts Ved messages + tool results into Anthropic's message format.
 *
 * Key differences from OpenAI:
 * - System prompt is separate (not a message)
 * - Tool results are content blocks inside user messages
 * - No 'tool' role; tool results go in 'user' messages as tool_result blocks
 */
export class AnthropicAdapter implements LLMProviderAdapter {
  readonly provider = 'anthropic';

  formatRequest(request: LLMRequest): AnthropicRequest {
    const messages = this.convertMessages(request.messages, request.toolResults);

    const formatted: AnthropicRequest = {
      model: '', // filled by caller
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      system: request.systemPrompt,
      messages,
    };

    if (request.tools && request.tools.length > 0) {
      formatted.tools = request.tools.map(this.convertTool);
    }

    return formatted;
  }

  parseResponse(raw: unknown): LLMResponse {
    const resp = raw as AnthropicResponse;
    const startTime = Date.now(); // approximate — actual timing done by caller

    const toolCalls: ToolCall[] = [];
    let responseText = '';

    for (const block of resp.content) {
      if (block.type === 'text') {
        responseText += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          tool: block.name,
          params: block.input,
        });
      }
    }

    const usage: LLMUsage = {
      promptTokens: resp.usage.input_tokens,
      completionTokens: resp.usage.output_tokens,
      totalTokens: resp.usage.input_tokens + resp.usage.output_tokens,
      model: resp.model,
      provider: 'anthropic',
    };

    const finishReason = this.mapStopReason(resp.stop_reason);

    return {
      decision: {
        response: responseText || undefined,
        toolCalls,
        memoryOps: [], // extracted by caller
        usage,
      },
      raw,
      usage,
      durationMs: 0, // set by caller
      finishReason,
    };
  }

  async call(formattedRequest: unknown, config: ProviderConfig): Promise<unknown> {
    const req = formattedRequest as AnthropicRequest;
    req.model = config.model;
    req.max_tokens = config.maxTokens;
    req.temperature = config.temperature;

    const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    const url = `${baseUrl}/v1/messages`;

    if (!config.apiKey) {
      throw new VedError('LLM_API_KEY_MISSING', 'Anthropic API key not configured');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        throw new VedError('LLM_RATE_LIMITED', `Anthropic rate limited: ${body}`);
      }
      throw new VedError('LLM_REQUEST_FAILED', `Anthropic API error ${response.status}: ${body}`);
    }

    return response.json();
  }

  // ── Private ──

  private convertMessages(
    messages: ConversationMessage[],
    toolResults?: ToolResultInput[],
  ): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue; // system prompt handled separately

      if (msg.role === 'tool' && msg.toolCallId) {
        // Anthropic requires tool results as content blocks in a user message
        const block: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
          is_error: msg.content.startsWith('Error:'),
        };

        // Merge into previous user message or create new one
        const last = result[result.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content)) {
          (last.content as AnthropicContentBlock[]).push(block);
        } else {
          result.push({ role: 'user', content: [block] });
        }
        continue;
      }

      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        result.push({ role: 'assistant', content: msg.content });
      }
    }

    // Append any pending tool results not already in messages
    if (toolResults && toolResults.length > 0) {
      const blocks: AnthropicContentBlock[] = toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.callId,
        content: tr.success ? JSON.stringify(tr.result ?? '') : `Error: ${tr.error ?? 'Unknown error'}`,
        is_error: !tr.success,
      }));

      const last = result[result.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as AnthropicContentBlock[]).push(...blocks);
      } else {
        result.push({ role: 'user', content: blocks });
      }
    }

    return result;
  }

  private convertTool(tool: MCPToolDefinition): AnthropicTool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  }

  private mapStopReason(reason: string): LLMResponse['finishReason'] {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'tool_use': return 'tool_use';
      case 'max_tokens': return 'max_tokens';
      default: return 'stop';
    }
  }
}
