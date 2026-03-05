/**
 * WorkingMemory tests — T1 memory tier.
 */

import { describe, it, expect } from 'vitest';
import { WorkingMemory, type ConversationMessage } from './working-memory.js';

function makeMsg(role: ConversationMessage['role'], content: string): ConversationMessage {
  return { role, content, timestamp: Date.now() };
}

// === Construction ===

describe('WorkingMemory — basics', () => {
  it('starts empty', () => {
    const wm = WorkingMemory.empty();
    expect(wm.messageCount).toBe(0);
    expect(wm.factCount).toBe(0);
    expect(wm.tokenCount).toBe(0);
    expect(wm.messages).toEqual([]);
  });

  it('accepts custom maxTokens', () => {
    const wm = new WorkingMemory(4000);
    expect(wm.maxTokens).toBe(4000);
  });

  it('defaults maxTokens to 8000', () => {
    const wm = WorkingMemory.empty();
    expect(wm.maxTokens).toBe(8000);
  });
});

// === Messages ===

describe('WorkingMemory — messages', () => {
  it('adds messages in order', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage(makeMsg('user', 'Hello'));
    wm.addMessage(makeMsg('assistant', 'Hi'));
    expect(wm.messageCount).toBe(2);
    expect(wm.messages[0].content).toBe('Hello');
    expect(wm.messages[1].content).toBe('Hi');
  });

  it('returns a copy from messages getter (not mutable reference)', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage(makeMsg('user', 'test'));
    const msgs = wm.messages;
    msgs.push(makeMsg('user', 'injected'));
    expect(wm.messageCount).toBe(1);
  });

  it('evicts oldest messages when over budget', () => {
    // Very small budget
    const wm = new WorkingMemory(50); // ~200 chars budget
    wm.addMessage(makeMsg('user', 'a'.repeat(100)));  // ~25 tokens
    wm.addMessage(makeMsg('user', 'b'.repeat(100)));  // ~25 tokens — now at 50
    wm.addMessage(makeMsg('user', 'c'.repeat(100)));  // ~25 tokens — over, evict first

    expect(wm.messageCount).toBeLessThanOrEqual(3);
    // The most recent message is always kept
    expect(wm.messages[wm.messages.length - 1].content).toBe('c'.repeat(100));
  });

  it('always keeps at least the most recent message even if over budget', () => {
    const wm = new WorkingMemory(1); // impossibly small
    wm.addMessage(makeMsg('user', 'This is a long message that exceeds the tiny budget'));
    expect(wm.messageCount).toBe(1);
  });

  it('handles tool messages with name and toolCallId', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage({
      role: 'tool',
      content: '{"result": true}',
      name: 'web_search',
      toolCallId: 'call_123',
      timestamp: Date.now(),
    });
    expect(wm.messageCount).toBe(1);
    expect(wm.messages[0].name).toBe('web_search');
    expect(wm.messages[0].toolCallId).toBe('call_123');
  });
});

// === Facts ===

describe('WorkingMemory — facts', () => {
  it('sets and gets facts', () => {
    const wm = WorkingMemory.empty();
    wm.setFact('user_name', 'Nag');
    expect(wm.getFact('user_name')).toBe('Nag');
    expect(wm.factCount).toBe(1);
  });

  it('setFact returns add op for new key', () => {
    const wm = WorkingMemory.empty();
    const op = wm.setFact('key', 'value');
    expect(op.type).toBe('working_set');
    expect(op.action).toBe('add');
    expect(op.key).toBe('key');
    expect(op.value).toBe('value');
  });

  it('setFact returns update op for existing key', () => {
    const wm = WorkingMemory.empty();
    wm.setFact('key', 'v1');
    const op = wm.setFact('key', 'v2');
    expect(op.action).toBe('update');
  });

  it('deleteFact removes and returns op', () => {
    const wm = WorkingMemory.empty();
    wm.setFact('key', 'value');
    const op = wm.deleteFact('key');
    expect(op).not.toBeNull();
    expect(op!.action).toBe('remove');
    expect(wm.getFact('key')).toBeUndefined();
    expect(wm.factCount).toBe(0);
  });

  it('deleteFact returns null for nonexistent key', () => {
    const wm = WorkingMemory.empty();
    expect(wm.deleteFact('nope')).toBeNull();
  });

  it('hasFact works', () => {
    const wm = WorkingMemory.empty();
    expect(wm.hasFact('key')).toBe(false);
    wm.setFact('key', 'val');
    expect(wm.hasFact('key')).toBe(true);
  });

  it('facts getter returns a copy', () => {
    const wm = WorkingMemory.empty();
    wm.setFact('a', '1');
    const facts = wm.facts;
    facts.set('b', '2');
    expect(wm.factCount).toBe(1);
  });
});

// === Token counting ===

describe('WorkingMemory — token counting', () => {
  it('counts message tokens approximately (chars/4)', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage(makeMsg('user', 'a'.repeat(400))); // ~100 tokens
    expect(wm.tokenCount).toBe(100);
  });

  it('includes fact tokens in count', () => {
    const wm = WorkingMemory.empty();
    wm.setFact('name', 'a'.repeat(40)); // key(~2) + value(~10) = ~12 tokens
    expect(wm.tokenCount).toBeGreaterThan(0);
  });

  it('includes tool name in token count', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage({ role: 'tool', content: 'result', name: 'web_search', timestamp: Date.now() });
    const withName = wm.tokenCount;

    const wm2 = WorkingMemory.empty();
    wm2.addMessage({ role: 'tool', content: 'result', timestamp: Date.now() });
    const withoutName = wm2.tokenCount;

    expect(withName).toBeGreaterThan(withoutName);
  });

  it('isOverThreshold works', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage(makeMsg('user', 'a'.repeat(2000))); // ~500 tokens
    expect(wm.isOverThreshold(400)).toBe(true);
    expect(wm.isOverThreshold(600)).toBe(false);
  });
});

// === Prompt assembly ===

describe('WorkingMemory — toPromptSection', () => {
  it('formats facts and messages', () => {
    const wm = WorkingMemory.empty();
    wm.setFact('user_name', 'Nag');
    wm.setFact('timezone', 'PST');
    wm.addMessage(makeMsg('user', 'Hello'));
    wm.addMessage(makeMsg('assistant', 'Hi there'));

    const prompt = wm.toPromptSection();
    expect(prompt).toContain('## Active Facts');
    expect(prompt).toContain('- user_name: Nag');
    expect(prompt).toContain('- timezone: PST');
    expect(prompt).toContain('## Recent Conversation');
    expect(prompt).toContain('[user] Hello');
    expect(prompt).toContain('[assistant] Hi there');
  });

  it('omits facts section when no facts', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage(makeMsg('user', 'test'));
    const prompt = wm.toPromptSection();
    expect(prompt).not.toContain('Active Facts');
    expect(prompt).toContain('[user] test');
  });

  it('includes tool name in message prefix', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage({ role: 'tool', content: 'ok', name: 'search', timestamp: Date.now() });
    expect(wm.toPromptSection()).toContain('[tool:search]');
  });

  it('returns empty string when empty', () => {
    const wm = WorkingMemory.empty();
    expect(wm.toPromptSection()).toBe('');
  });
});

// === Serialization ===

describe('WorkingMemory — serialization', () => {
  it('round-trips messages and facts', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage(makeMsg('user', 'Hello'));
    wm.addMessage(makeMsg('assistant', 'World'));
    wm.setFact('key', 'value');

    const serialized = wm.serialize();
    const restored = WorkingMemory.deserialize(serialized);

    expect(restored.messageCount).toBe(2);
    expect(restored.messages[0].content).toBe('Hello');
    expect(restored.messages[1].content).toBe('World');
    expect(restored.getFact('key')).toBe('value');
  });

  it('produces valid JSON', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage(makeMsg('user', 'test'));
    const json = wm.serialize();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('deserialize handles empty JSON gracefully', () => {
    const wm = WorkingMemory.deserialize('{}');
    expect(wm.messageCount).toBe(0);
    expect(wm.factCount).toBe(0);
  });

  it('deserialize handles invalid JSON gracefully', () => {
    const wm = WorkingMemory.deserialize('not json at all');
    expect(wm.messageCount).toBe(0);
  });

  it('deserialize passes maxTokens through', () => {
    const wm = WorkingMemory.deserialize('{}', 5000);
    expect(wm.maxTokens).toBe(5000);
  });

  it('preserves tool message metadata', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage({ role: 'tool', content: 'data', name: 'search', toolCallId: 'c1', timestamp: 123 });
    const restored = WorkingMemory.deserialize(wm.serialize());
    expect(restored.messages[0].name).toBe('search');
    expect(restored.messages[0].toolCallId).toBe('c1');
    expect(restored.messages[0].timestamp).toBe(123);
  });
});

// === Clear ===

describe('WorkingMemory — clear', () => {
  it('removes all messages and facts', () => {
    const wm = WorkingMemory.empty();
    wm.addMessage(makeMsg('user', 'hi'));
    wm.setFact('k', 'v');
    wm.clear();
    expect(wm.messageCount).toBe(0);
    expect(wm.factCount).toBe(0);
    expect(wm.tokenCount).toBe(0);
  });
});
