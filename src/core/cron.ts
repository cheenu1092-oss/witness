/**
 * CronScheduler — Scheduled job engine for Ved.
 *
 * Features:
 * - Standard 5-field cron expressions (min hour dom month dow)
 * - Built-in job types: backup, reindex, doctor
 * - Custom command jobs (injected as messages)
 * - SQLite-backed persistence (cron_jobs table)
 * - Audit-logged execution
 * - Manual trigger support
 *
 * Runs as part of the EventLoop's tick cycle — no separate timers needed.
 */

import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { createLogger } from './log.js';
import type { AuditEventType } from '../types/index.js';

const log = createLogger('cron');

// ── Types ──

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  jobType: string;       // 'backup' | 'reindex' | 'doctor' | 'custom'
  jobConfig: string;     // JSON config for the job type
  enabled: boolean;
  lastRun: number | null;
  lastResult: string | null;   // 'success' | 'error' | null
  lastError: string | null;
  nextRun: number | null;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CronJobInput {
  name: string;
  schedule: string;
  jobType: string;
  jobConfig?: Record<string, unknown>;
  enabled?: boolean;
}

export interface CronRunResult {
  jobId: string;
  jobName: string;
  jobType: string;
  success: boolean;
  message: string;
  durationMs: number;
  error?: string;
}

export type CronJobExecutor = (job: CronJob) => Promise<CronRunResult>;

// ── Cron Expression Parser ──

/**
 * Parse a 5-field cron expression into expanded sets of valid values.
 *
 * Fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6, 0=Sun)
 *
 * Supports: *, ranges (1-5), steps (*​/15, 1-10/2), lists (1,3,5)
 * Special: @hourly, @daily, @weekly, @monthly
 */
export function parseCronExpression(expr: string): {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
} {
  // Handle shorthand aliases
  const aliases: Record<string, string> = {
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
    '@monthly': '0 0 1 * *',
    '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@hourly': '0 * * * *',
  };

  const normalized = aliases[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = normalized.split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}" — expected 5 fields (min hour dom month dow), got ${parts.length}`);
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6),
  };
}

/**
 * Parse a single cron field into a set of valid values.
 * Supports: *, ranges (1-5), steps (*​/15, 1-10/2), lists (1,3,5)
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  // Handle comma-separated list
  const parts = field.split(',');

  for (const part of parts) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Step: */N or M-N/S
    const stepMatch = part.match(/^(\d+(?:-\d+)?|\*)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      if (step <= 0) throw new Error(`Invalid step value: ${step}`);

      let rangeStart = min;
      let rangeEnd = max;

      if (stepMatch[1] !== '*') {
        const rangeMatch = stepMatch[1].match(/^(\d+)(?:-(\d+))?$/);
        if (rangeMatch) {
          rangeStart = parseInt(rangeMatch[1], 10);
          if (rangeMatch[2]) rangeEnd = parseInt(rangeMatch[2], 10);
        }
      }

      for (let i = rangeStart; i <= rangeEnd; i += step) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    // Range: M-N
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) throw new Error(`Invalid range: ${start}-${end}`);
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    // Single value
    const val = parseInt(part, 10);
    if (isNaN(val) || val < min || val > max) {
      throw new Error(`Invalid cron value "${part}" — must be ${min}-${max}`);
    }
    values.add(val);
  }

  return values;
}

/**
 * Calculate the next run time from a cron expression, starting from `after`.
 * Returns epoch milliseconds, or null if no valid time found within 1 year.
 */
export function nextRunTime(expr: string, after: number = Date.now()): number | null {
  const parsed = parseCronExpression(expr);
  const maxIterations = 525960; // ~1 year of minutes
  const start = new Date(after);

  // Start from the next minute
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  for (let i = 0; i < maxIterations; i++) {
    const d = new Date(start.getTime() + i * 60_000);

    if (
      parsed.months.has(d.getMonth() + 1) &&
      parsed.daysOfMonth.has(d.getDate()) &&
      parsed.daysOfWeek.has(d.getDay()) &&
      parsed.hours.has(d.getHours()) &&
      parsed.minutes.has(d.getMinutes())
    ) {
      return d.getTime();
    }
  }

  return null;
}

// ── CronScheduler ──

export class CronScheduler {
  private executor: CronJobExecutor | null = null;
  private onAudit: ((input: { eventType: AuditEventType; actor: string; detail: Record<string, unknown> }) => void) | null = null;

  // Prepared statements
  private stmtList: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtGetByName: Database.Statement;
  private stmtInsert: Database.Statement;
  private stmtUpdateAfterRun: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtToggle: Database.Statement;
  private stmtDue: Database.Statement;
  private stmtUpdateNextRun: Database.Statement;
  private stmtUpdateResult: Database.Statement;
  private stmtInsertHistory: Database.Statement;
  private stmtListHistory: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtList = db.prepare(`
      SELECT id, name, schedule, channel as job_type, message as job_config,
             enabled, last_run, last_result, last_error, next_run, run_count, created_at, updated_at
      FROM cron_jobs ORDER BY name
    `);

    this.stmtGet = db.prepare(`
      SELECT id, name, schedule, channel as job_type, message as job_config,
             enabled, last_run, last_result, last_error, next_run, run_count, created_at, updated_at
      FROM cron_jobs WHERE id = ?
    `);

    this.stmtGetByName = db.prepare(`
      SELECT id, name, schedule, channel as job_type, message as job_config,
             enabled, last_run, last_result, last_error, next_run, run_count, created_at, updated_at
      FROM cron_jobs WHERE name = ?
    `);

    this.stmtInsert = db.prepare(`
      INSERT INTO cron_jobs (id, name, schedule, channel, message, enabled, next_run, run_count, created_at, updated_at)
      VALUES (@id, @name, @schedule, @jobType, @jobConfig, @enabled, @nextRun, 0, @now, @now)
    `);

    this.stmtUpdateAfterRun = db.prepare(`
      UPDATE cron_jobs
      SET last_run = @lastRun, next_run = @nextRun, run_count = run_count + 1, updated_at = @now
      WHERE id = @id
    `);

    this.stmtDelete = db.prepare(`
      DELETE FROM cron_jobs WHERE id = ?
    `);

    this.stmtToggle = db.prepare(`
      UPDATE cron_jobs SET enabled = @enabled, next_run = @nextRun, updated_at = @now WHERE id = @id
    `);

    this.stmtDue = db.prepare(`
      SELECT id, name, schedule, channel as job_type, message as job_config,
             enabled, last_run, last_result, last_error, next_run, run_count, created_at, updated_at
      FROM cron_jobs
      WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run ASC
    `);

    this.stmtUpdateNextRun = db.prepare(`
      UPDATE cron_jobs SET next_run = ?, updated_at = ? WHERE id = ?
    `);

    this.stmtUpdateResult = db.prepare(`
      UPDATE cron_jobs SET last_result = @lastResult, last_error = @lastError, updated_at = @now WHERE id = @id
    `);

    this.stmtInsertHistory = db.prepare(`
      INSERT INTO cron_history (id, job_id, job_name, job_type, started_at, finished_at, duration_ms, success, message, error)
      VALUES (@id, @jobId, @jobName, @jobType, @startedAt, @finishedAt, @durationMs, @success, @message, @error)
    `);

    this.stmtListHistory = db.prepare(`
      SELECT id, job_id, job_name, job_type, started_at, finished_at, duration_ms, success, message, error
      FROM cron_history
      WHERE (@jobName IS NULL OR job_name = @jobName)
      ORDER BY started_at DESC
      LIMIT @limit
    `);
  }

  /**
   * Set the executor function that runs jobs.
   */
  setExecutor(executor: CronJobExecutor): void {
    this.executor = executor;
  }

  /**
   * Set the audit callback.
   */
  setAudit(fn: (input: { eventType: AuditEventType; actor: string; detail: Record<string, unknown> }) => void): void {
    this.onAudit = fn;
  }

  /**
   * List all cron jobs.
   */
  list(): CronJob[] {
    const rows = this.stmtList.all() as RawCronRow[];
    return rows.map(rowToJob);
  }

  /**
   * Get a job by ID or name.
   */
  get(idOrName: string): CronJob | null {
    let row = this.stmtGet.get(idOrName) as RawCronRow | undefined;
    if (!row) row = this.stmtGetByName.get(idOrName) as RawCronRow | undefined;
    return row ? rowToJob(row) : null;
  }

  /**
   * Add a new cron job.
   * Validates the schedule and computes the first next_run.
   */
  add(input: CronJobInput): CronJob {
    // Validate cron expression (throws on invalid)
    parseCronExpression(input.schedule);

    // Check for duplicate name
    const existing = this.stmtGetByName.get(input.name) as RawCronRow | undefined;
    if (existing) {
      throw new Error(`Cron job "${input.name}" already exists`);
    }

    const now = Date.now();
    const id = ulid();
    const enabled = input.enabled !== false;
    const next = enabled ? nextRunTime(input.schedule, now) : null;

    this.stmtInsert.run({
      id,
      name: input.name,
      schedule: input.schedule,
      jobType: input.jobType,
      jobConfig: JSON.stringify(input.jobConfig ?? {}),
      enabled: enabled ? 1 : 0,
      nextRun: next,
      now,
    });

    if (this.onAudit) {
      this.onAudit({
        eventType: 'cron_job_created',
        actor: 'ved',
        detail: { jobId: id, name: input.name, schedule: input.schedule, jobType: input.jobType },
      });
    }

    log.info('Cron job created', { id, name: input.name, schedule: input.schedule, jobType: input.jobType, nextRun: next });

    return this.get(id)!;
  }

  /**
   * Remove a cron job by ID or name.
   */
  remove(idOrName: string): boolean {
    const job = this.get(idOrName);
    if (!job) return false;

    this.stmtDelete.run(job.id);

    if (this.onAudit) {
      this.onAudit({
        eventType: 'cron_job_removed',
        actor: 'ved',
        detail: { jobId: job.id, name: job.name },
      });
    }

    log.info('Cron job removed', { id: job.id, name: job.name });
    return true;
  }

  /**
   * Enable or disable a cron job.
   */
  toggle(idOrName: string, enabled: boolean): CronJob | null {
    const job = this.get(idOrName);
    if (!job) return null;

    const now = Date.now();
    const next = enabled ? nextRunTime(job.schedule, now) : null;

    this.stmtToggle.run({
      id: job.id,
      enabled: enabled ? 1 : 0,
      nextRun: next,
      now,
    });

    if (this.onAudit) {
      this.onAudit({
        eventType: enabled ? 'cron_job_enabled' : 'cron_job_disabled',
        actor: 'ved',
        detail: { jobId: job.id, name: job.name },
      });
    }

    log.info(enabled ? 'Cron job enabled' : 'Cron job disabled', { id: job.id, name: job.name });
    return this.get(job.id);
  }

  /**
   * Manually trigger a job immediately, regardless of schedule.
   */
  async runNow(idOrName: string): Promise<CronRunResult> {
    const job = this.get(idOrName);
    if (!job) {
      throw new Error(`Cron job "${idOrName}" not found`);
    }

    if (!this.executor) {
      throw new Error('No executor set — cannot run cron jobs');
    }

    return this.executeJob(job);
  }

  /**
   * Check for due jobs and execute them.
   * Called from EventLoop's tick cycle.
   * Returns the number of jobs executed.
   */
  async tick(now: number = Date.now()): Promise<number> {
    if (!this.executor) return 0;

    const dueRows = this.stmtDue.all(now) as RawCronRow[];
    if (dueRows.length === 0) return 0;

    let executed = 0;
    for (const row of dueRows) {
      const job = rowToJob(row);
      try {
        await this.executeJob(job);
        executed++;
      } catch (err) {
        log.error('Cron job execution failed', {
          jobId: job.id,
          name: job.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return executed;
  }

  /**
   * Get execution history for a job (or all jobs).
   */
  history(jobName?: string, limit: number = 20): CronHistoryEntry[] {
    const rows = this.stmtListHistory.all({
      jobName: jobName ?? null,
      limit,
    }) as RawCronHistoryRow[];

    return rows.map(r => ({
      id: r.id,
      jobId: r.job_id,
      jobName: r.job_name,
      jobType: r.job_type,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      success: r.success === 1,
      message: r.message,
      error: r.error,
    }));
  }

  /**
   * Recalculate next_run for all enabled jobs.
   * Useful after clock changes or restarts.
   */
  recalculateAll(): void {
    const now = Date.now();
    const jobs = this.list().filter(j => j.enabled);

    for (const job of jobs) {
      const next = nextRunTime(job.schedule, now);
      this.stmtUpdateNextRun.run(next, now, job.id);
    }

    log.info('Recalculated next_run for all enabled jobs', { count: jobs.length });
  }

  // ── Internal ──

  /**
   * Execute a single job and update its state.
   */
  private async executeJob(job: CronJob): Promise<CronRunResult> {
    const startTime = Date.now();

    log.info('Executing cron job', { id: job.id, name: job.name, jobType: job.jobType });

    let result: CronRunResult;

    try {
      result = await this.executor!(job);
    } catch (err) {
      result = {
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: false,
        message: 'Executor threw an exception',
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Update job state
    const now = Date.now();
    const next = nextRunTime(job.schedule, now);

    this.stmtUpdateAfterRun.run({
      id: job.id,
      lastRun: now,
      nextRun: next,
      now,
    });

    // Update result columns
    this.stmtUpdateResult.run({
      id: job.id,
      lastResult: result.success ? 'success' : 'error',
      lastError: result.error ?? null,
      now,
    });

    // Write history entry
    this.stmtInsertHistory.run({
      id: ulid(),
      jobId: job.id,
      jobName: job.name,
      jobType: job.jobType,
      startedAt: startTime,
      finishedAt: now,
      durationMs: result.durationMs,
      success: result.success ? 1 : 0,
      message: result.message,
      error: result.error ?? null,
    });

    // Audit log
    if (this.onAudit) {
      this.onAudit({
        eventType: 'cron_job_executed',
        actor: 'ved',
        detail: {
          jobId: job.id,
          name: job.name,
          jobType: job.jobType,
          success: result.success,
          durationMs: result.durationMs,
          message: result.message,
          ...(result.error ? { error: result.error } : {}),
        },
      });
    }

    log.info('Cron job completed', {
      id: job.id,
      name: job.name,
      success: result.success,
      durationMs: result.durationMs,
    });

    return result;
  }
}

// ── Helpers ──

export interface CronHistoryEntry {
  id: string;
  jobId: string;
  jobName: string;
  jobType: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  success: boolean;
  message: string;
  error: string | null;
}

interface RawCronRow {
  id: string;
  name: string;
  schedule: string;
  job_type: string;
  job_config: string;
  enabled: number;
  last_run: number | null;
  last_result: string | null;
  last_error: string | null;
  next_run: number | null;
  run_count: number;
  created_at: number;
  updated_at: number;
}

interface RawCronHistoryRow {
  id: string;
  job_id: string;
  job_name: string;
  job_type: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  success: number;
  message: string;
  error: string | null;
}

function rowToJob(row: RawCronRow): CronJob {
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    jobType: row.job_type,
    jobConfig: row.job_config,
    enabled: row.enabled === 1,
    lastRun: row.last_run,
    lastResult: row.last_result,
    lastError: row.last_error,
    nextRun: row.next_run,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
