/**
 * ApprovalCommandParser — Parses and handles work order approval commands.
 *
 * Supports commands from any channel:
 *   - `approve <work-order-id>` — approve a pending work order
 *   - `deny <work-order-id>` [reason] — deny a pending work order
 *   - `pending` — list pending work orders (optionally filtered by session)
 *
 * Security:
 * - Only owner-tier (4) users can approve/deny work orders
 * - Non-owners get a clear denial message
 * - Expired/already-resolved work orders return an error
 *
 * Returns null if the message is NOT a command (pass through to LLM).
 */

import type { WorkOrderManager } from '../trust/work-orders.js';
import type { TrustEngine } from '../trust/engine.js';
import type { AuditLog } from '../audit/store.js';
import type { WorkOrder } from '../types/index.js';

// === Command types ===

export type ApprovalAction = 'approve' | 'deny' | 'pending';

export interface ParsedCommand {
  action: ApprovalAction;
  workOrderId?: string;
  reason?: string;
}

export interface CommandResult {
  handled: true;
  response: string;
}

export interface ApprovalParserDeps {
  workOrders: WorkOrderManager;
  trust: TrustEngine;
  audit: AuditLog;
  /** Optional callback invoked after a work order is approved. Receives the approved work order. */
  onApproved?: (workOrder: WorkOrder) => void;
}

// === Regex patterns ===

// Matches: approve <id>, deny <id> [reason], pending
const APPROVE_RE = /^\s*approve\s+(\S+)\s*$/i;
const DENY_RE = /^\s*deny\s+(\S+)(?:\s+(.+))?\s*$/i;
const PENDING_RE = /^\s*pending\s*$/i;

/**
 * Parse a message into an approval command, or return null if not a command.
 */
export function parseApprovalCommand(content: string): ParsedCommand | null {
  // VULN-16: Strip null bytes before parsing — \x00 matches \s in JS regex,
  // which could allow smuggled commands like "approve\x00WO-123"
  const sanitized = content.replace(/\0/g, '');
  const trimmed = sanitized.trim();
  if (!trimmed) return null;

  let match: RegExpMatchArray | null;

  match = trimmed.match(APPROVE_RE);
  if (match) {
    return { action: 'approve', workOrderId: match[1] };
  }

  match = trimmed.match(DENY_RE);
  if (match) {
    return { action: 'deny', workOrderId: match[1], reason: match[2]?.trim() };
  }

  match = trimmed.match(PENDING_RE);
  if (match) {
    return { action: 'pending' };
  }

  return null;
}

/**
 * Execute an approval command.
 *
 * @param command Parsed command (from parseApprovalCommand)
 * @param channel Channel the command came from
 * @param authorId User who issued the command
 * @param deps Dependencies (work orders, trust engine, audit)
 * @returns CommandResult with response text, or null if command is invalid
 */
export function executeApprovalCommand(
  command: ParsedCommand,
  channel: string,
  authorId: string,
  deps: ApprovalParserDeps,
): CommandResult {
  const { workOrders, trust, audit } = deps;

  switch (command.action) {
    case 'approve':
      return handleApprove(command.workOrderId!, channel, authorId, workOrders, trust, audit, deps.onApproved);

    case 'deny':
      return handleDeny(command.workOrderId!, channel, authorId, command.reason, workOrders, trust, audit);

    case 'pending':
      return handlePending(workOrders);
  }
}

// ── Handlers ──

function handleApprove(
  workOrderId: string,
  channel: string,
  authorId: string,
  workOrders: WorkOrderManager,
  trust: TrustEngine,
  audit: AuditLog,
  onApproved?: (workOrder: WorkOrder) => void,
): CommandResult {
  // Check authorization: only owners can approve
  const tier = trust.resolveTier(channel, authorId);
  if (tier < 4) {
    return {
      handled: true,
      response: `❌ Approval denied — only owners (tier 4) can approve work orders. Your tier: ${tier}`,
    };
  }

  // Try to approve
  const result = workOrders.approve(workOrderId, `user:${channel}:${authorId}`);
  if (!result) {
    // Check if it exists at all
    const existing = workOrders.getById(workOrderId);
    if (!existing) {
      return {
        handled: true,
        response: `❌ Work order \`${workOrderId}\` not found.`,
      };
    }
    // Exists but not pending (expired, already resolved, etc.)
    return {
      handled: true,
      response: `❌ Work order \`${workOrderId}\` cannot be approved — status: **${existing.status}**` +
        (existing.status === 'expired' ? ' (timed out)' : ''),
    };
  }

  // Audit the approval
  audit.append({
    eventType: 'work_order_resolved',
    actor: authorId,
    sessionId: result.sessionId,
    detail: {
      workOrderId: result.id,
      tool: result.tool,
      resolution: 'approved',
      resolvedBy: authorId,
      channel,
    },
  });

  // Trigger post-approval execution if callback provided
  if (onApproved) {
    onApproved(result);
  }

  return {
    handled: true,
    response: `✅ Approved work order \`${workOrderId}\` — tool \`${result.tool}\` executing...`,
  };
}

function handleDeny(
  workOrderId: string,
  channel: string,
  authorId: string,
  reason: string | undefined,
  workOrders: WorkOrderManager,
  trust: TrustEngine,
  audit: AuditLog,
): CommandResult {
  // Check authorization: only owners can deny
  const tier = trust.resolveTier(channel, authorId);
  if (tier < 4) {
    return {
      handled: true,
      response: `❌ Denial rejected — only owners (tier 4) can deny work orders. Your tier: ${tier}`,
    };
  }

  const result = workOrders.deny(workOrderId, `user:${channel}:${authorId}`);
  if (!result) {
    const existing = workOrders.getById(workOrderId);
    if (!existing) {
      return {
        handled: true,
        response: `❌ Work order \`${workOrderId}\` not found.`,
      };
    }
    return {
      handled: true,
      response: `❌ Work order \`${workOrderId}\` cannot be denied — status: **${existing.status}**` +
        (existing.status === 'expired' ? ' (timed out)' : ''),
    };
  }

  audit.append({
    eventType: 'work_order_resolved',
    actor: authorId,
    sessionId: result.sessionId,
    detail: {
      workOrderId: result.id,
      tool: result.tool,
      resolution: 'denied',
      resolvedBy: authorId,
      reason: reason ?? 'No reason given',
      channel,
    },
  });

  const reasonText = reason ? ` Reason: ${reason}` : '';
  return {
    handled: true,
    response: `🚫 Denied work order \`${workOrderId}\` — tool \`${result.tool}\` will NOT execute.${reasonText}`,
  };
}

function handlePending(workOrders: WorkOrderManager): CommandResult {
  const pending = workOrders.getPending();

  if (pending.length === 0) {
    return {
      handled: true,
      response: '📋 No pending work orders.',
    };
  }

  const lines = pending.map((wo: WorkOrder) => formatPendingWorkOrder(wo));
  const header = `📋 **${pending.length} pending work order${pending.length > 1 ? 's' : ''}:**\n`;

  return {
    handled: true,
    response: header + lines.join('\n'),
  };
}

/**
 * Format a single pending work order for display.
 */
function formatPendingWorkOrder(wo: WorkOrder): string {
  const expiresIn = Math.max(0, Math.round((wo.expiresAt - Date.now()) / 1000));
  const expiresText = expiresIn > 60
    ? `${Math.round(expiresIn / 60)}m`
    : `${expiresIn}s`;

  return [
    `• \`${wo.id}\` — **${wo.tool}**`,
    `  Risk: ${wo.riskLevel} | Tier: ${wo.trustTier} | Expires: ${expiresText}`,
  ].join('\n');
}

// Export for testing
export { formatPendingWorkOrder };
