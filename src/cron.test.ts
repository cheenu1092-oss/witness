/**
 * Tests for CronScheduler + cron expression parser.
 *
 * Session 57: ved cron — scheduled job engine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate.js';
import {
  parseCronExpression,
  nextRunTime,
  CronScheduler,
  type CronRunResult,
} from './core/cron.js';

// ── Cron Expression Parser Tests ──

describe('parseCronExpression', () => {
  it('parses wildcard (*)', () => {
    const parsed = parseCronExpression('* * * * *');
    expect(parsed.minutes.size).toBe(60);
    expect(parsed.hours.size).toBe(24);
    expect(parsed.daysOfMonth.size).toBe(31);
    expect(parsed.months.size).toBe(12);
    expect(parsed.daysOfWeek.size).toBe(7);
  });

  it('parses single values', () => {
    const parsed = parseCronExpression('30 14 1 6 3');
    expect(parsed.minutes).toEqual(new Set([30]));
    expect(parsed.hours).toEqual(new Set([14]));
    expect(parsed.daysOfMonth).toEqual(new Set([1]));
    expect(parsed.months).toEqual(new Set([6]));
    expect(parsed.daysOfWeek).toEqual(new Set([3]));
  });

  it('parses ranges (1-5)', () => {
    const parsed = parseCronExpression('1-5 * * * *');
    expect(parsed.minutes).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('parses steps (*/15)', () => {
    const parsed = parseCronExpression('*/15 * * * *');
    expect(parsed.minutes).toEqual(new Set([0, 15, 30, 45]));
  });

  it('parses range with step (1-10/3)', () => {
    const parsed = parseCronExpression('1-10/3 * * * *');
    expect(parsed.minutes).toEqual(new Set([1, 4, 7, 10]));
  });

  it('parses comma-separated lists (1,3,5)', () => {
    const parsed = parseCronExpression('1,3,5 * * * *');
    expect(parsed.minutes).toEqual(new Set([1, 3, 5]));
  });

  it('parses combined: range + single + step', () => {
    const parsed = parseCronExpression('0,15,30-35 * * * *');
    expect(parsed.minutes).toEqual(new Set([0, 15, 30, 31, 32, 33, 34, 35]));
  });

  it('parses @hourly', () => {
    const parsed = parseCronExpression('@hourly');
    expect(parsed.minutes).toEqual(new Set([0]));
    expect(parsed.hours.size).toBe(24);
  });

  it('parses @daily', () => {
    const parsed = parseCronExpression('@daily');
    expect(parsed.minutes).toEqual(new Set([0]));
    expect(parsed.hours).toEqual(new Set([0]));
    expect(parsed.daysOfMonth.size).toBe(31);
  });

  it('parses @weekly', () => {
    const parsed = parseCronExpression('@weekly');
    expect(parsed.daysOfWeek).toEqual(new Set([0])); // Sunday
  });

  it('parses @monthly', () => {
    const parsed = parseCronExpression('@monthly');
    expect(parsed.daysOfMonth).toEqual(new Set([1]));
  });

  it('throws on invalid field count', () => {
    expect(() => parseCronExpression('* * *')).toThrow('expected 5 fields');
  });

  it('throws on out-of-range value', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrow('must be 0-59');
  });

  it('throws on invalid range', () => {
    expect(() => parseCronExpression('5-2 * * * *')).toThrow('Invalid range');
  });

  it('throws on invalid step', () => {
    expect(() => parseCronExpression('*/0 * * * *')).toThrow('Invalid step');
  });
});

// ── nextRunTime Tests ──

describe('nextRunTime', () => {
  it('returns next minute matching * * * * *', () => {
    // Use a local-time reference to avoid timezone mismatch
    const now = new Date(2026, 2, 6, 19, 30, 0, 0).getTime(); // Mar 6, 19:30 local
    const next = nextRunTime('* * * * *', now);
    expect(next).toBe(new Date(2026, 2, 6, 19, 31, 0, 0).getTime());
  });

  it('returns next hour for 0 * * * *', () => {
    const now = new Date(2026, 2, 6, 19, 30, 0, 0).getTime();
    const next = nextRunTime('0 * * * *', now);
    expect(next).toBe(new Date(2026, 2, 6, 20, 0, 0, 0).getTime());
  });

  it('returns next occurrence for daily at midnight', () => {
    const now = new Date(2026, 2, 6, 1, 0, 0, 0).getTime(); // Mar 6, 01:00 local
    const next = nextRunTime('0 0 * * *', now);
    expect(next).toBe(new Date(2026, 2, 7, 0, 0, 0, 0).getTime());
  });

  it('handles day-of-week filter', () => {
    // 2026-03-06 is a Friday (day 5) in local time
    const now = new Date(2026, 2, 6, 12, 0, 0, 0).getTime(); // Mar 6, 12:00 local
    const next = nextRunTime('0 0 * * 0', now); // Sunday
    // Next Sunday is March 8
    expect(next).toBe(new Date(2026, 2, 8, 0, 0, 0, 0).getTime());
  });

  it('returns null for impossible expression', () => {
    // Feb 31 never exists — but we cap at 1 year of iterations
    const next = nextRunTime('0 0 31 2 *');
    expect(next).toBeNull();
  });
});

// ── CronScheduler Tests ──

describe('CronScheduler', () => {
  let db: Database.Database;
  let scheduler: CronScheduler;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    scheduler = new CronScheduler(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('add', () => {
    it('creates a job with correct fields', () => {
      const job = scheduler.add({
        name: 'nightly-backup',
        schedule: '0 2 * * *',
        jobType: 'backup',
        jobConfig: { maxBackups: 5 },
      });

      expect(job.name).toBe('nightly-backup');
      expect(job.schedule).toBe('0 2 * * *');
      expect(job.jobType).toBe('backup');
      expect(JSON.parse(job.jobConfig)).toEqual({ maxBackups: 5 });
      expect(job.enabled).toBe(true);
      expect(job.runCount).toBe(0);
      expect(job.nextRun).toBeTypeOf('number');
      expect(job.nextRun).toBeGreaterThan(Date.now());
    });

    it('throws on duplicate name', () => {
      scheduler.add({ name: 'test', schedule: '@hourly', jobType: 'backup' });
      expect(() => scheduler.add({ name: 'test', schedule: '@daily', jobType: 'backup' }))
        .toThrow('already exists');
    });

    it('throws on invalid cron expression', () => {
      expect(() => scheduler.add({ name: 'bad', schedule: 'not valid', jobType: 'backup' }))
        .toThrow();
    });

    it('creates disabled job when enabled=false', () => {
      const job = scheduler.add({
        name: 'paused',
        schedule: '@daily',
        jobType: 'reindex',
        enabled: false,
      });

      expect(job.enabled).toBe(false);
      expect(job.nextRun).toBeNull();
    });
  });

  describe('list', () => {
    it('returns empty array when no jobs', () => {
      expect(scheduler.list()).toEqual([]);
    });

    it('returns all jobs sorted by name', () => {
      scheduler.add({ name: 'z-job', schedule: '@daily', jobType: 'backup' });
      scheduler.add({ name: 'a-job', schedule: '@hourly', jobType: 'reindex' });

      const jobs = scheduler.list();
      expect(jobs.length).toBe(2);
      expect(jobs[0].name).toBe('a-job');
      expect(jobs[1].name).toBe('z-job');
    });
  });

  describe('get', () => {
    it('finds by name', () => {
      scheduler.add({ name: 'test-job', schedule: '@daily', jobType: 'backup' });
      const job = scheduler.get('test-job');
      expect(job).not.toBeNull();
      expect(job!.name).toBe('test-job');
    });

    it('finds by id', () => {
      const created = scheduler.add({ name: 'by-id', schedule: '@daily', jobType: 'backup' });
      const job = scheduler.get(created.id);
      expect(job).not.toBeNull();
      expect(job!.name).toBe('by-id');
    });

    it('returns null for missing job', () => {
      expect(scheduler.get('nonexistent')).toBeNull();
    });
  });

  describe('remove', () => {
    it('removes an existing job', () => {
      scheduler.add({ name: 'doomed', schedule: '@daily', jobType: 'backup' });
      expect(scheduler.remove('doomed')).toBe(true);
      expect(scheduler.list()).toEqual([]);
    });

    it('returns false for nonexistent job', () => {
      expect(scheduler.remove('nope')).toBe(false);
    });
  });

  describe('toggle', () => {
    it('disables an enabled job (clears nextRun)', () => {
      scheduler.add({ name: 'toggle-me', schedule: '@hourly', jobType: 'backup' });
      const disabled = scheduler.toggle('toggle-me', false);

      expect(disabled).not.toBeNull();
      expect(disabled!.enabled).toBe(false);
      expect(disabled!.nextRun).toBeNull();
    });

    it('enables a disabled job (sets nextRun)', () => {
      scheduler.add({ name: 're-enable', schedule: '@hourly', jobType: 'backup', enabled: false });
      const enabled = scheduler.toggle('re-enable', true);

      expect(enabled).not.toBeNull();
      expect(enabled!.enabled).toBe(true);
      expect(enabled!.nextRun).toBeTypeOf('number');
    });

    it('returns null for nonexistent job', () => {
      expect(scheduler.toggle('ghost', true)).toBeNull();
    });
  });

  describe('tick', () => {
    it('executes due jobs', async () => {
      const results: CronRunResult[] = [];

      scheduler.setExecutor(async (job) => ({
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: true,
        message: 'OK',
        durationMs: 1,
      }));

      const job = scheduler.add({ name: 'tick-test', schedule: '* * * * *', jobType: 'backup' });

      // Manually set next_run to now (bypassing the schedule)
      db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job.id);

      const executed = await scheduler.tick();
      expect(executed).toBe(1);

      // Verify job state updated
      const updated = scheduler.get('tick-test')!;
      expect(updated.runCount).toBe(1);
      expect(updated.lastRun).toBeTypeOf('number');
      expect(updated.lastResult).toBe('success');
      expect(updated.nextRun).toBeTypeOf('number');
      expect(updated.nextRun!).toBeGreaterThan(Date.now());
    });

    it('skips disabled jobs', async () => {
      scheduler.setExecutor(async () => ({
        jobId: '', jobName: '', jobType: '', success: true, message: '', durationMs: 0,
      }));

      const job = scheduler.add({ name: 'skip-me', schedule: '* * * * *', jobType: 'backup', enabled: false });
      db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job.id);

      const executed = await scheduler.tick();
      expect(executed).toBe(0);
    });

    it('returns 0 when no jobs are due', async () => {
      scheduler.setExecutor(async () => ({
        jobId: '', jobName: '', jobType: '', success: true, message: '', durationMs: 0,
      }));

      scheduler.add({ name: 'future', schedule: '0 0 1 1 *', jobType: 'backup' }); // Jan 1

      const executed = await scheduler.tick();
      expect(executed).toBe(0);
    });

    it('records failure result', async () => {
      scheduler.setExecutor(async (job) => ({
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: false,
        message: 'Something broke',
        durationMs: 5,
        error: 'disk full',
      }));

      const job = scheduler.add({ name: 'fail-test', schedule: '* * * * *', jobType: 'backup' });
      db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job.id);

      await scheduler.tick();

      const updated = scheduler.get('fail-test')!;
      expect(updated.lastResult).toBe('error');
      expect(updated.lastError).toBe('disk full');
    });

    it('handles executor exceptions gracefully', async () => {
      scheduler.setExecutor(async () => {
        throw new Error('boom');
      });

      const job = scheduler.add({ name: 'throw-test', schedule: '* * * * *', jobType: 'backup' });
      db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job.id);

      // Should not throw
      const executed = await scheduler.tick();
      expect(executed).toBe(1); // Still counts as executed (error recorded)

      const updated = scheduler.get('throw-test')!;
      expect(updated.lastResult).toBe('error');
    });
  });

  describe('runNow', () => {
    it('manually triggers a job', async () => {
      scheduler.setExecutor(async (job) => ({
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: true,
        message: 'Manual run OK',
        durationMs: 10,
      }));

      scheduler.add({ name: 'manual', schedule: '@monthly', jobType: 'doctor' });

      const result = await scheduler.runNow('manual');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Manual run OK');

      const updated = scheduler.get('manual')!;
      expect(updated.runCount).toBe(1);
    });

    it('throws for nonexistent job', async () => {
      scheduler.setExecutor(async () => ({
        jobId: '', jobName: '', jobType: '', success: true, message: '', durationMs: 0,
      }));
      await expect(scheduler.runNow('ghost')).rejects.toThrow('not found');
    });

    it('throws when no executor set', async () => {
      scheduler.add({ name: 'no-exec', schedule: '@daily', jobType: 'backup' });
      await expect(scheduler.runNow('no-exec')).rejects.toThrow('No executor');
    });
  });

  describe('history', () => {
    it('records execution history', async () => {
      scheduler.setExecutor(async (job) => ({
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: true,
        message: 'Done',
        durationMs: 42,
      }));

      const job = scheduler.add({ name: 'history-test', schedule: '* * * * *', jobType: 'backup' });
      db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job.id);

      await scheduler.tick();

      const entries = scheduler.history('history-test');
      expect(entries.length).toBe(1);
      expect(entries[0].jobName).toBe('history-test');
      expect(entries[0].jobType).toBe('backup');
      expect(entries[0].success).toBe(true);
      expect(entries[0].durationMs).toBe(42);
      expect(entries[0].message).toBe('Done');
    });

    it('filters by job name', async () => {
      scheduler.setExecutor(async (job) => ({
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: true,
        message: 'OK',
        durationMs: 1,
      }));

      const job1 = scheduler.add({ name: 'job-a', schedule: '* * * * *', jobType: 'backup' });
      const job2 = scheduler.add({ name: 'job-b', schedule: '* * * * *', jobType: 'reindex' });
      db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job1.id);
      db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job2.id);

      await scheduler.tick();

      const all = scheduler.history();
      expect(all.length).toBe(2);

      const filtered = scheduler.history('job-a');
      expect(filtered.length).toBe(1);
      expect(filtered[0].jobName).toBe('job-a');
    });

    it('returns empty when no history', () => {
      expect(scheduler.history()).toEqual([]);
    });

    it('respects limit', async () => {
      scheduler.setExecutor(async (job) => ({
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: true,
        message: 'OK',
        durationMs: 1,
      }));

      const job = scheduler.add({ name: 'many-runs', schedule: '* * * * *', jobType: 'backup' });

      // Run 3 times
      for (let i = 0; i < 3; i++) {
        db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job.id);
        await scheduler.tick();
      }

      const limited = scheduler.history('many-runs', 2);
      expect(limited.length).toBe(2);
    });
  });

  describe('recalculateAll', () => {
    it('updates next_run for all enabled jobs', () => {
      scheduler.add({ name: 'recalc-1', schedule: '@hourly', jobType: 'backup' });
      scheduler.add({ name: 'recalc-2', schedule: '@daily', jobType: 'reindex' });
      scheduler.add({ name: 'recalc-disabled', schedule: '@hourly', jobType: 'backup', enabled: false });

      // Mess up next_run
      db.prepare('UPDATE cron_jobs SET next_run = 0 WHERE enabled = 1').run();

      scheduler.recalculateAll();

      const jobs = scheduler.list().filter(j => j.enabled);
      for (const job of jobs) {
        expect(job.nextRun).toBeTypeOf('number');
        expect(job.nextRun!).toBeGreaterThan(Date.now());
      }
    });
  });

  describe('audit integration', () => {
    it('calls onAudit for job creation', () => {
      const audits: Array<{ eventType: string }> = [];
      scheduler.setAudit((input) => audits.push(input));

      scheduler.add({ name: 'audited', schedule: '@daily', jobType: 'backup' });

      expect(audits.length).toBe(1);
      expect(audits[0].eventType).toBe('cron_job_created');
    });

    it('calls onAudit for job removal', () => {
      const audits: Array<{ eventType: string }> = [];
      scheduler.setAudit((input) => audits.push(input));

      scheduler.add({ name: 'to-remove', schedule: '@daily', jobType: 'backup' });
      scheduler.remove('to-remove');

      expect(audits.some(a => a.eventType === 'cron_job_removed')).toBe(true);
    });

    it('calls onAudit for execution', async () => {
      const audits: Array<{ eventType: string; detail: Record<string, unknown> }> = [];
      scheduler.setAudit((input) => audits.push(input));
      scheduler.setExecutor(async (job) => ({
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: true,
        message: 'OK',
        durationMs: 1,
      }));

      const job = scheduler.add({ name: 'audit-exec', schedule: '* * * * *', jobType: 'backup' });
      db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').run(Date.now() - 1000, job.id);
      await scheduler.tick();

      const execAudit = audits.find(a => a.eventType === 'cron_job_executed');
      expect(execAudit).toBeDefined();
      expect(execAudit!.detail.success).toBe(true);
    });

    it('calls onAudit for enable/disable', () => {
      const audits: Array<{ eventType: string }> = [];
      scheduler.setAudit((input) => audits.push(input));

      scheduler.add({ name: 'toggle-audit', schedule: '@daily', jobType: 'backup' });
      scheduler.toggle('toggle-audit', false);
      scheduler.toggle('toggle-audit', true);

      expect(audits.some(a => a.eventType === 'cron_job_disabled')).toBe(true);
      expect(audits.some(a => a.eventType === 'cron_job_enabled')).toBe(true);
    });
  });
});
