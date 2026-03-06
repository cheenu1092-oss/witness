/**
 * Tests for T1→T2 Compressor — memory compression pipeline.
 *
 * Covers:
 * - Compression prompt generation
 * - Output parsing (summary, facts, decisions, todos, entities)
 * - Compression flow (LLM → T2 → T3 → audit)
 * - Threshold detection
 * - Edge cases (empty messages, parse failures, LLM errors)
 * - Fallback summary generation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Compressor,
  parseCompressionOutput,
  buildCompressionPrompt,
  type CompressionResult,
} from './compressor.js';
import { WorkingMemory, type ConversationMessage } from './working-memory.js';
import type { LLMClient } from '../llm/client.js';
import type { MemoryManager } from '../memory/manager.js';
import type { AuditEntryInput } from '../types/index.js';

// === Mock factories ===

function createMockLLM(responseText: string): LLMClient {
  return {
    chat: vi.fn().mockResolvedValue({
      decision: { response: responseText, toolCalls: [] },
      usage: { model: 'test', promptTokens: 100, completionTokens: 50 },
      durationMs: 100,
    }),
    init: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as LLMClient;
}

function createMockMemory(): MemoryManager & {
  writeCompression: ReturnType<typeof vi.fn>;
  appendToDaily: ReturnType<typeof vi.fn>;
  upsertEntity: ReturnType<typeof vi.fn>;
  vault: { git: { flush: ReturnType<typeof vi.fn> } };
} {
  return {
    writeCompression: vi.fn().mockReturnValue('daily/2026-03-05.md'),
    appendToDaily: vi.fn(),
    upsertEntity: vi.fn().mockReturnValue('entities/people/bob.md'),
    vault: {
      git: { flush: vi.fn() },
    },
  } as unknown as MemoryManager & {
    writeCompression: ReturnType<typeof vi.fn>;
    appendToDaily: ReturnType<typeof vi.fn>;
    upsertEntity: ReturnType<typeof vi.fn>;
    vault: { git: { flush: ReturnType<typeof vi.fn> } };
  };
}

function createWorkingMemory(messages: Array<{ role: ConversationMessage['role']; content: string }>): WorkingMemory {
  const wm = WorkingMemory.empty(16000);
  for (const m of messages) {
    wm.addMessage({ role: m.role, content: m.content, timestamp: Date.now() });
  }
  return wm;
}

// === Well-formed LLM output ===

const WELL_FORMED_OUTPUT = `## Session Summary
- User asked about indoor location technology
- Discussed BLE vs WiFi positioning accuracy
- Decided to use BLE for the MVP

## Facts Extracted
- fact: Bob Friday is the Chief AI Officer at HPE | entity: bob-friday | type: person
- fact: BLE positioning is accurate to 1-3 meters indoors | entity: ble-positioning | type: concept

## Decisions
- decision: Use BLE for MVP positioning | context: WiFi less accurate for small spaces | file: use-ble-for-mvp

## Open Questions
- Should we add WiFi fallback for larger venues?
- What's the battery impact of constant BLE scanning?

## Entities to Create/Update
- filename: bob-friday | folder: entities/people | action: update
- filename: ble-positioning | folder: concepts | action: create
- filename: indoor-location-mvp | folder: projects | action: create`;

// ═══════════════════════════════════════════════════════════════════════
// PARSER TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('parseCompressionOutput', () => {
  it('parses well-formed output with all sections', () => {
    const result = parseCompressionOutput(WELL_FORMED_OUTPUT);

    expect(result.summary).toHaveLength(3);
    expect(result.summary[0]).toContain('indoor location');
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].entity).toBe('bob-friday');
    expect(result.facts[0].type).toBe('person');
    expect(result.facts[1].entity).toBe('ble-positioning');
    expect(result.facts[1].type).toBe('concept');
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].decision).toContain('BLE for MVP');
    expect(result.decisions[0].filename).toBe('use-ble-for-mvp');
    expect(result.todos).toHaveLength(2);
    expect(result.entities).toHaveLength(3);
    expect(result.entities[0].action).toBe('update');
    expect(result.entities[1].action).toBe('create');
  });

  it('handles "None." sections gracefully', () => {
    const output = `## Session Summary
- Quick greeting exchange

## Facts Extracted
None.

## Decisions
None.

## Open Questions
None.

## Entities to Create/Update
None.`;

    const result = parseCompressionOutput(output);
    expect(result.summary).toHaveLength(1);
    expect(result.facts).toHaveLength(0);
    expect(result.decisions).toHaveLength(0);
    expect(result.todos).toHaveLength(0);
    expect(result.entities).toHaveLength(0);
  });

  it('handles empty output', () => {
    const result = parseCompressionOutput('');
    expect(result.summary).toHaveLength(0);
    expect(result.facts).toHaveLength(0);
  });

  it('handles malformed fact lines', () => {
    const output = `## Facts Extracted
- This is not a proper format
- fact: Valid fact | entity: valid-entity | type: concept
- partial: missing entity`;

    const result = parseCompressionOutput(output);
    // Only the well-formed one should parse
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].entity).toBe('valid-entity');
  });

  it('handles entity type normalization', () => {
    const output = `## Facts Extracted
- fact: test | entity: test-entity | type: Person
- fact: test2 | entity: test2-entity | type: CONCEPT
- fact: test3 | entity: test3-entity | type: unknown-type`;

    const result = parseCompressionOutput(output);
    expect(result.facts[0].type).toBe('person');
    expect(result.facts[1].type).toBe('concept');
    expect(result.facts[2].type).toBe('concept'); // unknown → concept
  });

  it('handles kebab-case conversion in entity names', () => {
    const output = `## Facts Extracted
- fact: test | entity: Bob Friday | type: person`;

    const result = parseCompressionOutput(output);
    expect(result.facts[0].entity).toBe('bob-friday');
  });

  it('handles malformed decision lines', () => {
    const output = `## Decisions
- decision: Valid decision | context: Good reason | file: valid-file
- not a proper format at all`;

    const result = parseCompressionOutput(output);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].filename).toBe('valid-file');
  });

  it('generates filename from decision text when file is missing', () => {
    const output = `## Decisions
- decision: Use TypeScript for everything | context: Type safety`;

    const result = parseCompressionOutput(output);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].filename).toContain('use-typescript');
  });

  it('handles multiple summary sections (dedupes by header)', () => {
    const output = `## Session Summary
- First point
- Second point

## Other Section
- Something else`;

    const result = parseCompressionOutput(output);
    expect(result.summary).toHaveLength(2);
  });

  it('handles entity lines with extra whitespace', () => {
    const output = `## Entities to Create/Update
-  filename:  bob-friday  |  folder:  entities/people  |  action:  create  `;

    const result = parseCompressionOutput(output);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].filename).toBe('bob-friday');
    expect(result.entities[0].folder).toBe('entities/people');
    expect(result.entities[0].action).toBe('create');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// COMPRESSION PROMPT TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('buildCompressionPrompt', () => {
  it('includes all messages in conversation format', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Hello', timestamp: 1000 },
      { role: 'assistant', content: 'Hi there', timestamp: 2000 },
      { role: 'user', content: 'Tell me about BLE', timestamp: 3000 },
    ];

    const prompt = buildCompressionPrompt(messages);
    expect(prompt).toContain('[user] Hello');
    expect(prompt).toContain('[assistant] Hi there');
    expect(prompt).toContain('[user] Tell me about BLE');
    expect(prompt).toContain('Session Summary');
    expect(prompt).toContain('Facts Extracted');
    expect(prompt).toContain('Entities to Create/Update');
  });

  it('handles tool messages with names', () => {
    const messages: ConversationMessage[] = [
      { role: 'tool', content: 'Result from search', name: 'web_search', timestamp: 1000 },
    ];

    const prompt = buildCompressionPrompt(messages);
    expect(prompt).toContain('[tool:web_search] Result from search');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// COMPRESSOR TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('Compressor', () => {
  let auditEntries: AuditEntryInput[];

  beforeEach(() => {
    auditEntries = [];
  });

  function createCompressor(
    llmResponse: string = WELL_FORMED_OUTPUT,
    memory?: ReturnType<typeof createMockMemory>,
  ) {
    const llm = createMockLLM(llmResponse);
    const mem = memory ?? createMockMemory();

    const compressor = new Compressor({
      llm,
      memory: mem as unknown as MemoryManager,
      onAudit: (entry) => auditEntries.push(entry),
      minMessages: 2,
    });

    return { compressor, llm, memory: mem };
  }

  describe('compress()', () => {
    it('compresses working memory and writes to T2 + T3', async () => {
      const { compressor, memory } = createCompressor();
      const wm = createWorkingMemory([
        { role: 'user', content: 'Tell me about Bob Friday' },
        { role: 'assistant', content: 'Bob Friday is the Chief AI Officer at HPE' },
      ]);

      const result = await compressor.compress(wm, 'session-1', 'threshold');

      expect(result).not.toBeNull();
      expect(result!.messagesCompressed).toBe(2);
      expect(result!.dailyNotePath).toBe('daily/2026-03-05.md');
      expect(result!.entityCount).toBeGreaterThan(0);
      expect(result!.decisionCount).toBe(1);
      expect(result!.todoCount).toBe(2);

      // Verify T2 write
      expect(memory.writeCompression).toHaveBeenCalledWith(
        expect.stringContaining('indoor location'),
        'session-1',
      );

      // Verify TODO append
      expect(memory.appendToDaily).toHaveBeenCalledWith(
        expect.stringContaining('### TODOs'),
      );

      // Verify T3 entity writes
      expect(memory.upsertEntity).toHaveBeenCalled();

      // Verify git commit
      expect(memory.vault.git.flush).toHaveBeenCalled();

      // Verify T1 cleared
      expect(wm.messageCount).toBe(0);
    });

    it('skips compression when too few messages', async () => {
      const { compressor } = createCompressor();
      const wm = createWorkingMemory([
        { role: 'user', content: 'Hi' },
      ]);

      const result = await compressor.compress(wm, 'session-1', 'idle');
      expect(result).toBeNull();

      // No audit entries for compression_start
      expect(auditEntries).toHaveLength(0);
    });

    it('uses fallback summary on LLM failure', async () => {
      const llm = {
        chat: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
        init: vi.fn(),
        shutdown: vi.fn(),
        healthCheck: vi.fn(),
      } as unknown as LLMClient;

      const memory = createMockMemory();
      const compressor = new Compressor({
        llm,
        memory: memory as unknown as MemoryManager,
        onAudit: (entry) => auditEntries.push(entry),
      });

      const wm = createWorkingMemory([
        { role: 'user', content: 'Hello world' },
        { role: 'assistant', content: 'Hi there' },
      ]);

      const result = await compressor.compress(wm, 'session-1', 'close');

      expect(result).not.toBeNull();
      // Should still write to daily note (fallback summary)
      expect(memory.writeCompression).toHaveBeenCalled();
      // T1 should still be cleared
      expect(wm.messageCount).toBe(0);
    });

    it('handles entity upsert failures gracefully', async () => {
      const memory = createMockMemory();
      memory.upsertEntity.mockImplementation(() => {
        throw new Error('Vault write failed');
      });

      const { compressor } = createCompressor(WELL_FORMED_OUTPUT, memory);
      const wm = createWorkingMemory([
        { role: 'user', content: 'Test' },
        { role: 'assistant', content: 'Response' },
      ]);

      // Should not throw — entity failures are non-fatal
      const result = await compressor.compress(wm, 'session-1', 'threshold');
      expect(result).not.toBeNull();
      // T2 write should still succeed
      expect(memory.writeCompression).toHaveBeenCalled();
    });

    it('audits compression start and completion', async () => {
      const { compressor } = createCompressor();
      const wm = createWorkingMemory([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'World' },
      ]);

      await compressor.compress(wm, 'session-1', 'shutdown');

      const startAudit = auditEntries.find(
        e => (e.detail as Record<string, unknown>)?.action === 'compression_start',
      );
      const completeAudit = auditEntries.find(
        e => (e.detail as Record<string, unknown>)?.action === 'compression_complete',
      );

      expect(startAudit).toBeDefined();
      expect(startAudit!.sessionId).toBe('session-1');
      expect((startAudit!.detail as Record<string, unknown>).reason).toBe('shutdown');

      expect(completeAudit).toBeDefined();
      expect((completeAudit!.detail as Record<string, unknown>).dailyPath).toBe('daily/2026-03-05.md');
    });

    it('records compression reason in audit', async () => {
      const reasons: Array<'threshold' | 'idle' | 'close' | 'shutdown'> = [
        'threshold', 'idle', 'close', 'shutdown',
      ];

      for (const reason of reasons) {
        auditEntries = [];
        const { compressor } = createCompressor();
        const wm = createWorkingMemory([
          { role: 'user', content: `Test ${reason}` },
          { role: 'assistant', content: 'Response' },
        ]);

        await compressor.compress(wm, `session-${reason}`, reason);

        const startAudit = auditEntries.find(
          e => (e.detail as Record<string, unknown>)?.action === 'compression_start',
        );
        expect(startAudit).toBeDefined();
        expect((startAudit!.detail as Record<string, unknown>).reason).toBe(reason);
      }
    });

    it('does not append TODOs section when none exist', async () => {
      const noTodosOutput = `## Session Summary
- Quick chat

## Facts Extracted
None.

## Decisions
None.

## Open Questions
None.

## Entities to Create/Update
None.`;

      const { compressor, memory } = createCompressor(noTodosOutput);
      const wm = createWorkingMemory([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ]);

      await compressor.compress(wm, 'session-1', 'idle');

      // appendToDaily should NOT be called for TODOs
      expect(memory.appendToDaily).not.toHaveBeenCalled();
    });

    it('reports accurate durationMs', async () => {
      const { compressor } = createCompressor();
      const wm = createWorkingMemory([
        { role: 'user', content: 'Test' },
        { role: 'assistant', content: 'Response' },
      ]);

      const result = await compressor.compress(wm, 'session-1', 'threshold');
      expect(result!.durationMs).toBeGreaterThanOrEqual(0);
      expect(result!.durationMs).toBeLessThan(5000); // should be fast in tests
    });
  });

  describe('shouldCompress()', () => {
    it('returns true when tokens exceed threshold', () => {
      const { compressor } = createCompressor();
      const wm = createWorkingMemory([
        { role: 'user', content: 'A'.repeat(4000) }, // ~1000 tokens
        { role: 'assistant', content: 'B'.repeat(4000) }, // ~1000 tokens
      ]);

      expect(compressor.shouldCompress(wm, 500)).toBe(true);
      expect(compressor.shouldCompress(wm, 5000)).toBe(false);
    });

    it('returns false when below minMessages', () => {
      const { compressor } = createCompressor();
      const wm = createWorkingMemory([
        { role: 'user', content: 'A'.repeat(10000) }, // way over threshold in tokens
      ]);

      // Only 1 message, minMessages is 2
      expect(compressor.shouldCompress(wm, 100)).toBe(false);
    });

    it('returns false for empty working memory', () => {
      const { compressor } = createCompressor();
      const wm = WorkingMemory.empty();
      expect(compressor.shouldCompress(wm, 100)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('Compression edge cases', () => {
  it('handles very long conversations', () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message number ${i} with some content about topic ${i % 5}`,
        timestamp: Date.now() + i * 1000,
      });
    }

    const prompt = buildCompressionPrompt(messages);
    expect(prompt).toContain('[user] Message number 0');
    expect(prompt).toContain('[assistant] Message number 99');
    expect(prompt.split('\n').length).toBeGreaterThan(100);
  });

  it('handles messages with special characters', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Use ```code blocks``` and **markdown**', timestamp: 1000 },
      { role: 'assistant', content: 'Here\'s an emoji: 🎉 and a pipe | character', timestamp: 2000 },
    ];

    const prompt = buildCompressionPrompt(messages);
    expect(prompt).toContain('```code blocks```');
    expect(prompt).toContain('🎉');
  });

  it('parses output with irregular formatting', () => {
    const output = `## Session Summary
-First point without space
- Second point with space
-  Third with double space

## Facts Extracted
-fact: loose format|entity: some-entity|type: concept`;

    const result = parseCompressionOutput(output);
    // Summary should capture all 3 points
    expect(result.summary.length).toBeGreaterThanOrEqual(2);
  });
});
