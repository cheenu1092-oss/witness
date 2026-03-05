/**
 * Hash chain utilities for Ved's tamper-evident audit log.
 *
 * Chain structure:
 *   hash = SHA-256(prevHash + timestamp + eventType + actor + detail)
 *
 * Genesis entry uses prevHash = SHA-256('ved-genesis').
 */

import { createHash } from 'node:crypto';

/** The genesis hash — prevHash for the first audit entry. */
export const GENESIS_HASH = createHash('sha256').update('ved-genesis').digest('hex');

/**
 * Compute the SHA-256 hash for an audit entry.
 * All inputs are concatenated as UTF-8 strings before hashing.
 */
export function hashEntry(
  prevHash: string,
  timestamp: number,
  eventType: string,
  actor: string,
  detail: string,
): string {
  const input = `${prevHash}${timestamp}${eventType}${actor}${detail}`;
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Minimal shape needed for chain verification. */
export interface ChainEntry {
  prevHash: string;
  hash: string;
  timestamp: number;
  eventType: string;
  actor: string;
  detail: string;
}

/**
 * Verify a chain of audit entries for integrity.
 *
 * Checks:
 * 1. First entry chains from GENESIS_HASH
 * 2. Each entry's hash matches recomputed value
 * 3. Each entry's prevHash matches previous entry's hash
 *
 * @returns -1 if chain is intact, or the index of the first broken link
 */
export function verifyChain(entries: ChainEntry[]): number {
  if (entries.length === 0) return -1;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    // First entry must chain from genesis
    if (i === 0 && e.prevHash !== GENESIS_HASH) return 0;

    // Recompute hash and compare
    const expected = hashEntry(e.prevHash, e.timestamp, e.eventType, e.actor, e.detail);
    if (expected !== e.hash) return i;

    // Chain linkage: prevHash must match previous entry's hash
    if (i > 0 && e.prevHash !== entries[i - 1].hash) return i;
  }

  return -1;
}
