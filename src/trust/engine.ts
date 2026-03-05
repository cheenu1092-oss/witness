/**
 * TrustEngine — resolves trust tiers and assesses tool call risk.
 *
 * Trust resolution order:
 * 1. Runtime trust_ledger table (grants/revocations via grantTrust/revokeTrust)
 * 2. Config lists: ownerIds (tier 4), tribeIds (tier 3), knownIds (tier 2)
 * 3. Config defaultTier (fallback)
 *
 * Risk assessment:
 * - Base risk by tool name (static map + unknown=medium default)
 * - Param-aware escalation (destructive commands, sensitive files, etc.)
 * - Server trust floor: escalates minimum tier needed
 *
 * Auto-approve decision:
 * - Trust × Risk matrix from TRUST_RISK_MATRIX constant
 */

import Database from 'better-sqlite3';
import { vedUlid } from '../types/ulid.js';
import {
  TrustTier,
  RiskLevel,
  TrustConfig,
  RiskAssessment,
  TRUST_RISK_MATRIX,
  TrustDecision,
} from '../types/index.js';

// ── Base risk levels by tool name ──

const BASE_RISK: Record<string, RiskLevel> = {
  // Read-only: low
  read: 'low',
  Read: 'low',
  list: 'low',
  search: 'low',
  web_search: 'low',
  web_fetch: 'low',
  memory_search: 'low',
  memory_get: 'low',
  session_status: 'low',
  sessions_list: 'low',

  // Write operations: medium
  write: 'medium',
  Write: 'medium',
  edit: 'medium',
  Edit: 'medium',
  create: 'medium',
  update: 'medium',
  message: 'medium',
  browser: 'medium',

  // Code/process execution: high
  exec: 'high',
  execute: 'high',
  run: 'high',
  process: 'high',
  bash: 'high',
  shell: 'high',
};

// ── Param escalation rules ──

type ParamEscalator = (
  params: Record<string, unknown>,
  reasons: string[],
) => RiskLevel | undefined;

const PARAM_ESCALATORS: Record<string, ParamEscalator[]> = {
  exec: [
    (p, reasons) => {
      const cmd = String(p['command'] ?? '');
      if (/\brm\s+-rf?\b|\brm\b.*-r/i.test(cmd) || /\bmkfs\b|\bdd\b.*\bof=/i.test(cmd)) {
        reasons.push('Destructive shell command detected');
        return 'critical';
      }
      return undefined;
    },
    (p, reasons) => {
      const cmd = String(p['command'] ?? '');
      if (/\bsudo\b/i.test(cmd) || p['elevated'] === true) {
        reasons.push('Elevated/sudo execution');
        return 'high';
      }
      return undefined;
    },
    (p, reasons) => {
      const cmd = String(p['command'] ?? '');
      if (/\bcurl\b|\bwget\b|\bgit\s+clone\b/i.test(cmd)) {
        reasons.push('Network-fetching command');
        return 'medium';
      }
      return undefined;
    },
  ],
  Write: [
    (p, reasons) => {
      const path = String(p['file_path'] ?? p['path'] ?? '');
      if (/\.(env|key|pem|crt|p12|pfx|jks)$/i.test(path) || /\.ssh\//i.test(path)) {
        reasons.push('Writing to sensitive file');
        return 'critical';
      }
      return undefined;
    },
  ],
  Edit: [
    (p, reasons) => {
      const path = String(p['file_path'] ?? p['path'] ?? '');
      if (/\.(env|key|pem|crt|p12|pfx|jks)$/i.test(path) || /\.ssh\//i.test(path)) {
        reasons.push('Editing sensitive file');
        return 'critical';
      }
      return undefined;
    },
  ],
};

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0, medium: 1, high: 2, critical: 3,
};

function escalate(current: RiskLevel, min: RiskLevel): RiskLevel {
  return RISK_ORDER[current] >= RISK_ORDER[min] ? current : min;
}

// ── Trust ledger row type ──

interface TrustLedgerRow {
  trust_tier: number;
}

/**
 * TrustEngine resolves trust tiers and assesses risk for tool calls.
 */
export class TrustEngine {
  private config: TrustConfig;

  private stmtGetTrust: Database.Statement;
  private stmtInsertTrust: Database.Statement;
  private stmtRevokeTrust: Database.Statement;

  constructor(db: Database.Database, config: TrustConfig) {
    this.config = config;

    this.stmtGetTrust = db.prepare(`
      SELECT trust_tier FROM trust_ledger
      WHERE channel = @channel AND user_id = @userId AND revoked_at IS NULL
      ORDER BY granted_at DESC
      LIMIT 1
    `);

    this.stmtInsertTrust = db.prepare(`
      INSERT INTO trust_ledger (id, channel, user_id, user_name, trust_tier, granted_by, granted_at, reason)
      VALUES (@id, @channel, @userId, @userName, @trustTier, @grantedBy, @grantedAt, @reason)
    `);

    this.stmtRevokeTrust = db.prepare(`
      UPDATE trust_ledger
      SET revoked_at = @revokedAt
      WHERE channel = @channel AND user_id = @userId AND revoked_at IS NULL
    `);
  }

  /**
   * Resolve the trust tier for a user on a channel.
   *
   * Checks in order:
   * 1. trust_ledger table (runtime grants/revocations)
   * 2. config.ownerIds → tier 4
   * 3. config.tribeIds → tier 3
   * 4. config.knownIds → tier 2
   * 5. config.defaultTier (fallback)
   */
  resolveTier(channel: string, userId: string): TrustTier {
    // Check runtime trust_ledger first
    const row = this.stmtGetTrust.get({ channel, userId }) as TrustLedgerRow | undefined;
    if (row) {
      return row.trust_tier as TrustTier;
    }

    // Check config lists
    if (this.config.ownerIds.includes(userId)) return 4;
    if (this.config.tribeIds.includes(userId)) return 3;
    if (this.config.knownIds.includes(userId)) return 2;

    return this.config.defaultTier;
  }

  /**
   * Assess the risk level of a tool call.
   *
   * @param toolName MCP tool name
   * @param params Tool call parameters
   * @param serverTrustFloor Optional minimum risk level from MCP server config
   */
  assessRisk(
    toolName: string,
    params: Record<string, unknown>,
    serverTrustFloor?: number,
  ): RiskAssessment {
    const reasons: string[] = [];

    // Base risk: check normalized name
    const normalized = toolName.toLowerCase();
    let level: RiskLevel =
      BASE_RISK[toolName] ?? BASE_RISK[normalized] ?? 'medium';

    if (!(toolName in BASE_RISK) && !(normalized in BASE_RISK)) {
      reasons.push(`Unknown tool '${toolName}' — defaulting to medium risk`);
    }

    // Apply param escalation rules
    const capitalized = toolName.charAt(0).toUpperCase() + toolName.slice(1);
    const escalators =
      PARAM_ESCALATORS[toolName] ??
      PARAM_ESCALATORS[normalized] ??
      PARAM_ESCALATORS[capitalized];

    if (escalators) {
      for (const rule of escalators) {
        const escalated = rule(params, reasons);
        if (escalated) {
          level = escalate(level, escalated);
        }
      }
    }

    // Apply server trust floor escalation
    if (serverTrustFloor !== undefined && serverTrustFloor >= 3) {
      level = escalate(level, 'medium');
      reasons.push(`Server trust floor ${serverTrustFloor} applied`);
    }

    if (reasons.length === 0) {
      reasons.push(`Default risk level for '${toolName}'`);
    }

    return { level, reasons };
  }

  /**
   * Determine if a tool call should be auto-approved given trust tier and risk level.
   * Uses the TRUST_RISK_MATRIX.
   *
   * @returns true if 'auto' (execute immediately), false if 'approve' or 'deny'
   */
  shouldAutoApprove(tier: TrustTier, riskLevel: RiskLevel): boolean {
    const decision: TrustDecision = TRUST_RISK_MATRIX[tier][riskLevel];
    return decision === 'auto';
  }

  /**
   * Get the full trust decision (auto/approve/deny) for a tier+risk combination.
   */
  getTrustDecision(tier: TrustTier, riskLevel: RiskLevel): TrustDecision {
    return TRUST_RISK_MATRIX[tier][riskLevel];
  }

  /**
   * Grant a trust tier to a user on a channel.
   * Revokes any existing active trust entry first.
   */
  grantTrust(
    channel: string,
    userId: string,
    tier: TrustTier,
    grantedBy: string,
    reason = '',
  ): void {
    const now = Date.now();
    // Revoke existing active entry
    this.stmtRevokeTrust.run({ channel, userId, revokedAt: now });
    // Insert new entry
    this.stmtInsertTrust.run({
      id: vedUlid(),
      channel,
      userId,
      userName: '',
      trustTier: tier,
      grantedBy,
      grantedAt: now,
      reason,
    });
  }

  /**
   * Revoke all active trust entries for a user on a channel.
   * After revocation, the user falls back to config-based tier resolution.
   */
  revokeTrust(channel: string, userId: string, _revokedBy: string, _reason = ''): void {
    this.stmtRevokeTrust.run({ channel, userId, revokedAt: Date.now() });
  }
}
