/**
 * WorkingMemory (T1) — In-prompt context for the current session.
 *
 * Holds recent conversation messages and active key-value facts.
 * Serializable to/from JSON for persistence in the sessions table.
 * Token counting is approximate (chars/4 heuristic — good enough for v1).
 */

import type { WorkingMemoryOp } from '../types/index.js';

// === Conversation Message ===

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;           // tool name for tool messages
  toolCallId?: string;     // links tool result to tool call
  timestamp: number;       // unix ms
}

// === Serialized shape (stored in sessions.working_memory) ===

interface SerializedWorkingMemory {
  messages: ConversationMessage[];
  facts: Record<string, string>;
}

// === Token estimation ===

/** Approximate token count: ~4 chars per token. Good enough for budgeting. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * WorkingMemory — the T1 memory tier.
 *
 * Manages the sliding window of conversation messages and active facts
 * that get injected into every LLM prompt for this session.
 */
export class WorkingMemory {
  private _messages: ConversationMessage[] = [];
  private _facts: Map<string, string> = new Map();
  private _maxTokens: number;

  /**
   * @param maxTokens Token budget for working memory (default 8000)
   */
  constructor(maxTokens = 8000) {
    this._maxTokens = maxTokens;
  }

  // === Messages ===

  /** Get all messages in order. */
  get messages(): ConversationMessage[] {
    return [...this._messages];
  }

  /** Number of messages. */
  get messageCount(): number {
    return this._messages.length;
  }

  /**
   * Add a message to conversation history.
   * If this pushes us over the token budget, oldest messages are evicted.
   */
  addMessage(msg: ConversationMessage): void {
    this._messages.push(msg);
    this.evictIfNeeded();
  }

  /**
   * Remove oldest messages until we're within the token budget.
   * Always keeps at least the most recent message.
   */
  private evictIfNeeded(): void {
    while (this._messages.length > 1 && this.tokenCount > this._maxTokens) {
      this._messages.shift();
    }
  }

  // === Facts ===

  /** Get all facts as a read-only record. */
  get facts(): Map<string, string> {
    return new Map(this._facts);
  }

  /** Get a fact by key, or undefined. */
  getFact(key: string): string | undefined {
    return this._facts.get(key);
  }

  /**
   * Set (add or update) a fact.
   * Returns the MemoryOp for audit logging.
   */
  setFact(key: string, value: string): WorkingMemoryOp {
    const action = this._facts.has(key) ? 'update' : 'add';
    this._facts.set(key, value);
    return { type: 'working_set', action, key, value };
  }

  /**
   * Delete a fact by key.
   * Returns the MemoryOp for audit logging, or null if key didn't exist.
   */
  deleteFact(key: string): WorkingMemoryOp | null {
    if (!this._facts.has(key)) return null;
    this._facts.delete(key);
    return { type: 'working_set', action: 'remove', key };
  }

  /** Check if a fact exists. */
  hasFact(key: string): boolean {
    return this._facts.has(key);
  }

  /** Number of active facts. */
  get factCount(): number {
    return this._facts.size;
  }

  // === Token budget ===

  /** Current estimated token count (messages + facts). */
  get tokenCount(): number {
    let tokens = 0;
    for (const msg of this._messages) {
      tokens += estimateTokens(msg.content);
      if (msg.name) tokens += estimateTokens(msg.name);
    }
    for (const [k, v] of this._facts) {
      tokens += estimateTokens(k) + estimateTokens(v);
    }
    return tokens;
  }

  /** Max token budget. */
  get maxTokens(): number {
    return this._maxTokens;
  }

  /** Whether we're at or over the compression threshold. */
  isOverThreshold(threshold: number): boolean {
    return this.tokenCount >= threshold;
  }

  // === Prompt assembly ===

  /**
   * Serialize working memory as a string for prompt injection.
   *
   * Format:
   * ```
   * ## Active Facts
   * - key1: value1
   * - key2: value2
   *
   * ## Recent Conversation
   * [user] Hello
   * [assistant] Hi there
   * ```
   */
  toPromptSection(): string {
    const parts: string[] = [];

    if (this._facts.size > 0) {
      parts.push('## Active Facts');
      for (const [k, v] of this._facts) {
        parts.push(`- ${k}: ${v}`);
      }
      parts.push('');
    }

    if (this._messages.length > 0) {
      parts.push('## Recent Conversation');
      for (const msg of this._messages) {
        const prefix = msg.name ? `[${msg.role}:${msg.name}]` : `[${msg.role}]`;
        parts.push(`${prefix} ${msg.content}`);
      }
    }

    return parts.join('\n');
  }

  // === Serialization ===

  /** Serialize to JSON string for SQLite persistence. */
  serialize(): string {
    const data: SerializedWorkingMemory = {
      messages: this._messages,
      facts: Object.fromEntries(this._facts),
    };
    return JSON.stringify(data);
  }

  /**
   * Restore from a serialized JSON string.
   * @param data JSON string from sessions.working_memory column
   * @param maxTokens Token budget (should match config)
   */
  static deserialize(data: string, maxTokens = 8000): WorkingMemory {
    const wm = new WorkingMemory(maxTokens);
    try {
      const parsed = JSON.parse(data) as SerializedWorkingMemory;
      if (Array.isArray(parsed.messages)) {
        wm._messages = parsed.messages;
      }
      if (parsed.facts && typeof parsed.facts === 'object') {
        for (const [k, v] of Object.entries(parsed.facts)) {
          wm._facts.set(k, String(v));
        }
      }
    } catch {
      // If parsing fails, start with empty working memory
    }
    return wm;
  }

  /** Create a fresh empty working memory. */
  static empty(maxTokens = 8000): WorkingMemory {
    return new WorkingMemory(maxTokens);
  }

  /** Clear all messages and facts. */
  clear(): void {
    this._messages = [];
    this._facts.clear();
  }
}
