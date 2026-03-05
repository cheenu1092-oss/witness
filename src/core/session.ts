/**
 * SessionManager — Manages conversation sessions backed by SQLite.
 *
 * Sessions track a conversation between a user (on a specific channel) and Ved.
 * Each session owns a WorkingMemory (T1) that persists to the sessions table.
 *
 * Lifecycle: active → idle → closed
 * - active: currently processing or recently active
 * - idle: no activity for sessionIdleMinutes
 * - closed: T1 flushed to T2, session archived
 */

import Database from 'better-sqlite3';
import { vedUlid } from '../types/ulid.js';
import { WorkingMemory } from './working-memory.js';
import { createLogger } from './log.js';
import type { AuditEntryInput, ChannelId, AuthorId, SessionStatus, TrustTier, VedId } from '../types/index.js';

const log = createLogger('session');

// === Session object ===

export interface Session {
  id: VedId;
  channel: ChannelId;
  channelId: string;       // channel-specific identifier (guild#channel, etc.)
  author: AuthorId;
  trustTier: TrustTier;
  startedAt: number;       // unix ms
  lastActive: number;      // unix ms
  status: SessionStatus;
  workingMemory: WorkingMemory;
}

// === Raw DB row ===

interface SessionRow {
  id: string;
  channel: string;
  channel_id: string;
  author_id: string;
  trust_tier: number;
  started_at: number;
  last_active: number;
  working_memory: string;
  token_count: number;
  status: string;
  closed_at: number | null;
  summary: string | null;
}

// === Manager options ===

export interface SessionManagerOptions {
  /** Working memory token budget per session */
  workingMemoryMaxTokens: number;
  /** Callback to log audit entries (injected to avoid circular dep) */
  onAudit?: (input: AuditEntryInput) => void;
}

/**
 * SessionManager — create, resume, persist, idle, and close sessions.
 */
export class SessionManager {
  private opts: SessionManagerOptions;

  // Prepared statements
  private stmtGetActive: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtInsert: Database.Statement;
  private stmtUpdateMemory: Database.Statement;
  private stmtMarkIdle: Database.Statement;
  private stmtClose: Database.Statement;
  private stmtCloseStale: Database.Statement;
  private stmtGetStale: Database.Statement;

  constructor(db: Database.Database, opts: SessionManagerOptions) {
    this.opts = opts;

    this.stmtGetActive = db.prepare(`
      SELECT * FROM sessions
      WHERE channel = @channel AND author_id = @authorId AND status IN ('active', 'idle')
      ORDER BY last_active DESC
      LIMIT 1
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    this.stmtInsert = db.prepare(`
      INSERT INTO sessions (id, channel, channel_id, author_id, trust_tier, started_at, last_active, working_memory, token_count, status)
      VALUES (@id, @channel, @channelId, @authorId, @trustTier, @startedAt, @lastActive, @workingMemory, @tokenCount, 'active')
    `);

    this.stmtUpdateMemory = db.prepare(`
      UPDATE sessions
      SET working_memory = @workingMemory, token_count = @tokenCount, last_active = @lastActive
      WHERE id = @id
    `);

    this.stmtMarkIdle = db.prepare(`
      UPDATE sessions SET status = 'idle' WHERE id = ? AND status = 'active'
    `);

    this.stmtClose = db.prepare(`
      UPDATE sessions
      SET status = 'closed', closed_at = @closedAt, summary = @summary, working_memory = '{}'
      WHERE id = @id AND status IN ('active', 'idle')
    `);

    this.stmtCloseStale = db.prepare(`
      UPDATE sessions
      SET status = 'closed', closed_at = @now, working_memory = '{}'
      WHERE status IN ('active', 'idle') AND last_active < @cutoff
    `);

    this.stmtGetStale = db.prepare(`
      SELECT * FROM sessions
      WHERE status IN ('active', 'idle') AND last_active < @cutoff
    `);
  }

  /**
   * Get or create a session for a channel+author pair.
   * Resumes existing active/idle session if found, otherwise creates new.
   */
  getOrCreate(
    channel: ChannelId,
    channelId: string,
    authorId: AuthorId,
    trustTier: TrustTier = 1,
  ): Session {
    // Try to find existing active/idle session
    const row = this.stmtGetActive.get({ channel, authorId }) as SessionRow | undefined;

    if (row) {
      const session = this.rowToSession(row);
      // Re-activate if idle
      if (session.status === 'idle') {
        session.status = 'active';
        this.audit('session_start', authorId, session.id, { action: 'resumed' });
      }
      session.lastActive = Date.now();
      log.debug('Resumed session', { sessionId: session.id, channel, authorId });
      return session;
    }

    // Create new session
    const id = vedUlid();
    const now = Date.now();
    const wm = WorkingMemory.empty(this.opts.workingMemoryMaxTokens);

    this.stmtInsert.run({
      id,
      channel,
      channelId,
      authorId,
      trustTier,
      startedAt: now,
      lastActive: now,
      workingMemory: wm.serialize(),
      tokenCount: 0,
    });

    this.audit('session_start', authorId, id, { action: 'created', channel });
    log.info('Created session', { sessionId: id, channel, authorId });

    return {
      id,
      channel,
      channelId,
      author: authorId,
      trustTier,
      startedAt: now,
      lastActive: now,
      status: 'active',
      workingMemory: wm,
    };
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: VedId): Session | null {
    const row = this.stmtGetById.get(sessionId) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Persist the working memory state to SQLite.
   * Call after every message processing cycle.
   */
  persist(session: Session): void {
    this.stmtUpdateMemory.run({
      id: session.id,
      workingMemory: session.workingMemory.serialize(),
      tokenCount: session.workingMemory.tokenCount,
      lastActive: Date.now(),
    });
  }

  /**
   * Mark a session as idle (no recent activity).
   * Idle sessions can still be resumed.
   */
  markIdle(sessionId: VedId): void {
    const result = this.stmtMarkIdle.run(sessionId);
    if (result.changes > 0) {
      this.audit('session_idle', 'ved', sessionId, {});
      log.debug('Session marked idle', { sessionId });
    }
  }

  /**
   * Close a session. Clears working memory from DB.
   * @param sessionId Session to close
   * @param summary Optional summary of the conversation (for episodic memory)
   */
  close(sessionId: VedId, summary?: string): void {
    const result = this.stmtClose.run({
      id: sessionId,
      closedAt: Date.now(),
      summary: summary ?? null,
    });
    if (result.changes > 0) {
      this.audit('session_close', 'ved', sessionId, { summary: summary ?? null });
      log.info('Session closed', { sessionId });
    }
  }

  /**
   * Close all sessions that have been idle longer than the given threshold.
   * @param idleMinutes Minutes of inactivity before closing
   * @returns List of sessions that were closed (for T1→T2 flushing)
   */
  closeStale(idleMinutes: number): Session[] {
    const cutoff = Date.now() - idleMinutes * 60 * 1000;

    // Get stale sessions first (for returning to caller for T1→T2 flush)
    const staleRows = this.stmtGetStale.all({ cutoff }) as SessionRow[];
    const staleSessions = staleRows.map(r => this.rowToSession(r));

    // Close them
    const result = this.stmtCloseStale.run({ now: Date.now(), cutoff });
    if (result.changes > 0) {
      log.info('Closed stale sessions', { count: result.changes, idleMinutes });
    }

    return staleSessions;
  }

  // === Internal ===

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      channel: row.channel as ChannelId,
      channelId: row.channel_id,
      author: row.author_id,
      trustTier: row.trust_tier as TrustTier,
      startedAt: row.started_at,
      lastActive: row.last_active,
      status: row.status as SessionStatus,
      workingMemory: WorkingMemory.deserialize(
        row.working_memory,
        this.opts.workingMemoryMaxTokens,
      ),
    };
  }

  private audit(eventType: AuditEntryInput['eventType'], actor: string, sessionId: string, detail: Record<string, unknown>): void {
    if (this.opts.onAudit) {
      this.opts.onAudit({ eventType, actor, sessionId, detail });
    }
  }
}
