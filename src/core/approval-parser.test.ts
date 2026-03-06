/**
 * Tests for ApprovalCommandParser.
 *
 * Covers:
 * - Command parsing (approve, deny, pending, non-commands)
 * - Execution: approve/deny authorization (owner-only)
 * - Execution: work order state transitions
 * - Execution: pending list formatting
 * - Edge cases (whitespace, case sensitivity, missing IDs)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  parseApprovalCommand,
  executeApprovalCommand,
  formatPendingWorkOrder,
} from './approval-parser.js';
import type { ApprovalParserDeps } from './approval-parser.js';
import { WorkOrderManager } from '../trust/work-orders.js';
import { TrustEngine } from '../trust/engine.js';
import { AuditLog } from '../audit/store.js';
import { migrate } from '../db/migrate.js';
import type { WorkOrder, TrustConfig } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function createTestTrustConfig(ownerIds: string[] = ['owner-1']): TrustConfig {
  return {
    ownerIds,
    tribeIds: ['tribe-1'],
    knownIds: ['known-1'],
    defaultTier: 1,
    approvalTimeoutMs: 300_000,
    maxToolCallsPerMessage: 5,
    maxAgenticLoops: 3,
  };
}

function createDeps(db: Database.Database, ownerIds?: string[]): ApprovalParserDeps {
  const config = createTestTrustConfig(ownerIds);
  return {
    workOrders: new WorkOrderManager(db),
    trust: new TrustEngine(db, config),
    audit: new AuditLog(db),
  };
}

function createPendingWorkOrder(deps: ApprovalParserDeps, tool = 'file_write'): WorkOrder {
  return deps.workOrders.create(
    'session-1',
    'msg-1',
    tool,
    { path: '/tmp/test' },
    { level: 'high', reasons: ['Test'] },
    2,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PARSING
// ═══════════════════════════════════════════════════════════════════════

describe('parseApprovalCommand', () => {
  it('parses approve command', () => {
    const result = parseApprovalCommand('approve WO-12345');
    expect(result).toEqual({ action: 'approve', workOrderId: 'WO-12345' });
  });

  it('parses deny command', () => {
    const result = parseApprovalCommand('deny WO-12345');
    expect(result).toEqual({ action: 'deny', workOrderId: 'WO-12345' });
  });

  it('parses deny command with reason', () => {
    const result = parseApprovalCommand('deny WO-12345 too risky for production');
    expect(result).toEqual({
      action: 'deny',
      workOrderId: 'WO-12345',
      reason: 'too risky for production',
    });
  });

  it('parses pending command', () => {
    const result = parseApprovalCommand('pending');
    expect(result).toEqual({ action: 'pending' });
  });

  it('is case-insensitive', () => {
    expect(parseApprovalCommand('APPROVE WO-123')).toEqual({
      action: 'approve',
      workOrderId: 'WO-123',
    });
    expect(parseApprovalCommand('Deny WO-123')).toEqual({
      action: 'deny',
      workOrderId: 'WO-123',
    });
    expect(parseApprovalCommand('PENDING')).toEqual({ action: 'pending' });
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseApprovalCommand('  approve WO-123  ')).toEqual({
      action: 'approve',
      workOrderId: 'WO-123',
    });
  });

  it('returns null for non-commands', () => {
    expect(parseApprovalCommand('hello world')).toBeNull();
    expect(parseApprovalCommand('approve')).toBeNull(); // missing ID
    expect(parseApprovalCommand('deny')).toBeNull(); // missing ID
    expect(parseApprovalCommand('')).toBeNull();
    expect(parseApprovalCommand('   ')).toBeNull();
  });

  it('returns null for approve with extra words', () => {
    // "approve WO-123 extra" should NOT match approve (approve takes exactly 1 arg)
    expect(parseApprovalCommand('approve WO-123 extra')).toBeNull();
  });

  it('returns null for similar but non-matching text', () => {
    expect(parseApprovalCommand('I approve of this')).toBeNull();
    expect(parseApprovalCommand('please approve WO-123')).toBeNull();
    expect(parseApprovalCommand('can you approve WO-123')).toBeNull();
  });

  it('handles ULID-style work order IDs', () => {
    const result = parseApprovalCommand('approve 01HWXYZ1234567890ABCDE');
    expect(result).toEqual({
      action: 'approve',
      workOrderId: '01HWXYZ1234567890ABCDE',
    });
  });

  // ── VULN-16: Null byte stripping ──

  it('strips null bytes from input before parsing (VULN-16)', () => {
    // Null byte between command and ID should NOT parse as valid
    const result = parseApprovalCommand('approve\x00WO-123');
    // After stripping \0, this becomes "approveWO-123" which doesn't match
    expect(result).toBeNull();
  });

  it('strips null bytes within work order ID', () => {
    const result = parseApprovalCommand('approve WO-\x00123');
    // After stripping, becomes "approve WO-123" which IS valid
    expect(result).toEqual({
      action: 'approve',
      workOrderId: 'WO-123',
    });
  });

  it('strips null bytes in deny command', () => {
    const result = parseApprovalCommand('deny\x00WO-456');
    expect(result).toBeNull(); // "denyWO-456" — no match
  });

  it('strips null bytes in deny reason', () => {
    const result = parseApprovalCommand('deny WO-456 bad\x00idea');
    expect(result).toEqual({
      action: 'deny',
      workOrderId: 'WO-456',
      reason: 'badidea', // null bytes removed from reason too
    });
  });

  it('handles all-null-byte input', () => {
    const result = parseApprovalCommand('\x00\x00\x00');
    expect(result).toBeNull(); // becomes empty string
  });

  it('handles null byte in pending command', () => {
    const result = parseApprovalCommand('pen\x00ding');
    // becomes "pending" after stripping — should match
    expect(result).toEqual({ action: 'pending' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EXECUTION — APPROVE
// ═══════════════════════════════════════════════════════════════════════

describe('executeApprovalCommand — approve', () => {
  let db: Database.Database;
  let deps: ApprovalParserDeps;

  beforeEach(() => {
    db = createTestDb();
    deps = createDeps(db);
  });

  it('approves a pending work order as owner', () => {
    const wo = createPendingWorkOrder(deps);
    const result = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id },
      'discord',
      'owner-1',
      deps,
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain('✅');
    expect(result.response).toContain(wo.id);
    expect(result.response).toContain('file_write');

    // Verify work order is actually approved
    const updated = deps.workOrders.getById(wo.id);
    expect(updated?.status).toBe('approved');
  });

  it('rejects approval from non-owner', () => {
    const wo = createPendingWorkOrder(deps);
    const result = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id },
      'discord',
      'stranger-1',
      deps,
    );

    expect(result.response).toContain('❌');
    expect(result.response).toContain('tier 4');

    // Work order should still be pending
    const updated = deps.workOrders.getById(wo.id);
    expect(updated?.status).toBe('pending');
  });

  it('rejects approval from tribe member (tier 3)', () => {
    const wo = createPendingWorkOrder(deps);
    const result = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id },
      'discord',
      'tribe-1',
      deps,
    );

    expect(result.response).toContain('❌');
    expect(result.response).toContain('tier 4');
    expect(result.response).toContain('Your tier: 3');
  });

  it('returns error for non-existent work order', () => {
    const result = executeApprovalCommand(
      { action: 'approve', workOrderId: 'DOES-NOT-EXIST' },
      'discord',
      'owner-1',
      deps,
    );

    expect(result.response).toContain('❌');
    expect(result.response).toContain('not found');
  });

  it('returns error for already-approved work order', () => {
    const wo = createPendingWorkOrder(deps);
    deps.workOrders.approve(wo.id, 'user:discord:owner-1');

    const result = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id },
      'discord',
      'owner-1',
      deps,
    );

    expect(result.response).toContain('❌');
    expect(result.response).toContain('approved');
  });

  it('returns error for expired work order', () => {
    // Create a work order with very short timeout
    const shortDeps = createDeps(db);
    const manager = new WorkOrderManager(db, 1); // 1ms timeout
    shortDeps.workOrders = manager;

    const wo = manager.create(
      'session-1', 'msg-1', 'file_write',
      { path: '/tmp/test' },
      { level: 'high', reasons: ['Test'] },
      2,
    );

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    manager.sweepExpired();

    const result = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id },
      'discord',
      'owner-1',
      shortDeps,
    );

    expect(result.response).toContain('❌');
    expect(result.response).toContain('expired');
  });

  it('audits the approval', () => {
    const wo = createPendingWorkOrder(deps);
    executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id },
      'discord',
      'owner-1',
      deps,
    );

    // Check audit log has the approval event
    const head = deps.audit.getChainHead();
    expect(head.count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EXECUTION — DENY
// ═══════════════════════════════════════════════════════════════════════

describe('executeApprovalCommand — deny', () => {
  let db: Database.Database;
  let deps: ApprovalParserDeps;

  beforeEach(() => {
    db = createTestDb();
    deps = createDeps(db);
  });

  it('denies a pending work order as owner', () => {
    const wo = createPendingWorkOrder(deps);
    const result = executeApprovalCommand(
      { action: 'deny', workOrderId: wo.id },
      'discord',
      'owner-1',
      deps,
    );

    expect(result.response).toContain('🚫');
    expect(result.response).toContain(wo.id);
    expect(result.response).toContain('file_write');

    const updated = deps.workOrders.getById(wo.id);
    expect(updated?.status).toBe('denied');
  });

  it('includes reason in deny response', () => {
    const wo = createPendingWorkOrder(deps);
    const result = executeApprovalCommand(
      { action: 'deny', workOrderId: wo.id, reason: 'too dangerous' },
      'discord',
      'owner-1',
      deps,
    );

    expect(result.response).toContain('too dangerous');
  });

  it('rejects denial from non-owner', () => {
    const wo = createPendingWorkOrder(deps);
    const result = executeApprovalCommand(
      { action: 'deny', workOrderId: wo.id },
      'discord',
      'known-1',
      deps,
    );

    expect(result.response).toContain('❌');
    expect(result.response).toContain('tier 4');
    expect(result.response).toContain('Your tier: 2');

    // Work order should still be pending
    const updated = deps.workOrders.getById(wo.id);
    expect(updated?.status).toBe('pending');
  });

  it('returns error for non-existent work order', () => {
    const result = executeApprovalCommand(
      { action: 'deny', workOrderId: 'NOPE' },
      'discord',
      'owner-1',
      deps,
    );

    expect(result.response).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EXECUTION — PENDING
// ═══════════════════════════════════════════════════════════════════════

describe('executeApprovalCommand — pending', () => {
  let db: Database.Database;
  let deps: ApprovalParserDeps;

  beforeEach(() => {
    db = createTestDb();
    deps = createDeps(db);
  });

  it('shows empty state when no pending work orders', () => {
    const result = executeApprovalCommand(
      { action: 'pending' },
      'discord',
      'owner-1',
      deps,
    );

    expect(result.response).toContain('No pending');
  });

  it('lists pending work orders', () => {
    createPendingWorkOrder(deps, 'file_write');
    createPendingWorkOrder(deps, 'exec');

    const result = executeApprovalCommand(
      { action: 'pending' },
      'discord',
      'owner-1',
      deps,
    );

    expect(result.response).toContain('2 pending');
    expect(result.response).toContain('file_write');
    expect(result.response).toContain('exec');
  });

  it('anyone can view pending (no auth required)', () => {
    createPendingWorkOrder(deps);

    const result = executeApprovalCommand(
      { action: 'pending' },
      'discord',
      'stranger-1',
      deps,
    );

    // Should work — pending is a read-only operation
    expect(result.response).toContain('1 pending');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// formatPendingWorkOrder
// ═══════════════════════════════════════════════════════════════════════

describe('formatPendingWorkOrder', () => {
  it('formats work order with tool name and risk', () => {
    const wo: WorkOrder = {
      id: 'WO-TEST',
      sessionId: 's1',
      messageId: 'm1',
      tool: 'file_write',
      toolServer: '',
      params: { path: '/tmp/x' },
      riskLevel: 'high',
      riskReasons: ['Test'],
      trustTier: 2,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000, // 5 min from now
    };

    const text = formatPendingWorkOrder(wo);
    expect(text).toContain('WO-TEST');
    expect(text).toContain('file_write');
    expect(text).toContain('high');
  });

  it('shows expiry time', () => {
    const wo: WorkOrder = {
      id: 'WO-1',
      sessionId: 's1',
      messageId: 'm1',
      tool: 'exec',
      toolServer: '',
      params: {},
      riskLevel: 'medium',
      riskReasons: [],
      trustTier: 1,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 120_000, // 2 min
    };

    const text = formatPendingWorkOrder(wo);
    expect(text).toContain('Expires:');
    // Should show ~2m
    expect(text).toMatch(/\d+m/);
  });
});
