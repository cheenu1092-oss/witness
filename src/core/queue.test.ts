/**
 * MessageQueue tests — priority message queue.
 */

import { describe, it, expect } from 'vitest';
import { MessageQueue } from './queue.js';
import type { VedMessage } from '../types/index.js';

function makeMessage(id: string, content: string): VedMessage {
  return {
    id,
    channel: 'cli',
    author: 'test-user',
    content,
    timestamp: Date.now(),
  };
}

// === Basic operations ===

describe('MessageQueue — basics', () => {
  it('starts empty', () => {
    const q = new MessageQueue();
    expect(q.length).toBe(0);
    expect(q.isEmpty).toBe(true);
    expect(q.dequeue()).toBeNull();
    expect(q.peek()).toBeNull();
  });

  it('enqueue and dequeue FIFO', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('1', 'first'));
    q.enqueue(makeMessage('2', 'second'));

    expect(q.length).toBe(2);
    expect(q.dequeue()!.id).toBe('1');
    expect(q.dequeue()!.id).toBe('2');
    expect(q.dequeue()).toBeNull();
  });

  it('peek returns next without removing', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('1', 'first'));
    expect(q.peek()!.id).toBe('1');
    expect(q.length).toBe(1); // still there
    expect(q.dequeue()!.id).toBe('1');
  });
});

// === Priority ordering ===

describe('MessageQueue — priority', () => {
  it('high priority dequeues before normal', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('n1', 'normal1'), 'normal');
    q.enqueue(makeMessage('h1', 'high1'), 'high');
    q.enqueue(makeMessage('n2', 'normal2'), 'normal');

    expect(q.dequeue()!.id).toBe('h1');
    expect(q.dequeue()!.id).toBe('n1');
    expect(q.dequeue()!.id).toBe('n2');
  });

  it('normal priority dequeues before low', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('l1', 'low1'), 'low');
    q.enqueue(makeMessage('n1', 'normal1'), 'normal');

    expect(q.dequeue()!.id).toBe('n1');
    expect(q.dequeue()!.id).toBe('l1');
  });

  it('full priority order: high > normal > low', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('l1', 'low'), 'low');
    q.enqueue(makeMessage('n1', 'normal'), 'normal');
    q.enqueue(makeMessage('h1', 'high'), 'high');

    expect(q.dequeue()!.id).toBe('h1');
    expect(q.dequeue()!.id).toBe('n1');
    expect(q.dequeue()!.id).toBe('l1');
  });

  it('FIFO within same priority', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('h1', 'first'), 'high');
    q.enqueue(makeMessage('h2', 'second'), 'high');
    q.enqueue(makeMessage('h3', 'third'), 'high');

    expect(q.dequeue()!.id).toBe('h1');
    expect(q.dequeue()!.id).toBe('h2');
    expect(q.dequeue()!.id).toBe('h3');
  });

  it('defaults to normal priority', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('1', 'test')); // default = normal
    q.enqueue(makeMessage('2', 'high'), 'high');

    expect(q.dequeue()!.id).toBe('2'); // high first
    expect(q.dequeue()!.id).toBe('1'); // then normal
  });

  it('peek respects priority', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('l', 'low'), 'low');
    q.enqueue(makeMessage('h', 'high'), 'high');
    expect(q.peek()!.id).toBe('h');
  });
});

// === Clear and counts ===

describe('MessageQueue — clear and counts', () => {
  it('clear empties all lanes', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('1', 'a'), 'high');
    q.enqueue(makeMessage('2', 'b'), 'normal');
    q.enqueue(makeMessage('3', 'c'), 'low');
    expect(q.length).toBe(3);

    q.clear();
    expect(q.length).toBe(0);
    expect(q.isEmpty).toBe(true);
    expect(q.dequeue()).toBeNull();
  });

  it('counts returns per-lane breakdown', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('1', 'a'), 'high');
    q.enqueue(makeMessage('2', 'b'), 'high');
    q.enqueue(makeMessage('3', 'c'), 'normal');

    const counts = q.counts();
    expect(counts.high).toBe(2);
    expect(counts.normal).toBe(1);
    expect(counts.low).toBe(0);
  });

  it('isEmpty is false when messages exist', () => {
    const q = new MessageQueue();
    expect(q.isEmpty).toBe(true);
    q.enqueue(makeMessage('1', 'test'));
    expect(q.isEmpty).toBe(false);
    q.dequeue();
    expect(q.isEmpty).toBe(true);
  });
});
