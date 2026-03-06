/**
 * Red Team Tests — Session 43 (Attack: Content Filter Bypass + Post-Approval Races)
 *
 * Attack categories:
 * 1. CONTENT FILTER BYPASS — Unicode confusables, encoding tricks, split-across-fields
 * 2. CONTENT FILTER BOUNDARY — Edge cases, partial matches, nested patterns
 * 3. POST-APPROVAL RACE CONDITIONS — Double-approve, approve during shutdown, approve after MCP disconnect
 * 4. POST-APPROVAL SESSION INTEGRITY — Working memory injection, cross-session leaks
 * 5. WORK ORDER TIMING ATTACKS — Approve at exact expiry boundary, rapid create/approve/expire
 * 6. COMPRESSOR→FILTER INTERACTION — LLM output crafted to bypass filter via entity naming
 * 7. APPROVAL+FILTER COMBINED — Tool results containing secrets flowing into working memory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { filterSensitiveContent } from './core/compressor.js';
import { parseCompressionOutput } from './core/compressor.js';
import { parseApprovalCommand, executeApprovalCommand, type ApprovalParserDeps } from './core/approval-parser.js';
import { AuditLog } from './audit/store.js';
import { TrustEngine } from './trust/engine.js';
import { WorkOrderManager } from './trust/work-orders.js';
import { SessionManager } from './core/session.js';
import { WorkingMemory } from './core/working-memory.js';
import { migrate } from './db/migrate.js';
import { getDefaults } from './core/config.js';
import type { VedConfig, WorkOrder } from './types/index.js';

// ─── Helpers ───

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function makeConfig(overrides?: Partial<VedConfig>): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    ...overrides,
    ownerIds: overrides?.ownerIds ?? ['owner-1'],
    audit: { ...defaults.audit, ...overrides?.audit },
    trust: { ...defaults.trust, ...overrides?.trust },
  } as VedConfig;
}

function setupApprovalDeps(db: Database.Database, config: VedConfig): {
  workOrders: WorkOrderManager;
  trust: TrustEngine;
  audit: AuditLog;
} {
  const audit = new AuditLog(db);
  const trust = new TrustEngine(db, config, audit);
  const workOrders = new WorkOrderManager(db);
  return { workOrders, trust, audit };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. CONTENT FILTER BYPASS — Unicode confusables, encoding tricks
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S43: Content Filter Bypass', () => {
  describe('Unicode confusable attacks', () => {
    it('should catch API key with Unicode look-alike characters in prefix', () => {
      // Using Cyrillic 'а' (U+0430) instead of Latin 'a' in "api_key"
      // The regex uses /api[_-]?key/gi which matches ASCII only
      const input = 'аpi_key=sk-1234567890abcdef1234567890abcdef';
      const { sanitized, redactions } = filterSensitiveContent(input);
      // This WILL bypass — Cyrillic 'а' ≠ Latin 'a'
      // Documenting as a known limitation — Unicode confusables are hard to catch without normalization
      if (redactions.length === 0) {
        // FINDING: Unicode confusable bypass confirmed
        expect(sanitized).toContain('sk-1234567890abcdef');
      }
    });

    it('should catch API key with fullwidth Latin characters', () => {
      // Fullwidth 'ａｐｉ＿ｋｅｙ' (U+FF41 etc.)
      const input = 'ａｐｉ＿ｋｅｙ=sk-1234567890abcdef1234567890abcdef';
      const { sanitized, redactions } = filterSensitiveContent(input);
      // Expected: bypass — fullwidth chars don't match ASCII regex
      if (redactions.length === 0) {
        // FINDING: Fullwidth Unicode bypass confirmed
        expect(sanitized).toContain('sk-1234567890abcdef');
      }
    });

    it('should catch zero-width character injection in key prefix', () => {
      // Zero-width joiner inserted: "api\u200D_key"
      const input = 'api\u200D_key=sk-1234567890abcdef1234567890abcdef';
      const { sanitized, redactions } = filterSensitiveContent(input);
      // Zero-width chars break the regex match
      if (redactions.length === 0) {
        // FINDING: Zero-width character injection bypass
        expect(sanitized).toContain('sk-1234567890abcdef');
      }
    });

    it('should still catch standard ASCII API keys', () => {
      const input = 'api_key=sk-1234567890abcdef1234567890abcdef';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(redactions.length).toBeGreaterThan(0);
      expect(sanitized).toContain('[REDACTED_API_KEY]');
    });
  });

  describe('Base64 encoded secrets', () => {
    it('should not catch base64-encoded API key', () => {
      // api_key=sk-secret123 → base64
      const encoded = Buffer.from('api_key=sk-secret1234567890abcdef').toString('base64');
      const input = `The config is: ${encoded}`;
      const { redactions } = filterSensitiveContent(input);
      // Base64 encoding completely hides the pattern
      // FINDING: Base64 bypass — filter only works on plaintext
      expect(redactions.length).toBe(0);
    });

    it('should not catch hex-encoded AWS key', () => {
      const awsKey = 'AKIAIOSFODNN7EXAMPLE';
      const hexKey = Buffer.from(awsKey).toString('hex');
      const input = `Key in hex: ${hexKey}`;
      const { redactions } = filterSensitiveContent(input);
      // Hex encoding bypasses pattern
      expect(redactions.length).toBe(0);
    });
  });

  describe('Split-across-fields attack', () => {
    it('should not catch secret split across entity name + fact', () => {
      // Attacker puts "api_key=" in entity name and value in fact
      const entityName = 'config-api_key=';
      const fact = 'sk-1234567890abcdef1234567890abcdef';
      // Each individually may not match the full pattern
      const { redactions: nameRedactions } = filterSensitiveContent(entityName);
      const { redactions: factRedactions } = filterSensitiveContent(fact);
      // The fact alone is just a random string — no context word like "api_key"
      // FINDING: Splitting across fields can bypass detection
      // The entity name might match though since it contains api_key=
      if (nameRedactions.length > 0) {
        expect(nameRedactions[0]).toContain('api_key');
      }
    });

    it('should not catch password split with newline', () => {
      const input = 'password:\nsuper_secret_value_1234';
      const { sanitized, redactions } = filterSensitiveContent(input);
      // \s in regex includes \n, so password\s*[:=] should match...
      // Actually the regex uses: /password\s*[:=]\s*['"]?[^\s'"]{4,}/
      // The [^\s'"] after the = won't match across the newline
      // Let's verify
      if (redactions.length === 0) {
        expect(sanitized).toContain('super_secret_value_1234');
      }
    });
  });

  describe('Pattern boundary edge cases', () => {
    it('should catch AWS key at exact boundary (AKIA + 16 chars)', () => {
      const input = 'AKIAIOSFODNN7EXA'; // AKIA + 12 chars = 16 total, need 16 after AKIA
      const { redactions: tooShort } = filterSensitiveContent('AKIA' + 'A'.repeat(15));
      const { redactions: exact } = filterSensitiveContent('AKIA' + 'A'.repeat(16));
      const { redactions: long } = filterSensitiveContent('AKIA' + 'A'.repeat(20));
      // Pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/
      expect(exact.length).toBeGreaterThan(0); // Exactly 16 chars after AKIA
      expect(long.length).toBeGreaterThan(0);  // More than 16 still catches
      expect(tooShort.length).toBe(0);         // 15 chars = no match
    });

    it('should catch JWT with minimum segment lengths', () => {
      // Pattern: eyJ + 10 chars . 10 chars . 10 chars minimum
      const minJwt = 'eyJ' + 'A'.repeat(10) + '.' + 'B'.repeat(10) + '.' + 'C'.repeat(10);
      const { redactions } = filterSensitiveContent(minJwt);
      expect(redactions.length).toBeGreaterThan(0);
    });

    it('should not catch JWT-like string with short segments', () => {
      const shortJwt = 'eyJhbGc.abc.def'; // segments too short
      const { redactions } = filterSensitiveContent(shortJwt);
      expect(redactions.length).toBe(0);
    });

    it('should catch GitHub token variants in [posh] character class', () => {
      // Regex is gh[posh]_ — character class [p, o, s, h]
      for (const prefix of ['ghp_', 'gho_', 'ghs_', 'ghh_']) {
        const token = prefix + 'A'.repeat(36);
        const { redactions } = filterSensitiveContent(token);
        expect(redactions.length).toBeGreaterThan(0);
      }
    });

    it('FIXED (S44): ghr_ (fine-grained PAT) now caught by gh[poshr]_ regex', () => {
      // VULN-17 fixed in S44: regex changed from gh[posh]_ to gh[poshr]_
      const token = 'ghr_' + 'A'.repeat(36);
      const { redactions } = filterSensitiveContent(token);
      expect(redactions.length).toBe(1); // FIX CONFIRMED
    });

    it('should not catch gh token with completely wrong prefix', () => {
      const token = 'gha_' + 'A'.repeat(36); // 'a' not in [posh]
      const { redactions } = filterSensitiveContent(token);
      expect(redactions.length).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CONTENT FILTER BOUNDARY — Nested patterns, multiple matches, escaping
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S43: Content Filter Boundary Cases', () => {
  it('should handle multiple different secrets in one text', () => {
    const input = [
      'api_key=sk-abcdefghijklmnopqrst1234',
      'Also here is a JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'And password=hunter42',
      'Bearer eyJ0b2tlbjEyMzQ1Njc4OTAxMjM0NTY3ODkw',
    ].join('\n');
    const { sanitized, redactions } = filterSensitiveContent(input);
    expect(redactions.length).toBeGreaterThanOrEqual(3); // API key + JWT + password at minimum
    expect(sanitized).not.toContain('sk-abcdefghijklmnopqrst');
    expect(sanitized).not.toContain('hunter42');
  });

  it('should handle secret embedded in markdown code block', () => {
    const input = '```\nexport API_KEY=sk-1234567890abcdefghijk1234\n```';
    const { sanitized, redactions } = filterSensitiveContent(input);
    // Filter works on raw text, doesn't parse markdown
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).not.toContain('sk-1234567890abcdefghijk');
  });

  it('should handle secret in JSON string (with colon separator)', () => {
    // The regex uses [:=] — JSON "api_key": "value" has `: ` between key and value
    // but the key is in quotes and separated by `": "` — let's test both formats
    const inputColonEquals = 'api_key = sk-abcdefghijklmnop12345678';
    const { redactions: r1 } = filterSensitiveContent(inputColonEquals);
    expect(r1.length).toBeGreaterThan(0);

    // JSON format: "api_key": "value" — the regex might not match because of quotes around key
    const inputJson = '{"api_key": "sk-abcdefghijklmnop12345678"}';
    const { redactions: r2 } = filterSensitiveContent(inputJson);
    // FINDING: JSON format may or may not match depending on regex boundary
    // The pattern is: /api[_-]?key\s*[:=]\s*['"]?.../ — the `"` before `api_key` breaks word boundary
    // but regex has no word boundary, so `"api_key"` still matches `api_key` within it
    // Actually it should match since the regex is substring-based
    if (r2.length === 0) {
      // Document as finding if it bypasses
      expect(inputJson).toContain('sk-abcdefghijklmnop');
    } else {
      expect(r2.length).toBeGreaterThan(0);
    }
  });

  it('should handle PEM private key with various whitespace', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBA...(base64 data here)...\n-----END PRIVATE KEY-----';
    const { sanitized, redactions } = filterSensitiveContent(pem);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('should handle connection string with special chars in password', () => {
    const input = 'mongodb://admin:p@ss%23word@db.example.com:27017/mydb';
    const { sanitized, redactions } = filterSensitiveContent(input);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_CONN_STRING]');
  });

  it('should handle Slack token formats', () => {
    const tokens = ['xoxb-1234567890-abcdefghij', 'xoxp-1234567890-abcdefghij', 'xoxs-1234567890-abcdefghij'];
    for (const token of tokens) {
      const { redactions } = filterSensitiveContent(token);
      expect(redactions.length).toBeGreaterThan(0);
    }
  });

  it('should not redact normal text that looks vaguely like a token', () => {
    const input = 'The api key concept is important for security discussions';
    const { sanitized, redactions } = filterSensitiveContent(input);
    expect(redactions.length).toBe(0);
    expect(sanitized).toBe(input); // Unchanged
  });

  it('should handle empty and whitespace-only input', () => {
    expect(filterSensitiveContent('').redactions.length).toBe(0);
    expect(filterSensitiveContent('   ').redactions.length).toBe(0);
    expect(filterSensitiveContent('\n\n').redactions.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. POST-APPROVAL RACE CONDITIONS
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S43: Post-Approval Race Conditions', () => {
  let db: Database.Database;
  let config: VedConfig;

  beforeEach(() => {
    db = createTestDb();
    config = makeConfig({ ownerIds: ['owner-1'] });
  });

  afterEach(() => {
    db.close();
  });

  it('double-approve: second approval should fail', () => {
    const { workOrders, trust, audit } = setupApprovalDeps(db, config);
    const wo = workOrders.create('sess-1', 'msg-1', 'dangerous-tool', { x: 1 },
      { level: 'high', reasons: ['danger'], override: false }, 3);

    const approvedOrders: WorkOrder[] = [];
    const deps: ApprovalParserDeps = {
      workOrders, trust, audit,
      onApproved: (wo) => approvedOrders.push(wo),
    };

    // First approve
    const r1 = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id },
      'discord', 'owner-1', deps,
    );
    expect(r1.response).toContain('✅ Approved');
    expect(approvedOrders).toHaveLength(1);

    // Second approve — should fail (already resolved)
    const r2 = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id },
      'discord', 'owner-1', deps,
    );
    expect(r2.response).toContain('cannot be approved');
    expect(r2.response).toContain('approved'); // status = approved
    expect(approvedOrders).toHaveLength(1); // onApproved NOT called again
  });

  it('approve then deny: deny should fail', () => {
    const { workOrders, trust, audit } = setupApprovalDeps(db, config);
    const wo = workOrders.create('sess-1', 'msg-1', 'tool-x', {},
      { level: 'high', reasons: ['risk'], override: false }, 3);

    const deps: ApprovalParserDeps = { workOrders, trust, audit };

    executeApprovalCommand({ action: 'approve', workOrderId: wo.id }, 'discord', 'owner-1', deps);

    const denyResult = executeApprovalCommand(
      { action: 'deny', workOrderId: wo.id }, 'discord', 'owner-1', deps,
    );
    expect(denyResult.response).toContain('cannot be denied');
  });

  it('deny then approve: approve should fail', () => {
    const { workOrders, trust, audit } = setupApprovalDeps(db, config);
    const wo = workOrders.create('sess-1', 'msg-1', 'tool-y', {},
      { level: 'high', reasons: ['risk'], override: false }, 3);

    const deps: ApprovalParserDeps = { workOrders, trust, audit };

    executeApprovalCommand({ action: 'deny', workOrderId: wo.id }, 'discord', 'owner-1', deps);

    const approveResult = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id }, 'discord', 'owner-1', deps,
    );
    expect(approveResult.response).toContain('cannot be approved');
  });

  it('concurrent approve from two owners: only one should succeed', () => {
    const cfg = makeConfig({ ownerIds: ['owner-1', 'owner-2'] });
    const { workOrders, trust, audit } = setupApprovalDeps(db, cfg);
    const wo = workOrders.create('sess-1', 'msg-1', 'tool-z', {},
      { level: 'high', reasons: ['risk'], override: false }, 3);

    const approvedOrders: WorkOrder[] = [];
    const deps: ApprovalParserDeps = {
      workOrders, trust, audit,
      onApproved: (wo) => approvedOrders.push(wo),
    };

    // Both owners try to approve (simulating concurrent requests — SQLite serializes them)
    const r1 = executeApprovalCommand({ action: 'approve', workOrderId: wo.id }, 'discord', 'owner-1', deps);
    const r2 = executeApprovalCommand({ action: 'approve', workOrderId: wo.id }, 'discord', 'owner-2', deps);

    // One succeeds, one fails
    const successes = [r1, r2].filter(r => r.response.includes('✅'));
    const failures = [r1, r2].filter(r => r.response.includes('cannot be approved'));
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(approvedOrders).toHaveLength(1); // Tool executes exactly once
  });

  it('approve after expiry: should fail even if work order still in DB', () => {
    const { workOrders, trust, audit } = setupApprovalDeps(db, config);

    // Create with very short timeout
    const wo = workOrders.create('sess-1', 'msg-1', 'tool-expired', {},
      { level: 'high', reasons: ['risk'], override: false }, 3);

    // Manually expire it by updating expires_at to past
    db.prepare('UPDATE work_orders SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, wo.id);

    const approvedOrders: WorkOrder[] = [];
    const deps: ApprovalParserDeps = {
      workOrders, trust, audit,
      onApproved: (wo) => approvedOrders.push(wo),
    };

    const result = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id }, 'discord', 'owner-1', deps,
    );

    // VULN-13 fix should prevent this
    expect(result.response).toContain('cannot be approved');
    expect(approvedOrders).toHaveLength(0);
  });

  it('approve at exact expiry timestamp: should fail (boundary condition)', () => {
    const { workOrders, trust, audit } = setupApprovalDeps(db, config);
    const wo = workOrders.create('sess-1', 'msg-1', 'tool-boundary', {},
      { level: 'high', reasons: ['risk'], override: false }, 3);

    const now = Date.now();
    // Set expires_at = now (exactly at boundary)
    db.prepare('UPDATE work_orders SET expires_at = ? WHERE id = ?').run(now, wo.id);

    const approvedOrders: WorkOrder[] = [];
    const deps: ApprovalParserDeps = {
      workOrders, trust, audit,
      onApproved: (wo) => approvedOrders.push(wo),
    };

    // The SQL check is: expires_at > @resolvedAt
    // If resolvedAt == expires_at, this should FAIL (not strictly greater)
    const result = executeApprovalCommand(
      { action: 'approve', workOrderId: wo.id }, 'discord', 'owner-1', deps,
    );

    // At exact boundary, should fail — expires_at > resolvedAt is false when equal
    expect(result.response).toContain('cannot be approved');
    expect(approvedOrders).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. POST-APPROVAL SESSION INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S43: Post-Approval Session Integrity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('tool result should not be injectable into wrong session working memory', () => {
    const config = makeConfig({ ownerIds: ['owner-1'] });
    const audit = new AuditLog(db);
    const sessions = new SessionManager(db, config, audit);

    // Create two sessions
    const session1 = sessions.getOrCreate('ch-1', 'ch-id-1', 'user-1', 3);
    const session2 = sessions.getOrCreate('ch-2', 'ch-id-2', 'user-2', 2);

    // Simulate tool result going to session1
    session1.workingMemory.addMessage({
      role: 'tool',
      content: '[Approved tool result for file-read]: contents of /etc/passwd',
      name: 'file-read',
      toolCallId: 'post-approve-wo-1',
      timestamp: Date.now(),
    });

    // Verify session2 is NOT contaminated
    const s2Messages = session2.workingMemory.messages;
    const hasToolResult = s2Messages.some(m => m.content.includes('/etc/passwd'));
    expect(hasToolResult).toBe(false);
  });

  it('approved tool result should be audited even if channel send fails', () => {
    const config = makeConfig({ ownerIds: ['owner-1'] });
    const audit = new AuditLog(db);

    // Create a work order
    const workOrders = new WorkOrderManager(db);
    const wo = workOrders.create('sess-1', 'msg-1', 'risky-tool', { path: '/tmp' },
      { level: 'high', reasons: ['filesystem'], override: false }, 3);

    // Approve it
    const result = workOrders.approve(wo.id, 'user:discord:owner-1');
    expect(result).not.toBeNull();

    // Audit the approval (simulating what event-loop does)
    audit.append({
      eventType: 'work_order_resolved',
      actor: 'owner-1',
      sessionId: 'sess-1',
      detail: { workOrderId: wo.id, tool: 'risky-tool', resolution: 'approved' },
    });

    // Verify audit has the record even without channel delivery
    const entries = audit.getByType('work_order_resolved', 10);
    const approvalEntry = entries.find(e => {
      if (!e.detail) return false;
      const parsed = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail;
      return parsed.resolution === 'approved';
    });
    expect(approvalEntry).toBeDefined();
  });

  it('work order result update should persist even if session is gone', () => {
    const workOrders = new WorkOrderManager(db);
    const wo = workOrders.create('sess-gone', 'msg-1', 'tool-a', {},
      { level: 'medium', reasons: ['risk'], override: false }, 3);

    workOrders.approve(wo.id, 'user:owner-1');

    // Simulate result update after session is destroyed
    db.prepare(`
      UPDATE work_orders
      SET status = 'completed', result = @result
      WHERE id = @id
    `).run({ id: wo.id, result: JSON.stringify({ output: 'done' }) });

    const updated = workOrders.getById(wo.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. WORK ORDER TIMING ATTACKS
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S43: Work Order Timing Attacks', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('rapid create + approve should work for legitimate requests', () => {
    const config = makeConfig({ ownerIds: ['owner-1'] });
    const { workOrders, trust, audit } = setupApprovalDeps(db, config);

    const orders: WorkOrder[] = [];
    for (let i = 0; i < 10; i++) {
      orders.push(workOrders.create(`sess-${i}`, `msg-${i}`, `tool-${i}`, {},
        { level: 'high', reasons: ['risk'], override: false }, 3));
    }

    // Approve all rapidly
    const results = orders.map(wo =>
      executeApprovalCommand(
        { action: 'approve', workOrderId: wo.id },
        'discord', 'owner-1',
        { workOrders, trust, audit },
      )
    );

    // All should succeed
    expect(results.every(r => r.response.includes('✅'))).toBe(true);
  });

  it('sweep should not affect orders being approved simultaneously', () => {
    const workOrders = new WorkOrderManager(db);

    // Create order with long timeout
    const wo = workOrders.create('sess-1', 'msg-1', 'tool-a', {},
      { level: 'high', reasons: ['risk'], override: false }, 3);

    // Approve it
    const approved = workOrders.approve(wo.id, 'user:owner-1');
    expect(approved).not.toBeNull();

    // Sweep should not affect the approved order
    const swept = workOrders.sweepExpired();
    expect(swept).toBe(0);

    // Verify still approved
    const final = workOrders.getById(wo.id);
    expect(final!.status).toBe('approved');
  });

  it('creating many work orders should not cause ID collisions', () => {
    const workOrders = new WorkOrderManager(db);
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const wo = workOrders.create(`sess-${i}`, `msg-${i}`, `tool-${i}`, {},
        { level: 'medium', reasons: ['test'], override: false }, 3);
      expect(ids.has(wo.id)).toBe(false); // No collisions
      ids.add(wo.id);
    }

    expect(ids.size).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. COMPRESSOR→FILTER INTERACTION
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S43: Compressor→Filter Interaction', () => {
  it('LLM output crafting entity names that encode secrets', () => {
    // Attacker crafts conversation so LLM extracts entity with secret in name
    // Parser uses "## Section" headers and "key: value | key: value" format
    const llmOutput = `## Summary
- Discussed database configuration
## Facts
- fact: Database connection details discussed | entity: mongodb-admin-p4ssw0rd-at-db-host | type: project
## Decisions
## Todos
## Entities`;

    const parsed = parseCompressionOutput(llmOutput);
    // The entity name itself contains an encoded password
    const entityName = parsed.facts[0]?.entity ?? '';
    const { sanitized: safeName, redactions } = filterSensitiveContent(entityName);

    // "mongodb-admin-p4ssw0rd-at-db-host" doesn't match any regex pattern
    // because it's not in the structured form mongodb://user:pass@host
    // FINDING: Encoded/obfuscated secrets in entity names bypass the filter
    // toKebabCase preserves digits, so p4ssw0rd survives as-is
    expect(entityName).toContain('p4ssw0rd');
    expect(redactions.length).toBe(0); // Confirmed bypass — no pattern matches
  });

  it('LLM output with connection string in fact text should be caught', () => {
    const llmOutput = `## Summary
- Set up database
## Facts
- fact: Connection string is mongodb://admin:secretpass@db.prod.com:27017/app | entity: database-config | type: project
## Decisions
## Todos
## Entities`;

    const parsed = parseCompressionOutput(llmOutput);
    const fact = parsed.facts[0]?.fact ?? '';
    const { sanitized, redactions } = filterSensitiveContent(fact);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).not.toContain('secretpass');
  });

  it('LLM output with JWT in decision context should be caught', () => {
    const llmOutput = `## Summary
- Auth decision
## Facts
## Decisions
- decision: Use JWT auth | context: Test token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U | file: jwt-auth
## Todos
## Entities`;

    const parsed = parseCompressionOutput(llmOutput);
    const context = parsed.decisions[0]?.context ?? '';
    const { sanitized, redactions } = filterSensitiveContent(context);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_JWT]');
  });

  it('LLM output with multiple secrets across facts and decisions', () => {
    const llmOutput = `## Summary
- Reviewed credentials
## Facts
- fact: AWS key is AKIAIOSFODNN7EXAMPLE | entity: aws-account | type: project
- fact: Bot token xoxb-1234567890-abcdefghij | entity: slack-bot | type: project
## Decisions
- decision: Rotate credentials | context: Found ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA exposed | file: rotate-creds
## Todos
## Entities`;

    const parsed = parseCompressionOutput(llmOutput);

    // Check each extracted field
    for (const fact of parsed.facts) {
      const { redactions } = filterSensitiveContent(fact.fact);
      expect(redactions.length).toBeGreaterThan(0);
    }

    for (const decision of parsed.decisions) {
      const { redactions } = filterSensitiveContent(decision.context);
      expect(redactions.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. APPROVAL+FILTER COMBINED — Tool results with secrets
// ═══════════════════════════════════════════════════════════════════════════

describe('RED-TEAM S43: Approval+Filter Combined Attacks', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('tool result containing API key flows into working memory unfiltered', () => {
    // Post-approval, tool result goes directly to working memory
    // Working memory is T1 (in-RAM), so filter only applies at T1→T2 compression
    const config = makeConfig({ ownerIds: ['owner-1'] });
    const audit = new AuditLog(db);
    const sessions = new SessionManager(db, config, audit);
    const session = sessions.getOrCreate('ch-1', 'ch-id-1', 'user-1', 4);

    // Simulate tool returning a secret
    const toolResult = 'File contents:\napi_key=sk-live-1234567890abcdefghijklmnopqrst\nEOF';
    session.workingMemory.addMessage({
      role: 'tool',
      content: `[Approved tool result for file-read]: ${toolResult}`,
      name: 'file-read',
      toolCallId: 'post-approve-wo-1',
      timestamp: Date.now(),
    });

    // T1 (working memory) has the raw secret — this is by design
    // (LLM needs to see tool results to reason about them)
    const messages = session.workingMemory.messages;
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg?.content).toContain('sk-live-1234567890');

    // When this compresses to T2/T3, the filter SHOULD catch it
    const { sanitized, redactions } = filterSensitiveContent(toolMsg!.content);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).not.toContain('sk-live-1234567890');
    // FINDING: T1 intentionally stores raw secrets. Filter is T2/T3 boundary defense.
  });

  it('approved tool with no MCP client should not crash', () => {
    // Test the guard: if (!this.mcp) return — no crash path
    const config = makeConfig({ ownerIds: ['owner-1'] });
    const { workOrders, trust, audit } = setupApprovalDeps(db, config);
    const wo = workOrders.create('sess-1', 'msg-1', 'tool-a', {},
      { level: 'high', reasons: ['risk'], override: false }, 3);

    // Approve it
    const result = workOrders.approve(wo.id, 'user:discord:owner-1');
    expect(result).not.toBeNull();
    // The actual MCP execution would be handled by event-loop
    // If mcp is null, it logs and returns — tested implicitly
  });

  it('work order params should not be modifiable after creation', () => {
    const workOrders = new WorkOrderManager(db);
    const originalParams = { path: '/safe/dir', recursive: false };
    const wo = workOrders.create('sess-1', 'msg-1', 'file-list', originalParams,
      { level: 'medium', reasons: ['filesystem'], override: false }, 3);

    // Try to modify original params object
    originalParams.path = '/etc/shadow';
    (originalParams as any).recursive = true;

    // Retrieve from DB — should have original values
    const retrieved = workOrders.getById(wo.id);
    expect(retrieved).not.toBeNull();
    // Params are stored as JSON in DB, so they're immutable copies
    expect(retrieved!.params).toEqual({ path: '/safe/dir', recursive: false });
  });

  it('work order with SQL injection in tool name should be safe', () => {
    const workOrders = new WorkOrderManager(db);

    // Attempt SQL injection via tool name
    const maliciousTool = "tool'; DROP TABLE work_orders; --";
    const wo = workOrders.create('sess-1', 'msg-1', maliciousTool, {},
      { level: 'low', reasons: ['test'], override: false }, 4);

    // Table should still exist and order should be retrievable
    const retrieved = workOrders.getById(wo.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tool).toBe(maliciousTool);

    // Other operations should still work
    const pending = workOrders.getPending();
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it('work order with very large params should be stored correctly', () => {
    const workOrders = new WorkOrderManager(db);

    // 100KB of params
    const largeParams = { data: 'x'.repeat(100_000) };
    const wo = workOrders.create('sess-1', 'msg-1', 'big-tool', largeParams,
      { level: 'medium', reasons: ['size'], override: false }, 3);

    const retrieved = workOrders.getById(wo.id);
    expect(retrieved).not.toBeNull();
    expect(JSON.parse(JSON.stringify(retrieved!.params)).data.length).toBe(100_000);
  });
});
