/**
 * ved-audit — Tamper-evident audit log with HMAC checkpoints.
 *
 * Exports:
 * - AuditLog: append-only hash-chained SQLite store
 * - AnchorManager: HMAC checkpoint creation and verification
 * - hashEntry, verifyChain, GENESIS_HASH: low-level hash utilities
 */

export { AuditLog } from './store.js';
export { AnchorManager } from './anchor.js';
export type { Anchor } from './anchor.js';
export { hashEntry, verifyChain, GENESIS_HASH } from './hash.js';
export type { ChainEntry } from './hash.js';
export { vedUlid } from '../types/ulid.js';
