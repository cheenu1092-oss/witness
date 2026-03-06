/**
 * SessionIdleTimer — Proactive session idle detection and compression.
 *
 * Instead of only checking for stale sessions during maintain() (which only
 * runs after a message is processed), this timer runs on a fixed interval
 * to detect and compress idle sessions even when no messages are arriving.
 *
 * Features:
 * - Configurable check interval (default: 60s)
 * - Calls back with each idle session for T1→T2 compression
 * - Audits idle transitions
 * - Clean start/stop lifecycle
 * - Guards against concurrent runs (debounce)
 */

import { createLogger } from './log.js';
import type { SessionManager, Session } from './session.js';
import type { AuditLog } from '../audit/store.js';
import type { Compressor } from './compressor.js';

const log = createLogger('idle-timer');

export interface IdleTimerConfig {
  /** Minutes of inactivity before a session is considered idle */
  sessionIdleMinutes: number;
  /** How often to check for idle sessions, in milliseconds */
  checkIntervalMs?: number;
}

export interface IdleTimerDeps {
  sessions: SessionManager;
  audit: AuditLog;
  compressor: Compressor | null;
}

/**
 * SessionIdleTimer — periodic check for idle sessions.
 *
 * Runs independently of the message processing loop.
 * On each tick:
 * 1. Find sessions idle longer than threshold
 * 2. Close them (via SessionManager.closeStale)
 * 3. Compress their T1→T2 (via Compressor)
 * 4. Audit the transition
 */
export class SessionIdleTimer {
  private config: IdleTimerConfig;
  private deps: IdleTimerDeps;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processing = false; // debounce guard

  // Stats
  private _totalChecks = 0;
  private _totalClosed = 0;
  private _totalCompressed = 0;
  private _lastCheckAt = 0;

  constructor(config: IdleTimerConfig, deps: IdleTimerDeps) {
    this.config = config;
    this.deps = deps;
  }

  /** Start the periodic idle check. */
  start(): void {
    if (this.running) return;

    const intervalMs = this.config.checkIntervalMs ?? 60_000;
    this.running = true;

    log.info('Idle timer started', {
      sessionIdleMinutes: this.config.sessionIdleMinutes,
      checkIntervalMs: intervalMs,
    });

    this.interval = setInterval(() => {
      this.check().catch((err) => {
        log.error('Idle timer check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
  }

  /** Stop the periodic idle check. */
  stop(): void {
    if (!this.running) return;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.running = false;
    log.info('Idle timer stopped', {
      totalChecks: this._totalChecks,
      totalClosed: this._totalClosed,
      totalCompressed: this._totalCompressed,
    });
  }

  /** Whether the timer is running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Stats for health checks. */
  get stats(): IdleTimerStats {
    return {
      running: this.running,
      totalChecks: this._totalChecks,
      totalClosed: this._totalClosed,
      totalCompressed: this._totalCompressed,
      lastCheckAt: this._lastCheckAt,
    };
  }

  /**
   * Perform one idle check cycle.
   * Exported for testing — normally called by the interval.
   */
  async check(): Promise<IdleCheckResult> {
    // Debounce: skip if already processing
    if (this.processing) {
      return { checked: false, closed: 0, compressed: 0, errors: 0 };
    }

    this.processing = true;
    this._totalChecks++;
    this._lastCheckAt = Date.now();

    let closed = 0;
    let compressed = 0;
    let errors = 0;

    try {
      // Get stale sessions and close them
      const staleSessions = this.deps.sessions.closeStale(
        this.config.sessionIdleMinutes,
      );

      if (staleSessions.length === 0) {
        return { checked: true, closed: 0, compressed: 0, errors: 0 };
      }

      closed = staleSessions.length;
      this._totalClosed += closed;

      log.info('Idle timer: closing stale sessions', { count: closed });

      // Compress each session's T1→T2
      if (this.deps.compressor) {
        for (const session of staleSessions) {
          if (session.workingMemory.messageCount < 2) continue;

          try {
            await this.deps.compressor.compress(
              session.workingMemory,
              session.id,
              'idle',
            );
            compressed++;
            this._totalCompressed++;
          } catch (err) {
            errors++;
            log.warn('Idle compression failed', {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Audit the idle sweep
      this.deps.audit.append({
        eventType: 'session_idle',
        actor: 'ved:idle-timer',
        detail: {
          action: 'sweep',
          closed,
          compressed,
          errors,
          sessionIds: staleSessions.map((s: Session) => s.id),
        },
      });

      return { checked: true, closed, compressed, errors };
    } finally {
      this.processing = false;
    }
  }
}

// === Types ===

export interface IdleCheckResult {
  checked: boolean;
  closed: number;
  compressed: number;
  errors: number;
}

export interface IdleTimerStats {
  running: boolean;
  totalChecks: number;
  totalClosed: number;
  totalCompressed: number;
  lastCheckAt: number;
}
