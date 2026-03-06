/**
 * Tests for Discord Channel Adapter enhancements.
 *
 * Covers:
 * - Message splitting (2000-char Discord limit)
 * - Approval embed building (colors, fields, formatting)
 * - Risk level → color/emoji mapping
 * - Edge cases (empty content, very long params)
 */

import { describe, it, expect } from 'vitest';
import { splitMessage, buildApprovalEmbed, riskToColor, riskEmoji } from './discord.js';
import type { WorkOrder } from '../types/index.js';

const DISCORD_TEST_LIMIT = 2000;

// ═══════════════════════════════════════════════════════════════════════
// MESSAGE SPLITTING
// ═══════════════════════════════════════════════════════════════════════

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const chunks = splitMessage('Hello, world!');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello, world!');
  });

  it('returns single chunk for exactly 2000 chars', () => {
    const msg = 'A'.repeat(2000);
    const chunks = splitMessage(msg);
    expect(chunks).toHaveLength(1);
  });

  it('splits at newlines when possible', () => {
    const line1 = 'A'.repeat(1500);
    const line2 = 'B'.repeat(1500);
    const msg = `${line1}\n${line2}`;
    const chunks = splitMessage(msg);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it('splits at sentence boundaries when no good newline', () => {
    const sentence1 = 'A'.repeat(1800) + '. ';
    const sentence2 = 'B'.repeat(300);
    const msg = sentence1 + sentence2;
    const chunks = splitMessage(msg);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('A');
    expect(chunks[1]).toContain('B');
  });

  it('hard-splits when no natural boundary', () => {
    const msg = 'A'.repeat(4500);
    const chunks = splitMessage(msg);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Total content should be preserved
    expect(chunks.join('')).toBe(msg);
  });

  it('handles empty string', () => {
    const chunks = splitMessage('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });

  it('handles exactly at the limit with newline', () => {
    const part1 = 'A'.repeat(1999);
    const part2 = 'B'.repeat(100);
    const msg = `${part1}\n${part2}`;
    const chunks = splitMessage(msg);
    expect(chunks).toHaveLength(2);
  });

  it('preserves all content across chunks', () => {
    const msg = 'Word '.repeat(800); // ~4000 chars
    const chunks = splitMessage(msg);
    const reassembled = chunks.join('');
    // Trimming may remove some whitespace at split points
    expect(reassembled.replace(/\s+/g, ' ').trim()).toBe(msg.replace(/\s+/g, ' ').trim());
  });

  it('handles multi-line content with code blocks', () => {
    const codeBlock = '```typescript\n' + 'const x = 1;\n'.repeat(200) + '```';
    const chunks = splitMessage(codeBlock);
    // Should split but content should be preserved
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // ── GAP-3: Code-block-aware splitting ──

  it('closes and reopens code blocks at split boundaries', () => {
    // A code block that spans well past 2000 chars
    const codeBlock = '```typescript\n' + 'const x = 1;\n'.repeat(200) + '```';
    const chunks = splitMessage(codeBlock);
    expect(chunks.length).toBeGreaterThan(1);

    // Every chunk should have balanced ``` fences
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0); // even = balanced
    }
  });

  it('preserves code block language tag when reopening', () => {
    const codeBlock = '```python\n' + 'x = 1\n'.repeat(500) + '```';
    const chunks = splitMessage(codeBlock);
    expect(chunks.length).toBeGreaterThan(1);

    // Second chunk should start with ```python to continue the block
    expect(chunks[1]).toMatch(/^```python/);
  });

  it('handles multiple code blocks in one message', () => {
    const block1 = '```js\n' + 'let a = 1;\n'.repeat(50) + '```\n';
    const text = 'Some text between blocks\n';
    const block2 = '```rust\n' + 'let b = 2;\n'.repeat(50) + '```\n';
    const msg = block1 + text + block2;

    if (msg.length <= 2000) {
      // Not long enough to split — skip
      return;
    }

    const chunks = splitMessage(msg);
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it('handles code block split right at the fence line', () => {
    // Content that fills right up to the limit with a code block open
    const prefix = 'Here is some code:\n```\n';
    const codeLine = 'console.log("hello");\n';
    const fillCount = Math.floor((DISCORD_TEST_LIMIT - prefix.length) / codeLine.length);
    const code = codeLine.repeat(fillCount);
    const msg = prefix + code + '```';

    const chunks = splitMessage(msg);
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it('does not break non-code-block messages', () => {
    // Regression: plain text without ``` should split exactly as before
    const msg = 'Word '.repeat(800); // ~4000 chars
    const chunks = splitMessage(msg);
    const reassembled = chunks.join('');
    expect(reassembled.replace(/\s+/g, ' ').trim()).toBe(msg.replace(/\s+/g, ' ').trim());
  });

  it('handles message with only closing fence in second half', () => {
    // Opening ``` near start, lots of code, closing ``` near end
    const msg = '```\n' + 'line\n'.repeat(500) + '```';
    const chunks = splitMessage(msg);
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it('handles triple backticks inside code blocks (nested markdown)', () => {
    // Edge: someone explaining markdown inside a code block
    // The ``` inside the block is actually part of content, not a fence
    // Our simple fence counting may struggle here, but it should at least not crash
    const msg = '```markdown\nHere is how you write code:\n````\ncode here\n````\nEnd\n```';
    const chunks = splitMessage(msg);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// APPROVAL EMBED
// ═══════════════════════════════════════════════════════════════════════

describe('buildApprovalEmbed', () => {
  const mockWorkOrder: WorkOrder = {
    id: 'WO-12345',
    sessionId: 'SESSION-1',
    messageId: 'MSG-1',
    tool: 'file_write',
    params: { path: '/etc/config', content: 'new config' },
    riskAssessment: { level: 'high', reasons: ['Writes to system path'] },
    riskLevel: 'high',
    status: 'pending',
    trustTier: 2,
    serverName: 'fs-server',
    createdAt: Date.now(),
  } as unknown as WorkOrder;

  it('creates embed with correct title', () => {
    const embed = buildApprovalEmbed(mockWorkOrder);
    expect(embed.title).toBe('⚠️ Approval Required');
  });

  it('uses correct color for risk level', () => {
    const embed = buildApprovalEmbed(mockWorkOrder);
    expect(embed.color).toBe(0xe74c3c); // red for high
  });

  it('includes all required fields', () => {
    const embed = buildApprovalEmbed(mockWorkOrder);
    const fieldNames = embed.fields!.map(f => f.name);

    expect(fieldNames).toContain('Tool');
    expect(fieldNames).toContain('Risk');
    expect(fieldNames).toContain('Trust Tier');
    expect(fieldNames).toContain('Parameters');
    expect(fieldNames).toContain('Work Order ID');
    expect(fieldNames).toContain('Action');
  });

  it('formats tool name in code', () => {
    const embed = buildApprovalEmbed(mockWorkOrder);
    const toolField = embed.fields!.find(f => f.name === 'Tool');
    expect(toolField!.value).toBe('`file_write`');
  });

  it('formats params as JSON code block', () => {
    const embed = buildApprovalEmbed(mockWorkOrder);
    const paramsField = embed.fields!.find(f => f.name === 'Parameters');
    expect(paramsField!.value).toContain('```json');
    expect(paramsField!.value).toContain('"path"');
    expect(paramsField!.value).toContain('/etc/config');
  });

  it('truncates very long params', () => {
    const longOrder = {
      ...mockWorkOrder,
      params: { data: 'X'.repeat(2000) },
    } as unknown as WorkOrder;

    const embed = buildApprovalEmbed(longOrder);
    const paramsField = embed.fields!.find(f => f.name === 'Parameters');
    expect(paramsField!.value.length).toBeLessThan(1100); // 1000 chars + formatting
    expect(paramsField!.value).toContain('...');
  });

  it('includes approve/deny instructions', () => {
    const embed = buildApprovalEmbed(mockWorkOrder);
    const actionField = embed.fields!.find(f => f.name === 'Action');
    expect(actionField!.value).toContain('approve WO-12345');
    expect(actionField!.value).toContain('deny WO-12345');
  });

  it('includes timestamp', () => {
    const embed = buildApprovalEmbed(mockWorkOrder);
    expect(embed.timestamp).toBeDefined();
    // Should be a valid ISO string
    expect(new Date(embed.timestamp!).getTime()).toBeGreaterThan(0);
  });

  it('includes footer', () => {
    const embed = buildApprovalEmbed(mockWorkOrder);
    expect(embed.footer?.text).toBe('Ved Trust Engine');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RISK LEVEL HELPERS
// ═══════════════════════════════════════════════════════════════════════

describe('riskToColor', () => {
  it('maps low → green', () => {
    expect(riskToColor('low')).toBe(0x2ecc71);
  });

  it('maps medium → orange', () => {
    expect(riskToColor('medium')).toBe(0xf39c12);
  });

  it('maps high → red', () => {
    expect(riskToColor('high')).toBe(0xe74c3c);
  });

  it('maps critical → purple', () => {
    expect(riskToColor('critical')).toBe(0x8e44ad);
  });

  it('maps unknown → grey', () => {
    expect(riskToColor('unknown')).toBe(0x95a5a6);
  });
});

describe('riskEmoji', () => {
  it('maps low → green circle', () => {
    expect(riskEmoji('low')).toBe('🟢');
  });

  it('maps medium → yellow circle', () => {
    expect(riskEmoji('medium')).toBe('🟡');
  });

  it('maps high → red circle', () => {
    expect(riskEmoji('high')).toBe('🔴');
  });

  it('maps critical → purple circle', () => {
    expect(riskEmoji('critical')).toBe('🟣');
  });

  it('maps unknown → white circle', () => {
    expect(riskEmoji('unknown')).toBe('⚪');
  });
});
