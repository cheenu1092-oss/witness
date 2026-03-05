/**
 * Monotonic ULID generator for Ved.
 *
 * Uses monotonicFactory to guarantee sortable IDs even within the same millisecond.
 * All modules MUST use vedUlid() instead of ulid() directly.
 */

import { monotonicFactory } from 'ulid';

const _ulid = monotonicFactory();

/** Generate a monotonic ULID — sortable, unique, thread-safe within one process. */
export function vedUlid(): string {
  return _ulid();
}
