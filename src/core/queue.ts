/**
 * MessageQueue — Priority queue for incoming messages.
 *
 * Three priority lanes: high > normal > low.
 * Within each lane, messages are FIFO (oldest first).
 *
 * Priority assignment:
 * - high: direct user messages (Discord, CLI)
 * - normal: cron triggers, system events
 * - low: background tasks, re-index requests
 */

import type { VedMessage } from '../types/index.js';

export type MessagePriority = 'high' | 'normal' | 'low';

/**
 * In-memory priority message queue.
 *
 * Not persisted — messages are persisted to the inbox table by the EventLoop
 * before enqueuing here. This queue is just for ordering within a loop cycle.
 */
export class MessageQueue {
  private lanes: Map<MessagePriority, VedMessage[]> = new Map([
    ['high', []],
    ['normal', []],
    ['low', []],
  ]);

  /**
   * Add a message to the queue.
   * @param msg The message to enqueue
   * @param priority Priority lane (default: 'normal')
   */
  enqueue(msg: VedMessage, priority: MessagePriority = 'normal'): void {
    this.lanes.get(priority)!.push(msg);
  }

  /**
   * Take the next message from the highest-priority non-empty lane.
   * @returns The next message, or null if all lanes are empty.
   */
  dequeue(): VedMessage | null {
    for (const priority of ['high', 'normal', 'low'] as MessagePriority[]) {
      const lane = this.lanes.get(priority)!;
      if (lane.length > 0) {
        return lane.shift()!;
      }
    }
    return null;
  }

  /**
   * Peek at the next message without removing it.
   * @returns The next message that dequeue() would return, or null.
   */
  peek(): VedMessage | null {
    for (const priority of ['high', 'normal', 'low'] as MessagePriority[]) {
      const lane = this.lanes.get(priority)!;
      if (lane.length > 0) {
        return lane[0];
      }
    }
    return null;
  }

  /** Total messages across all lanes. */
  get length(): number {
    let total = 0;
    for (const lane of this.lanes.values()) {
      total += lane.length;
    }
    return total;
  }

  /** Check if the queue is empty. */
  get isEmpty(): boolean {
    return this.length === 0;
  }

  /** Clear all lanes. */
  clear(): void {
    for (const lane of this.lanes.values()) {
      lane.length = 0;
    }
  }

  /** Get the count per priority lane (for diagnostics). */
  counts(): Record<MessagePriority, number> {
    return {
      high: this.lanes.get('high')!.length,
      normal: this.lanes.get('normal')!.length,
      low: this.lanes.get('low')!.length,
    };
  }
}
