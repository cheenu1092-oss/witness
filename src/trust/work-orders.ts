/**
 * WorkOrderManager — HITL (Human-in-the-Loop) approval queue.
 *
 * When a tool call exceeds the auto-approve threshold for a user's trust tier,
 * it becomes a WorkOrder that requires explicit human approval before execution.
 *
 * Lifecycle: pending → approved | denied | expired | cancelled
 */

import Database from 'better-sqlite3';
import { vedUlid } from '../types/ulid.js';
import type { WorkOrder, RiskLevel, TrustTier, ActionStatus } from '../types/index.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface WorkOrderRow {
  id: string;
  session_id: string;
  message_id: string;
  tool_name: string;
  tool_server: string;
  params: string;
  risk_level: string;
  risk_reasons: string;
  trust_tier: number;
  status: string;
  result: string | null;
  error: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  audit_id: string | null;
}

function rowToWorkOrder(row: WorkOrderRow): WorkOrder {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    tool: row.tool_name,
    toolServer: row.tool_server,
    params: JSON.parse(row.params) as Record<string, unknown>,
    riskLevel: row.risk_level as RiskLevel,
    riskReasons: JSON.parse(row.risk_reasons) as string[],
    trustTier: row.trust_tier as TrustTier,
    status: row.status as ActionStatus,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    auditId: row.audit_id ?? undefined,
  };
}

/**
 * Manages work orders for human-in-the-loop approval of high-risk tool calls.
 */
export class WorkOrderManager {
  private timeoutMs: number;

  private stmtInsert: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtGetPending: Database.Statement;
  private stmtGetPendingBySession: Database.Statement;
  private stmtApprove: Database.Statement;
  private stmtDeny: Database.Statement;
  private stmtExpire: Database.Statement;

  /**
   * @param db Database connection
   * @param timeoutMs Work order timeout in milliseconds (default: 5 minutes)
   */
  constructor(db: Database.Database, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;

    this.stmtInsert = db.prepare(`
      INSERT INTO work_orders (
        id, session_id, message_id, tool_name, tool_server, params,
        risk_level, risk_reasons, trust_tier, status, created_at, expires_at
      ) VALUES (
        @id, @sessionId, @messageId, @toolName, @toolServer, @params,
        @riskLevel, @riskReasons, @trustTier, 'pending', @createdAt, @expiresAt
      )
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM work_orders WHERE id = ?
    `);

    this.stmtGetPending = db.prepare(`
      SELECT * FROM work_orders WHERE status = 'pending'
      ORDER BY created_at ASC
    `);

    this.stmtGetPendingBySession = db.prepare(`
      SELECT * FROM work_orders WHERE status = 'pending' AND session_id = ?
      ORDER BY created_at ASC
    `);

    this.stmtApprove = db.prepare(`
      UPDATE work_orders
      SET status = 'approved', resolved_at = @resolvedAt, resolved_by = @resolvedBy
      WHERE id = @id AND status = 'pending'
    `);

    this.stmtDeny = db.prepare(`
      UPDATE work_orders
      SET status = 'denied', resolved_at = @resolvedAt, resolved_by = @resolvedBy
      WHERE id = @id AND status = 'pending'
    `);

    this.stmtExpire = db.prepare(`
      UPDATE work_orders
      SET status = 'expired', resolved_at = @now, resolved_by = 'system:timeout'
      WHERE status = 'pending' AND expires_at <= @now
    `);
  }

  /**
   * Create a new work order for a tool call that needs human approval.
   *
   * @param sessionId Session that triggered this
   * @param messageId Inbox message that triggered this
   * @param tool MCP tool name
   * @param params Tool call parameters
   * @param risk Risk assessment result
   * @param tier Trust tier of the requester
   * @returns The created WorkOrder
   */
  create(
    sessionId: string,
    messageId: string,
    tool: string,
    params: Record<string, unknown>,
    risk: { level: RiskLevel; reasons: string[] },
    tier: TrustTier,
    toolServer = '',
  ): WorkOrder {
    const id = vedUlid();
    const now = Date.now();

    this.stmtInsert.run({
      id,
      sessionId,
      messageId,
      toolName: tool,
      toolServer,
      params: JSON.stringify(params),
      riskLevel: risk.level,
      riskReasons: JSON.stringify(risk.reasons),
      trustTier: tier,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    });

    return this.getById(id)!;
  }

  /**
   * Approve a pending work order.
   *
   * @param id Work order ID
   * @param approvedBy Who approved it (e.g. 'user:discord:123')
   * @returns Updated WorkOrder, or null if not found / not pending
   */
  approve(id: string, approvedBy: string): WorkOrder | null {
    const result = this.stmtApprove.run({
      id,
      resolvedAt: Date.now(),
      resolvedBy: approvedBy,
    });
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  /**
   * Deny a pending work order.
   *
   * @param id Work order ID
   * @param deniedBy Who denied it
   * @returns Updated WorkOrder, or null if not found / not pending
   */
  deny(id: string, deniedBy: string): WorkOrder | null {
    const result = this.stmtDeny.run({
      id,
      resolvedAt: Date.now(),
      resolvedBy: deniedBy,
    });
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  /**
   * Get all pending work orders.
   * @param sessionId Optional: filter to a specific session
   */
  getPending(sessionId?: string): WorkOrder[] {
    if (sessionId) {
      return (this.stmtGetPendingBySession.all(sessionId) as WorkOrderRow[]).map(rowToWorkOrder);
    }
    return (this.stmtGetPending.all() as WorkOrderRow[]).map(rowToWorkOrder);
  }

  /**
   * Expire all pending work orders past their deadline.
   * @returns Number of work orders expired
   */
  sweepExpired(): number {
    const now = Date.now();
    const result = this.stmtExpire.run({ now });
    return result.changes;
  }

  /**
   * Get a work order by ID.
   * @returns WorkOrder or null if not found
   */
  getById(id: string): WorkOrder | null {
    const row = this.stmtGetById.get(id) as WorkOrderRow | undefined;
    return row ? rowToWorkOrder(row) : null;
  }
}
