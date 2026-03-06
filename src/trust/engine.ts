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
    // GAP-1 fix: executable scripts are high-risk writes
    (p, reasons) => {
      const path = String(p['file_path'] ?? p['path'] ?? '');
      if (/\.(sh|bat|ps1|cmd|bash|zsh)$/i.test(path)) {
        reasons.push('Writing executable script file');
        return 'high';
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
    // GAP-1 fix: executable scripts are high-risk edits
    (p, reasons) => {
      const path = String(p['file_path'] ?? p['path'] ?? '');
      if (/\.(sh|bat|ps1|cmd|bash|zsh)$/i.test(path)) {
        reasons.push('Editing executable script file');
        return 'high';
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
   * 1. Config lists for floor: ownerIds (tier 4), tribeIds (tier 3), knownIds (tier 2)
   * 2. Runtime trust_ledger table (can elevate above config, never below)
   * 3. Config defaultTier (fallback if no config match and no ledger entry)
   *
   * SECURITY (VULN-10): Config ownerIds are an immutable floor — the ledger
   * can only elevate above config tier, never downgrade below it.
   */
  resolveTier(channel: string, userId: string): TrustTier {
    // Determine config-based floor first
    let configTier: TrustTier = this.config.defaultTier;
    if (this.config.ownerIds.includes(userId)) configTier = 4;
    else if (this.config.tribeIds.includes(userId)) configTier = 3;
    else if (this.config.knownIds.includes(userId)) configTier = 2;

    // Check runtime trust_ledger
    const row = this.stmtGetTrust.get({ channel, userId }) as TrustLedgerRow | undefined;
    if (row) {
      const ledgerTier = row.trust_tier as TrustTier;
      // Ledger can only elevate above config, never below (VULN-10 fix)
      return Math.max(ledgerTier, configTier) as TrustTier;
    }

    return configTier;
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
   *
   * SECURITY (VULN-9): Only owners (tier 4 via config) can grant trust.
   * Prevents self-escalation via DB manipulation at the API level.
   *
   * @throws Error if grantedBy is not in config.ownerIds
   */
  grantTrust(
    channel: string,
    userId: string,
    tier: TrustTier,
    grantedBy: string,
    reason = '',
  ): void {
    // VULN-9 fix: validate that grantedBy is a config-level owner
    if (!this.config.ownerIds.includes(grantedBy)) {
      throw new Error(
        `Trust grant denied: '${grantedBy}' is not an authorized owner. ` +
        `Only config ownerIds can grant trust.`
      );
    }

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
