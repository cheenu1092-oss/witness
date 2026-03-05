/**
 * Trust layer tests — TrustEngine and WorkOrderManager.
 *
 * Tests: 45+ covering
 * - Trust tier resolution (config lists, runtime ledger, fallback)
 * - Risk assessment (base levels, param escalation, unknown tools)
 * - Trust×risk matrix (shouldAutoApprove, getTrustDecision)
 * - Trust grant/revoke lifecycle
 * - WorkOrder create, approve, deny, expire lifecycle
 * - Edge cases: expired orders, double-resolution, empty DB
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../db/connection.js';
import { TrustEngine } from './engine.js';
import { WorkOrderManager } from './work-orders.js';
import type { TrustConfig, TrustTier, RiskLevel } from '../types/index.js';
import { TRUST_RISK_MATRIX } from '../types/index.js';

// ── Helpers ──

function makeDb(): Database.Database {
  return openDatabase({ path: ':memory:' });
}

const BASE_CONFIG: TrustConfig = {
  ownerIds: ['owner1', 'owner2'],
  tribeIds: ['tribe1'],
  knownIds: ['known1', 'known2'],
  defaultTier: 1,
  approvalTimeoutMs: 300_000,
  maxToolCallsPerMessage: 10,
  maxAgenticLoops: 10,
};

function makeEngine(config: Partial<TrustConfig> = {}): { db: Database.Database; engine: TrustEngine } {
  const db = makeDb();
  const engine = new TrustEngine(db, { ...BASE_CONFIG, ...config });
  return { db, engine };
}

// ── Trust matrix constant ──

describe('TRUST_RISK_MATRIX', () => {
  it('covers all tier × risk combinations', () => {
    const tiers: TrustTier[] = [1, 2, 3, 4];
    const risks: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    for (const tier of tiers) {
      for (const risk of risks) {
        expect(TRUST_RISK_MATRIX[tier][risk]).toMatch(/^(auto|approve|deny)$/);
      }
    }
  });

  it('tier 4 owner can auto-approve low/medium/high', () => {
    expect(TRUST_RISK_MATRIX[4]['low']).toBe('auto');
    expect(TRUST_RISK_MATRIX[4]['medium']).toBe('auto');
    expect(TRUST_RISK_MATRIX[4]['high']).toBe('auto');
    expect(TRUST_RISK_MATRIX[4]['critical']).toBe('approve');
  });

  it('tier 1 stranger gets denied for medium and above', () => {
    expect(TRUST_RISK_MATRIX[1]['low']).toBe('approve');
    expect(TRUST_RISK_MATRIX[1]['medium']).toBe('deny');
    expect(TRUST_RISK_MATRIX[1]['high']).toBe('deny');
    expect(TRUST_RISK_MATRIX[1]['critical']).toBe('deny');
  });

  it('tier 2 known: auto for low, approve for medium, deny for high+', () => {
    expect(TRUST_RISK_MATRIX[2]['low']).toBe('auto');
    expect(TRUST_RISK_MATRIX[2]['medium']).toBe('approve');
    expect(TRUST_RISK_MATRIX[2]['high']).toBe('deny');
    expect(TRUST_RISK_MATRIX[2]['critical']).toBe('deny');
  });

  it('tier 3 tribe: auto for low+medium, approve for high, deny for critical', () => {
    expect(TRUST_RISK_MATRIX[3]['low']).toBe('auto');
    expect(TRUST_RISK_MATRIX[3]['medium']).toBe('auto');
    expect(TRUST_RISK_MATRIX[3]['high']).toBe('approve');
    expect(TRUST_RISK_MATRIX[3]['critical']).toBe('deny');
  });
});

// ── TrustEngine: tier resolution ──

describe('TrustEngine.resolveTier', () => {
  it('returns tier 4 for ownerIds', () => {
    const { engine } = makeEngine();
    expect(engine.resolveTier('cli', 'owner1')).toBe(4);
    expect(engine.resolveTier('discord', 'owner2')).toBe(4);
  });

  it('returns tier 3 for tribeIds', () => {
    const { engine } = makeEngine();
    expect(engine.resolveTier('cli', 'tribe1')).toBe(3);
  });

  it('returns tier 2 for knownIds', () => {
    const { engine } = makeEngine();
    expect(engine.resolveTier('cli', 'known1')).toBe(2);
    expect(engine.resolveTier('cli', 'known2')).toBe(2);
  });

  it('returns defaultTier for unknown users', () => {
    const { engine } = makeEngine({ defaultTier: 1 });
    expect(engine.resolveTier('cli', 'nobody')).toBe(1);
  });

  it('defaultTier can be overridden', () => {
    const { engine } = makeEngine({ defaultTier: 2 });
    expect(engine.resolveTier('cli', 'nobody')).toBe(2);
  });

  it('config lists take precedence over defaultTier', () => {
    const { engine } = makeEngine({ defaultTier: 2 });
    expect(engine.resolveTier('cli', 'owner1')).toBe(4); // not 2
  });

  it('runtime grant overrides config lists', () => {
    const { engine } = makeEngine();
    // owner1 would be tier 4 from config
    engine.grantTrust('cli', 'owner1', 2, 'user:admin', 'demoted');
    expect(engine.resolveTier('cli', 'owner1')).toBe(2);
  });

  it('runtime grant for unknown user upgrades tier', () => {
    const { engine } = makeEngine();
    engine.grantTrust('cli', 'newuser', 3, 'user:admin', 'trusted');
    expect(engine.resolveTier('cli', 'newuser')).toBe(3);
  });

  it('revoke removes runtime grant, falls back to config', () => {
    const { engine } = makeEngine();
    engine.grantTrust('cli', 'known1', 4, 'user:admin', 'promoted');
    expect(engine.resolveTier('cli', 'known1')).toBe(4);
    engine.revokeTrust('cli', 'known1', 'user:admin');
    // After revoke, falls back to config (known1 is in knownIds → tier 2)
    expect(engine.resolveTier('cli', 'known1')).toBe(2);
  });

  it('grants are channel-scoped', () => {
    const { engine } = makeEngine();
    engine.grantTrust('discord', 'newuser', 3, 'user:admin');
    expect(engine.resolveTier('discord', 'newuser')).toBe(3);
    expect(engine.resolveTier('cli', 'newuser')).toBe(1); // still stranger on cli
  });

  it('multiple grants: latest wins', () => {
    const { engine } = makeEngine();
    engine.grantTrust('cli', 'user1', 2, 'admin');
    engine.grantTrust('cli', 'user1', 3, 'admin', 'promoted');
    expect(engine.resolveTier('cli', 'user1')).toBe(3);
  });
});

// ── TrustEngine: risk assessment ──

describe('TrustEngine.assessRisk', () => {
  it('returns low for known read tools', () => {
    const { engine } = makeEngine();
    expect(engine.assessRisk('read', {}).level).toBe('low');
    expect(engine.assessRisk('Read', {}).level).toBe('low');
    expect(engine.assessRisk('web_search', {}).level).toBe('low');
  });

  it('returns medium for write tools', () => {
    const { engine } = makeEngine();
    expect(engine.assessRisk('write', {}).level).toBe('medium');
    expect(engine.assessRisk('Write', {}).level).toBe('medium');
    expect(engine.assessRisk('edit', {}).level).toBe('medium');
  });

  it('returns high for exec tools', () => {
    const { engine } = makeEngine();
    expect(engine.assessRisk('exec', {}).level).toBe('high');
    expect(engine.assessRisk('bash', {}).level).toBe('high');
  });

  it('defaults unknown tools to medium', () => {
    const { engine } = makeEngine();
    const result = engine.assessRisk('unknown_tool', {});
    expect(result.level).toBe('medium');
    expect(result.reasons.some(r => r.includes('Unknown'))).toBe(true);
  });

  it('escalates exec to critical for rm -rf', () => {
    const { engine } = makeEngine();
    const result = engine.assessRisk('exec', { command: 'rm -rf /home' });
    expect(result.level).toBe('critical');
    expect(result.reasons.some(r => r.includes('Destructive'))).toBe(true);
  });

  it('escalates exec to high for sudo', () => {
    const { engine } = makeEngine();
    const result = engine.assessRisk('exec', { command: 'sudo apt-get update' });
    expect(result.level).toBe('high');
    expect(result.reasons.some(r => r.includes('sudo'))).toBe(true);
  });

  it('escalates Write to critical for .env files', () => {
    const { engine } = makeEngine();
    const result = engine.assessRisk('Write', { file_path: '/app/.env' });
    expect(result.level).toBe('critical');
  });

  it('escalates Write to critical for .ssh paths', () => {
    const { engine } = makeEngine();
    const result = engine.assessRisk('Write', { file_path: '/home/user/.ssh/id_rsa' });
    expect(result.level).toBe('critical');
  });

  it('escalates Edit to critical for .pem files', () => {
    const { engine } = makeEngine();
    const result = engine.assessRisk('Edit', { file_path: '/certs/server.pem' });
    expect(result.level).toBe('critical');
  });

  it('includes reasons in result', () => {
    const { engine } = makeEngine();
    const result = engine.assessRisk('exec', { command: 'rm -rf /' });
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('safe exec command stays at high', () => {
    const { engine } = makeEngine();
    const result = engine.assessRisk('exec', { command: 'ls -la' });
    expect(result.level).toBe('high');
  });
});

// ── TrustEngine: shouldAutoApprove ──

describe('TrustEngine.shouldAutoApprove', () => {
  it('tier 4 owner auto-approves low/medium/high', () => {
    const { engine } = makeEngine();
    expect(engine.shouldAutoApprove(4, 'low')).toBe(true);
    expect(engine.shouldAutoApprove(4, 'medium')).toBe(true);
    expect(engine.shouldAutoApprove(4, 'high')).toBe(true);
  });

  it('tier 4 owner does NOT auto-approve critical (needs HITL)', () => {
    const { engine } = makeEngine();
    expect(engine.shouldAutoApprove(4, 'critical')).toBe(false);
  });

  it('tier 1 stranger never auto-approves', () => {
    const { engine } = makeEngine();
    expect(engine.shouldAutoApprove(1, 'low')).toBe(false);
    expect(engine.shouldAutoApprove(1, 'medium')).toBe(false);
    expect(engine.shouldAutoApprove(1, 'high')).toBe(false);
    expect(engine.shouldAutoApprove(1, 'critical')).toBe(false);
  });

  it('tier 2 known auto-approves only low', () => {
    const { engine } = makeEngine();
    expect(engine.shouldAutoApprove(2, 'low')).toBe(true);
    expect(engine.shouldAutoApprove(2, 'medium')).toBe(false);
    expect(engine.shouldAutoApprove(2, 'high')).toBe(false);
  });

  it('tier 3 tribe auto-approves low and medium', () => {
    const { engine } = makeEngine();
    expect(engine.shouldAutoApprove(3, 'low')).toBe(true);
    expect(engine.shouldAutoApprove(3, 'medium')).toBe(true);
    expect(engine.shouldAutoApprove(3, 'high')).toBe(false);
  });

  it('getTrustDecision returns correct values', () => {
    const { engine } = makeEngine();
    expect(engine.getTrustDecision(1, 'low')).toBe('approve');
    expect(engine.getTrustDecision(2, 'high')).toBe('deny');
    expect(engine.getTrustDecision(3, 'high')).toBe('approve');
    expect(engine.getTrustDecision(4, 'critical')).toBe('approve');
  });
});

// ── WorkOrderManager ──

describe('WorkOrderManager', () => {
  let db: Database.Database;
  let wom: WorkOrderManager;

  beforeEach(() => {
    db = makeDb();
    wom = new WorkOrderManager(db, 5000); // 5 second timeout for tests
  });

  const baseRisk = { level: 'high' as RiskLevel, reasons: ['test risk'] };

  it('creates a pending work order', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', { command: 'ls' }, baseRisk, 2);
    expect(wo.id).toBeTruthy();
    expect(wo.status).toBe('pending');
    expect(wo.tool).toBe('exec');
    expect(wo.riskLevel).toBe('high');
    expect(wo.trustTier).toBe(2);
    expect(wo.sessionId).toBe('sess-1');
    expect(wo.messageId).toBe('msg-1');
  });

  it('stores params as object', () => {
    const wo = wom.create('sess-1', 'msg-1', 'write', { path: '/tmp/test', content: 'hello' }, baseRisk, 3);
    expect(wo.params).toEqual({ path: '/tmp/test', content: 'hello' });
  });

  it('stores riskReasons', () => {
    const risk = { level: 'critical' as RiskLevel, reasons: ['dangerous', 'elevated'] };
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, risk, 4);
    expect(wo.riskReasons).toEqual(['dangerous', 'elevated']);
  });

  it('getById returns created work order', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    const found = wom.getById(wo.id);
    expect(found?.id).toBe(wo.id);
  });

  it('getById returns null for missing ID', () => {
    expect(wom.getById('nonexistent')).toBeNull();
  });

  it('approve transitions status to approved', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 3);
    const approved = wom.approve(wo.id, 'user:admin');
    expect(approved?.status).toBe('approved');
    expect(approved?.resolvedBy).toBe('user:admin');
    expect(approved?.resolvedAt).toBeDefined();
  });

  it('deny transitions status to denied', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 3);
    const denied = wom.deny(wo.id, 'user:admin');
    expect(denied?.status).toBe('denied');
    expect(denied?.resolvedBy).toBe('user:admin');
  });

  it('approve returns null for non-pending order', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    wom.deny(wo.id, 'user:admin'); // deny first
    const result = wom.approve(wo.id, 'user:admin2'); // try to approve denied
    expect(result).toBeNull();
  });

  it('deny returns null for already-approved order', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    wom.approve(wo.id, 'user:admin');
    const result = wom.deny(wo.id, 'user:admin2');
    expect(result).toBeNull();
  });

  it('getPending returns all pending orders', () => {
    wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    wom.create('sess-2', 'msg-2', 'write', {}, { level: 'medium', reasons: [] }, 3);
    const pending = wom.getPending();
    expect(pending.length).toBe(2);
    expect(pending.every(w => w.status === 'pending')).toBe(true);
  });

  it('getPending filters by sessionId', () => {
    wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    wom.create('sess-2', 'msg-2', 'write', {}, { level: 'medium', reasons: [] }, 3);
    const pending = wom.getPending('sess-1');
    expect(pending.length).toBe(1);
    expect(pending[0].sessionId).toBe('sess-1');
  });

  it('getPending excludes resolved orders', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    wom.approve(wo.id, 'user:admin');
    expect(wom.getPending().length).toBe(0);
  });

  it('sweepExpired expires past-deadline orders', async () => {
    // Create WOM with very short timeout
    const fastWom = new WorkOrderManager(db, 1); // 1ms timeout
    fastWom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    await new Promise(r => setTimeout(r, 10)); // wait for expiry
    const swept = fastWom.sweepExpired();
    expect(swept).toBe(1);
    const pending = fastWom.getPending();
    expect(pending.length).toBe(0);
  });

  it('sweepExpired returns 0 when nothing to expire', () => {
    wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2); // 5s timeout, not expired
    const swept = wom.sweepExpired();
    expect(swept).toBe(0);
  });

  it('sweepExpired does not affect approved/denied orders', () => {
    const fastWom = new WorkOrderManager(db, 1);
    const wo = fastWom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    fastWom.approve(wo.id, 'user:admin');
    const swept = fastWom.sweepExpired();
    expect(swept).toBe(0);
  });

  it('work order has expiresAt set correctly', () => {
    const before = Date.now();
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    const after = Date.now();
    // expiresAt should be ~5 seconds (5000ms) after creation
    expect(wo.expiresAt).toBeGreaterThan(before + 4900);
    expect(wo.expiresAt).toBeLessThan(after + 5100);
  });

  it('work order toolServer defaults to empty string', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    expect(wo.toolServer).toBe('');
  });

  it('work order stores toolServer when provided', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2, 'my-server');
    expect(wo.toolServer).toBe('my-server');
  });

  it('multiple pending orders for same session', () => {
    wom.create('sess-1', 'msg-1', 'exec', { cmd: 'a' }, baseRisk, 2);
    wom.create('sess-1', 'msg-2', 'exec', { cmd: 'b' }, baseRisk, 2);
    expect(wom.getPending('sess-1').length).toBe(2);
  });

  it('full lifecycle: create → approve → no longer pending', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    expect(wom.getPending().length).toBe(1);

    const approved = wom.approve(wo.id, 'user:owner');
    expect(approved?.status).toBe('approved');
    expect(wom.getPending().length).toBe(0);
  });

  it('full lifecycle: create → deny → no longer pending', () => {
    const wo = wom.create('sess-1', 'msg-1', 'exec', {}, baseRisk, 2);
    const denied = wom.deny(wo.id, 'user:owner');
    expect(denied?.status).toBe('denied');
    expect(wom.getPending().length).toBe(0);
  });
});
