/**
 * T1→T2 Compressor — Summarizes working memory into daily notes.
 *
 * When working memory exceeds the compression threshold or a session
 * goes idle/closes, the compressor:
 *   1. Asks the LLM to summarize the conversation
 *   2. Extracts entities, facts, and decisions
 *   3. Writes the summary to T2 (daily note) via MemoryManager
 *   4. Upserts entities to T3 via MemoryManager
 *   5. Audits every operation to T4
 *   6. Clears compressed messages from T1
 *
 * The compression prompt is carefully designed to produce structured
 * output that can be parsed without fragile regex — using delimited
 * sections with predictable headers.
 */

import { createLogger } from './log.js';
import type { WorkingMemory, ConversationMessage } from './working-memory.js';
import type { LLMClient } from '../llm/client.js';
import type { MemoryManager, EntityUpsertInput } from '../memory/manager.js';
import type { AuditEntryInput, VaultEntityType, Confidence, KnowledgeSource } from '../types/index.js';

const log = createLogger('compressor');

// === Compression Result ===

export interface CompressionResult {
  /** Summary text written to daily note */
  summary: string;
  /** Number of entities created or updated in T3 */
  entityCount: number;
  /** Number of decisions extracted */
  decisionCount: number;
  /** Number of open questions/TODOs */
  todoCount: number;
  /** Number of messages compressed (removed from T1) */
  messagesCompressed: number;
  /** Path of the daily note written to */
  dailyNotePath: string;
  /** Duration of the compression in ms */
  durationMs: number;
}

// === Parsed compression output ===

interface ParsedCompression {
  summary: string[];
  facts: ParsedFact[];
  decisions: ParsedDecision[];
  todos: string[];
  entities: ParsedEntity[];
}

interface ParsedFact {
  fact: string;
  entity: string;
  type: VaultEntityType;
}

interface ParsedDecision {
  decision: string;
  context: string;
  filename: string;
}

interface ParsedEntity {
  filename: string;
  folder: string;
  action: 'create' | 'update';
}

// === Compression Prompt ===

function buildCompressionPrompt(messages: ConversationMessage[]): string {
  const conversationText = messages
    .map(m => {
      const prefix = m.name ? `[${m.role}:${m.name}]` : `[${m.role}]`;
      return `${prefix} ${m.content}`;
    })
    .join('\n');

  return `You are summarizing a conversation session for daily notes.

CONVERSATION:
${conversationText}

Instructions:
1. Write a concise summary (3-5 bullet points) of what happened.
2. Extract any NEW FACTS about people, projects, or concepts.
3. List any DECISIONS made (with reasoning).
4. Note any OPEN QUESTIONS or TODO items.
5. List all entities mentioned that should have vault files.

Output format (use these exact headers):

## Session Summary
- bullet point 1
- bullet point 2

## Facts Extracted
- fact: <fact text> | entity: <kebab-case-filename> | type: <person|project|concept|decision|topic|org|place>

## Decisions
- decision: <what was decided> | context: <why> | file: <kebab-case-filename>

## Open Questions
- question or TODO item

## Entities to Create/Update
- filename: <kebab-case> | folder: <entities/people|entities/orgs|projects|concepts|topics|decisions> | action: <create|update>

If a section has no items, write "None." under the header.`;
}

// === Parser ===

/**
 * Parse the structured LLM output into typed objects.
 * Designed to be resilient to minor format variations.
 */
function parseCompressionOutput(text: string): ParsedCompression {
  const result: ParsedCompression = {
    summary: [],
    facts: [],
    decisions: [],
    todos: [],
    entities: [],
  };

  // Split into sections by ## headers
  const sections = text.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0].trim().toLowerCase();
    const body = lines.slice(1).filter(l => l.trim().startsWith('-')).map(l => l.trim().slice(2).trim());

    if (header.includes('session summary') || header.includes('summary')) {
      result.summary = body;
    } else if (header.includes('facts extracted') || header.includes('facts')) {
      for (const line of body) {
        if (line.toLowerCase() === 'none.' || line.toLowerCase() === 'none') continue;
        const fact = parseFactLine(line);
        if (fact) result.facts.push(fact);
      }
    } else if (header.includes('decisions') || header.includes('decision')) {
      for (const line of body) {
        if (line.toLowerCase() === 'none.' || line.toLowerCase() === 'none') continue;
        const decision = parseDecisionLine(line);
        if (decision) result.decisions.push(decision);
      }
    } else if (header.includes('open questions') || header.includes('todo') || header.includes('questions')) {
      result.todos = body.filter(l => l.toLowerCase() !== 'none.' && l.toLowerCase() !== 'none');
    } else if (header.includes('entities') || header.includes('create/update')) {
      for (const line of body) {
        if (line.toLowerCase() === 'none.' || line.toLowerCase() === 'none') continue;
        const entity = parseEntityLine(line);
        if (entity) result.entities.push(entity);
      }
    }
  }

  return result;
}

function parseFactLine(line: string): ParsedFact | null {
  // Format: fact: <text> | entity: <name> | type: <type>
  const parts = line.split('|').map(p => p.trim());
  if (parts.length < 2) return null;

  const fact = extractValue(parts[0], 'fact') ?? parts[0];
  const entity = extractValue(parts[1], 'entity') ?? '';
  const typeStr = parts[2] ? (extractValue(parts[2], 'type') ?? 'concept') : 'concept';

  if (!fact || !entity) return null;

  return {
    fact,
    entity: toKebabCase(entity),
    type: normalizeEntityType(typeStr),
  };
}

function parseDecisionLine(line: string): ParsedDecision | null {
  const parts = line.split('|').map(p => p.trim());
  if (parts.length < 2) return null;

  const decision = extractValue(parts[0], 'decision') ?? parts[0];
  const context = parts[1] ? (extractValue(parts[1], 'context') ?? parts[1]) : '';
  const filename = parts[2] ? (extractValue(parts[2], 'file') ?? '') : '';

  if (!decision) return null;

  return {
    decision,
    context,
    filename: filename ? toKebabCase(filename) : toKebabCase(decision.slice(0, 50)),
  };
}

function parseEntityLine(line: string): ParsedEntity | null {
  const parts = line.split('|').map(p => p.trim());
  if (parts.length < 2) return null;

  const filename = extractValue(parts[0], 'filename') ?? '';
  const folder = extractValue(parts[1], 'folder') ?? '';
  const action = parts[2] ? (extractValue(parts[2], 'action') as 'create' | 'update' ?? 'create') : 'create';

  if (!filename || !folder) return null;

  return {
    filename: toKebabCase(filename),
    folder: folder.replace(/^\/+|\/+$/g, ''), // trim slashes
    action,
  };
}

function extractValue(text: string, key: string): string | null {
  const regex = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function toKebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// === GAP-2 Fix: Content Filtering ===

/**
 * Patterns that match sensitive data which should NOT be persisted
 * into entity files in the vault. These are stripped before upsert.
 */
const SENSITIVE_PATTERNS: { pattern: RegExp; replacement: string; label: string }[] = [
  // API keys (generic: long alphanumeric strings preceded by key-like words)
  { pattern: /(?:api[_-]?key|apikey|api[_-]?token|access[_-]?token|secret[_-]?key|auth[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.]{20,}['"]?/gi, replacement: '[REDACTED_API_KEY]', label: 'api_key' },
  // AWS-style keys
  { pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g, replacement: '[REDACTED_AWS_KEY]', label: 'aws_key' },
  // JWT tokens
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[REDACTED_JWT]', label: 'jwt' },
  // Private keys (PEM format)
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{10,}?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]', label: 'private_key' },
  // Passwords in context
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{4,}['"]?/gi, replacement: '[REDACTED_PASSWORD]', label: 'password' },
  // Connection strings (with credentials)
  { pattern: /(?:mongodb|postgresql|mysql|redis|amqp):\/\/[^@\s]+@[^\s]+/gi, replacement: '[REDACTED_CONN_STRING]', label: 'connection_string' },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9_\-/.]{20,}/g, replacement: 'Bearer [REDACTED_TOKEN]', label: 'bearer_token' },
  // Crypto wallet private keys (hex, 64 chars)
  { pattern: /(?:private[_-]?key|seed|mnemonic)\s*[:=]\s*['"]?[0-9a-fA-F]{64}['"]?/gi, replacement: '[REDACTED_WALLET_KEY]', label: 'wallet_key' },
  // GitHub tokens (ghp_, gho_, ghs_, ghr_)
  { pattern: /gh[poshr]_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]', label: 'github_token' },
  // Slack tokens
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]', label: 'slack_token' },
  // Discord tokens
  { pattern: /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, replacement: '[REDACTED_DISCORD_TOKEN]', label: 'discord_token' },
];

/**
 * Filter sensitive content from text before vault persistence.
 * Returns the sanitized text and a list of what was redacted.
 *
 * @param text Input text to filter
 * @returns Object with sanitized text and redaction details
 */
export function filterSensitiveContent(text: string): { sanitized: string; redactions: string[] } {
  // NFKC normalization: converts Unicode confusables (Cyrillic а→a, fullwidth Ａ→A,
  // zero-width joiners removed) to their canonical ASCII equivalents before regex matching.
  // This prevents bypass via Unicode lookalikes (see S43 VULN findings).
  let sanitized = text.normalize('NFKC');

  // Strip zero-width characters that survive NFKC (ZWJ, ZWNJ, ZW space, etc.)
  // Includes U+2061-U+2064 (invisible math operators) — see GAP-4 from S46 red-team
  sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/g, '');

  const redactions: string[] = [];

  for (const { pattern, replacement, label } of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    const matches = sanitized.match(pattern);
    if (matches) {
      redactions.push(`${label} (${matches.length} occurrence${matches.length > 1 ? 's' : ''})`);
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, replacement);
    }
  }

  return { sanitized, redactions };
}

function normalizeEntityType(t: string): VaultEntityType {
  const normalized = t.toLowerCase().trim();
  const validTypes: VaultEntityType[] = ['person', 'project', 'concept', 'decision', 'topic', 'org', 'place'];
  return validTypes.includes(normalized as VaultEntityType)
    ? (normalized as VaultEntityType)
    : 'concept';
}

// === Compressor ===

export type AuditCallback = (input: AuditEntryInput) => void;

export interface CompressorOptions {
  /** LLM client for generating summaries */
  llm: LLMClient;
  /** Memory manager for T2/T3 writes */
  memory: MemoryManager;
  /** Audit callback for T4 logging */
  onAudit: AuditCallback;
  /** Minimum messages to compress (skip if fewer) */
  minMessages?: number;
}

/**
 * Compressor — handles T1→T2 memory compression.
 *
 * Called by the EventLoop when:
 * - Working memory exceeds the compression threshold
 * - A session goes idle (after sessionIdleMinutes)
 * - A session is explicitly closed
 * - Ved shuts down gracefully
 */
export class Compressor {
  private llm: LLMClient;
  private memory: MemoryManager;
  private onAudit: AuditCallback;
  private minMessages: number;

  constructor(opts: CompressorOptions) {
    this.llm = opts.llm;
    this.memory = opts.memory;
    this.onAudit = opts.onAudit;
    this.minMessages = opts.minMessages ?? 2;
  }

  /**
   * Compress working memory → daily note + entity files.
   *
   * @param wm Working memory to compress
   * @param sessionId Session ID for audit trail
   * @param reason Why compression was triggered
   * @returns Compression result, or null if nothing to compress
   */
  async compress(
    wm: WorkingMemory,
    sessionId: string,
    reason: 'threshold' | 'idle' | 'close' | 'shutdown',
  ): Promise<CompressionResult | null> {
    const messages = wm.messages;

    // Skip if too few messages
    if (messages.length < this.minMessages) {
      log.debug('Skipping compression — too few messages', {
        count: messages.length,
        min: this.minMessages,
        sessionId,
      });
      return null;
    }

    const startMs = Date.now();

    log.info('Starting T1→T2 compression', {
      sessionId,
      reason,
      messageCount: messages.length,
      tokenCount: wm.tokenCount,
    });

    // Audit: compression started
    this.onAudit({
      eventType: 'memory_t2_compress' as AuditEntryInput['eventType'],
      actor: 'ved',
      sessionId,
      detail: { action: 'compression_start', reason, messageCount: messages.length },
    });

    // Step 1: Ask LLM to summarize
    const prompt = buildCompressionPrompt(messages);
    let llmOutput: string;

    try {
      const response = await this.llm.chat({
        systemPrompt: 'You are a memory compression engine. Output ONLY the requested format. No preamble.',
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      });
      llmOutput = response.decision.response ?? '';
    } catch (err) {
      log.error('LLM compression failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Fallback: write raw messages as bullet points
      llmOutput = buildFallbackSummary(messages);
    }

    // Step 2: Parse structured output
    const parsed = parseCompressionOutput(llmOutput);

    // Step 3: Write summary to T2 (daily note)
    const summaryText = parsed.summary.length > 0
      ? parsed.summary.map(s => `- ${s}`).join('\n')
      : llmOutput; // fallback to raw output if parsing failed

    const dailyPath = this.memory.writeCompression(summaryText, sessionId);

    // Append TODOs if any
    if (parsed.todos.length > 0) {
      const todoText = '\n### TODOs\n' + parsed.todos.map(t => `- [ ] ${t}`).join('\n');
      this.memory.appendToDaily(todoText);
    }

    // Step 4: Upsert entities to T3
    let entityCount = 0;

    // Facts → update existing entities (with GAP-2 content filtering)
    for (const fact of parsed.facts) {
      try {
        // GAP-2: Filter sensitive content before writing to vault
        const { sanitized: safeFact, redactions } = filterSensitiveContent(fact.fact);

        if (redactions.length > 0) {
          log.warn('Sensitive content filtered from entity fact', {
            entity: fact.entity,
            redactions,
            sessionId,
          });
          this.onAudit({
            eventType: 'memory_t3_upsert' as AuditEntryInput['eventType'],
            actor: 'ved',
            sessionId,
            detail: { action: 'sensitive_content_filtered', entity: fact.entity, redactions },
          });
        }

        const input: EntityUpsertInput = {
          filename: fact.entity,
          folder: entityTypeToFolder(fact.type),
          type: fact.type,
          name: fact.entity.replace(/-/g, ' '),
          source: 'conversation' as KnowledgeSource,
          confidence: 'medium' as Confidence,
          appendFacts: [safeFact],
        };
        this.memory.upsertEntity(input);
        entityCount++;

        this.onAudit({
          eventType: 'memory_t3_upsert' as AuditEntryInput['eventType'],
          actor: 'ved',
          sessionId,
          detail: { action: 'fact_extract', entity: fact.entity, type: fact.type, filtered: redactions.length > 0 },
        });
      } catch (err) {
        log.warn('Entity upsert failed for fact', {
          entity: fact.entity,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Decisions → create decision files (with GAP-2 content filtering)
    let decisionCount = 0;
    for (const decision of parsed.decisions) {
      try {
        const date = new Date().toISOString().split('T')[0];

        // GAP-2: Filter sensitive content from decision text
        const { sanitized: safeDecision, redactions: decRedactions } = filterSensitiveContent(decision.decision);
        const { sanitized: safeContext } = filterSensitiveContent(decision.context);

        if (decRedactions.length > 0) {
          log.warn('Sensitive content filtered from decision', {
            filename: decision.filename,
            redactions: decRedactions,
            sessionId,
          });
        }

        const input: EntityUpsertInput = {
          filename: `${date}-${decision.filename}`,
          folder: 'decisions',
          type: 'decision',
          name: safeDecision,
          source: 'conversation' as KnowledgeSource,
          confidence: 'high' as Confidence,
          body: `# ${safeDecision}\n\n**Context:** ${safeContext}\n\n**Date:** ${date}`,
        };
        this.memory.upsertEntity(input);
        decisionCount++;
        entityCount++;

        this.onAudit({
          eventType: 'memory_t3_upsert' as AuditEntryInput['eventType'],
          actor: 'ved',
          sessionId,
          detail: { action: 'decision_extract', filename: decision.filename },
        });
      } catch (err) {
        log.warn('Decision creation failed', {
          filename: decision.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Entity creation/update from explicit entity list
    for (const entity of parsed.entities) {
      try {
        // Only create — don't overwrite existing content with empty
        if (entity.action === 'create') {
          const entityType = folderToEntityType(entity.folder);
          const input: EntityUpsertInput = {
            filename: entity.filename,
            folder: entity.folder,
            type: entityType,
            name: entity.filename.replace(/-/g, ' '),
            source: 'conversation' as KnowledgeSource,
            confidence: 'low' as Confidence,
          };
          this.memory.upsertEntity(input);
          entityCount++;
        }
      } catch (err) {
        log.warn('Entity create/update failed', {
          filename: entity.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Step 5: Clear compressed messages from T1 (keep facts)
    const compressedCount = messages.length;
    wm.clear();

    // Step 6: Git commit via VaultManager (if enabled)
    this.memory.vault.git.flush(`ved: session-compress — ${parsed.summary[0] ?? 'session summary'}`);

    const durationMs = Date.now() - startMs;

    // Audit: compression complete
    this.onAudit({
      eventType: 'memory_t2_compress' as AuditEntryInput['eventType'],
      actor: 'ved',
      sessionId,
      detail: {
        action: 'compression_complete',
        reason,
        dailyPath,
        messagesCompressed: compressedCount,
        entityCount,
        decisionCount,
        todoCount: parsed.todos.length,
        durationMs,
      },
    });

    log.info('T1→T2 compression complete', {
      sessionId,
      dailyPath,
      messagesCompressed: compressedCount,
      entityCount,
      decisionCount,
      durationMs,
    });

    return {
      summary: summaryText,
      entityCount,
      decisionCount,
      todoCount: parsed.todos.length,
      messagesCompressed: compressedCount,
      dailyNotePath: dailyPath,
      durationMs,
    };
  }

  /**
   * Check if working memory needs compression.
   */
  shouldCompress(wm: WorkingMemory, threshold: number): boolean {
    return wm.tokenCount >= threshold && wm.messageCount >= this.minMessages;
  }
}

// === Helpers ===

function entityTypeToFolder(type: VaultEntityType): string {
  switch (type) {
    case 'person': return 'entities/people';
    case 'org': return 'entities/orgs';
    case 'place': return 'entities/places';
    case 'project': return 'projects';
    case 'concept': return 'concepts';
    case 'decision': return 'decisions';
    case 'topic': return 'topics';
    default: return 'concepts';
  }
}

function folderToEntityType(folder: string): VaultEntityType {
  if (folder.includes('people')) return 'person';
  if (folder.includes('orgs')) return 'org';
  if (folder.includes('places')) return 'place';
  if (folder.includes('projects')) return 'project';
  if (folder.includes('decisions')) return 'decision';
  if (folder.includes('topics')) return 'topic';
  return 'concept';
}

function buildFallbackSummary(messages: ConversationMessage[]): string {
  const lines = ['## Session Summary'];
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`- User: ${m.content.slice(0, 200)}`);
    } else if (m.role === 'assistant') {
      lines.push(`- Ved: ${m.content.slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}

// Export parser for testing
export { parseCompressionOutput, buildCompressionPrompt, type ParsedCompression };
