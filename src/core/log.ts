/**
 * Ved structured logger.
 *
 * Zero dependencies. Two formats (json/pretty). Two sinks (console/file).
 * Module-scoped loggers via createLogger().
 *
 * All important actions go to the audit log (SQLite). This logger is for
 * console/file output — ephemeral, for debugging and operations.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

// === Types ===

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';

export interface LogEntry {
  ts: string;              // ISO 8601
  level: LogLevel;
  msg: string;
  module?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// === Priority map ===

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// === State ===

let _level: LogLevel = 'info';
let _format: LogFormat = 'json';
let _fileStream: WriteStream | null = null;

// === Initialization ===

/**
 * Configure the logger. Call once at startup.
 * Safe to call again (reconfigures).
 */
export function initLogger(opts: {
  level?: LogLevel;
  format?: LogFormat;
  file?: string | null;
}): void {
  _level = opts.level ?? 'info';
  _format = opts.format ?? 'json';

  // Close existing file stream if reconfiguring
  if (_fileStream) {
    _fileStream.end();
    _fileStream = null;
  }

  if (opts.file) {
    mkdirSync(dirname(opts.file), { recursive: true });
    _fileStream = createWriteStream(opts.file, { flags: 'a' });
  }
}

/**
 * Shut down the logger (flushes file stream).
 */
export function shutdownLogger(): void {
  if (_fileStream) {
    _fileStream.end();
    _fileStream = null;
  }
}

// === Core log function ===

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[_level]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };

  const output = _format === 'pretty' ? formatPretty(entry) : JSON.stringify(entry);

  // Console: stderr for warn/error, stdout for debug/info
  if (level === 'error' || level === 'warn') {
    console.error(output);
  } else {
    console.log(output);
  }

  // File sink: always JSON (machine parseable)
  if (_fileStream) {
    _fileStream.write(JSON.stringify(entry) + '\n');
  }
}

// === Pretty formatter ===

function formatPretty(entry: LogEntry): string {
  const time = entry.ts.slice(11, 23); // HH:mm:ss.sss
  const lvl = entry.level.toUpperCase().padEnd(5);
  const mod = entry.module ? `[${entry.module}] ` : '';
  const { ts: _ts, level: _l, msg, module: _m, ...rest } = entry;
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${time} ${lvl} ${mod}${msg}${extra}`;
}

// === Convenience exports ===

export const debug = (msg: string, data?: Record<string, unknown>): void => log('debug', msg, data);
export const info = (msg: string, data?: Record<string, unknown>): void => log('info', msg, data);
export const warn = (msg: string, data?: Record<string, unknown>): void => log('warn', msg, data);
export const error = (msg: string, data?: Record<string, unknown>): void => log('error', msg, data);

// === Module-scoped logger factory ===

/**
 * Create a logger scoped to a module name.
 * All log entries from this logger include `module: name`.
 */
export function createLogger(moduleName: string): Logger {
  return {
    debug: (msg, data) => log('debug', msg, { module: moduleName, ...data }),
    info: (msg, data) => log('info', msg, { module: moduleName, ...data }),
    warn: (msg, data) => log('warn', msg, { module: moduleName, ...data }),
    error: (msg, data) => log('error', msg, { module: moduleName, ...data }),
  };
}
