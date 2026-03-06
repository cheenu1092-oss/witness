/**
 * Cron Channel Adapter — scheduled message injection.
 *
 * Parses 5-field cron expressions and fires messages at scheduled times.
 * No external dependencies — uses a simple interval-based tick checker.
 */

import { ulid } from 'ulid';
import type { VedMessage, VedResponse, WorkOrder } from '../types/index.js';
import type {
  ChannelAdapter, CronAdapterConfig, CronJobConfig, MessageHandler,
} from './types.js';

const TICK_INTERVAL_MS = 60_000; // check every minute

export class CronAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = 'cron';

  private jobs: CronJobConfig[] = [];
  private handlers: MessageHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private lastTickMinute = -1;

  constructor(id?: string) {
    this.id = id ?? 'cron';
  }

  get connected(): boolean {
    return this._connected;
  }

  async init(config: CronAdapterConfig): Promise<void> {
    this.jobs = config.jobs.filter(j => j.enabled);
  }

  async start(): Promise<void> {
    if (this.jobs.length === 0) {
      this._connected = true;
      return; // nothing to schedule
    }

    this._connected = true;
    this.lastTickMinute = -1;

    // Tick every minute to check cron schedules
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._connected = false;
  }

  async send(_response: VedResponse): Promise<void> {
    // Cron channel doesn't send responses — no-op
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async sendApprovalRequest(_workOrder: WorkOrder): Promise<void> {
    // Cron doesn't handle approvals
  }

  async notify(_text: string): Promise<void> {
    // Cron doesn't handle notifications
  }

  async shutdown(): Promise<void> {
    await this.stop();
    this.handlers = [];
    this.jobs = [];
  }

  /** Get configured jobs (for testing/inspection) */
  getJobs(): CronJobConfig[] {
    return [...this.jobs];
  }

  /**
   * Manual tick for testing — check if any jobs should fire.
   * In normal operation, called by the interval timer.
   */
  tick(now?: Date): void {
    const date = now ?? new Date();
    const minute = date.getMinutes();

    // Dedup: skip if same minute as last tick
    const currentMinuteKey = date.getFullYear() * 100000000 +
      (date.getMonth() + 1) * 1000000 +
      date.getDate() * 10000 +
      date.getHours() * 100 +
      minute;

    if (currentMinuteKey === this.lastTickMinute) return;
    this.lastTickMinute = currentMinuteKey;

    for (const job of this.jobs) {
      if (matchesCron(job.schedule, date)) {
        const msg: VedMessage = {
          id: ulid(),
          channel: 'cron',
          author: `cron:${job.name}`,
          content: job.message,
          timestamp: Date.now(),
        };

        for (const handler of this.handlers) {
          handler(msg);
        }
      }
    }
  }
}

// ── Cron Expression Parser ──

/**
 * Match a 5-field cron expression against a date.
 * Fields: minute hour day-of-month month day-of-week
 * Supports: *, specific values, ranges (1-5), steps (* /5), lists (1,3,5)
 * Day-of-week: 0=Sunday, 6=Saturday
 */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minField, hourField, domField, monthField, dowField] = fields;

  return (
    matchField(minField, date.getMinutes(), 0, 59) &&
    matchField(hourField, date.getHours(), 0, 23) &&
    matchField(domField, date.getDate(), 1, 31) &&
    matchField(monthField, date.getMonth() + 1, 1, 12) &&
    matchField(dowField, date.getDay(), 0, 6)
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  // Wildcard
  if (field === '*') return true;

  // List (e.g. 1,3,5)
  if (field.includes(',')) {
    return field.split(',').some(part => matchField(part.trim(), value, min, max));
  }

  // Step (e.g. */5 or 1-10/2)
  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;

    if (range === '*') {
      return (value - min) % step === 0;
    }

    // Range with step (e.g. 1-10/2)
    if (range.includes('-')) {
      const [lo, hi] = range.split('-').map(Number);
      if (isNaN(lo) || isNaN(hi)) return false;
      if (value < lo || value > hi) return false;
      return (value - lo) % step === 0;
    }

    return false;
  }

  // Range (e.g. 1-5)
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    if (isNaN(lo) || isNaN(hi)) return false;
    return value >= lo && value <= hi;
  }

  // Specific value
  const num = parseInt(field, 10);
  if (isNaN(num)) return false;
  return value === num;
}
