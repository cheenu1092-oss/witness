/**
 * Core module tests — config loader, validator, logger, path expansion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getDefaults, expandPath, deepMerge, validateConfig, loadConfig,
  initLogger, shutdownLogger, log, createLogger,
} from './index.js';
import type { VedConfig } from '../types/index.js';
import { VedError } from '../types/errors.js';
import { homedir } from 'node:os';

// ── Helpers ──

function makeValidConfig(overrides: Partial<VedConfig> = {}): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    trust: {
      ...defaults.trust,
      ownerIds: ['owner1'], // Required for validation
    },
    ...overrides,
  } as VedConfig;
}

// ── Path expansion ──

describe('expandPath', () => {
  it('expands ~ to home directory', () => {
    const result = expandPath('~/test/path');
    expect(result).toBe(`${homedir()}/test/path`);
  });

  it('expands ~ alone', () => {
    expect(expandPath('~')).toBe(homedir());
  });

  it('expands $HOME', () => {
    const result = expandPath('$HOME/test');
    expect(result).toBe(`${process.env['HOME']}/test`);
  });

  it('expands ${HOME}', () => {
    const result = expandPath('${HOME}/test');
    expect(result).toBe(`${process.env['HOME']}/test`);
  });

  it('resolves relative paths from ~/.ved/', () => {
    const result = expandPath('data/test.db');
    expect(result).toContain('.ved');
    expect(result).toContain('data/test.db');
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandPath('/absolute/path')).toBe('/absolute/path');
  });

  it('removes undefined env vars', () => {
    const result = expandPath('$NONEXISTENT_VAR_XYZ/test');
    expect(result).toContain('/test');
    expect(result).not.toContain('$');
  });
});

// ── Deep merge ──

describe('deepMerge', () => {
  it('merges flat objects', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('deep merges nested objects', () => {
    const result = deepMerge(
      { nested: { a: 1, b: 2 } },
      { nested: { b: 3 } },
    );
    expect(result).toEqual({ nested: { a: 1, b: 3 } });
  });

  it('replaces arrays (no concatenation)', () => {
    const result = deepMerge(
      { list: [1, 2, 3] },
      { list: [4, 5] },
    );
    expect(result).toEqual({ list: [4, 5] });
  });

  it('null in source overrides target', () => {
    const result = deepMerge(
      { key: 'value' },
      { key: null },
    );
    expect(result).toEqual({ key: null });
  });

  it('does not mutate target', () => {
    const target = { a: 1, nested: { b: 2 } };
    const copy = structuredClone(target);
    deepMerge(target, { nested: { b: 99 } });
    expect(target).toEqual(copy);
  });

  it('handles undefined values in source (skipped)', () => {
    const result = deepMerge({ a: 1 }, { a: undefined, b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

// ── Config validation ──

describe('validateConfig', () => {
  it('passes for valid config', () => {
    const config = makeValidConfig();
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('requires at least one ownerIds', () => {
    const config = makeValidConfig();
    config.trust.ownerIds = [];
    const errors = validateConfig(config);
    expect(errors.some(e => e.path === 'trust.ownerIds')).toBe(true);
  });

  it('validates llm.provider enum', () => {
    const config = makeValidConfig();
    (config.llm as any).provider = 'invalid';
    const errors = validateConfig(config);
    expect(errors.some(e => e.path === 'llm.provider')).toBe(true);
  });

  it('requires non-empty llm.model', () => {
    const config = makeValidConfig();
    config.llm.model = '';
    const errors = validateConfig(config);
    expect(errors.some(e => e.path === 'llm.model')).toBe(true);
  });

  it('validates temperature range 0-2', () => {
    const config = makeValidConfig();
    config.llm.temperature = 3;
    expect(validateConfig(config).some(e => e.path === 'llm.temperature')).toBe(true);

    config.llm.temperature = -1;
    expect(validateConfig(config).some(e => e.path === 'llm.temperature')).toBe(true);

    config.llm.temperature = 1.5;
    expect(validateConfig(config).some(e => e.path === 'llm.temperature')).toBe(false);
  });

  it('requires maxTokensPerSession > maxTokensPerMessage', () => {
    const config = makeValidConfig();
    config.llm.maxTokensPerSession = config.llm.maxTokensPerMessage;
    expect(validateConfig(config).some(e => e.path === 'llm.maxTokensPerSession')).toBe(true);
  });

  it('requires non-empty vaultPath', () => {
    const config = makeValidConfig();
    config.memory.vaultPath = '';
    expect(validateConfig(config).some(e => e.path === 'memory.vaultPath')).toBe(true);
  });

  it('requires compressionThreshold < workingMemoryMaxTokens', () => {
    const config = makeValidConfig();
    config.memory.compressionThreshold = config.memory.workingMemoryMaxTokens;
    expect(validateConfig(config).some(e => e.path === 'memory.compressionThreshold')).toBe(true);
  });

  it('requires at least one enabled channel', () => {
    const config = makeValidConfig();
    config.channels = [];
    expect(validateConfig(config).some(e => e.path === 'channels')).toBe(true);

    config.channels = [{ type: 'cli', enabled: false, config: {} }];
    expect(validateConfig(config).some(e => e.path === 'channels')).toBe(true);
  });

  it('requires non-empty dbPath', () => {
    const config = makeValidConfig();
    config.dbPath = '';
    expect(validateConfig(config).some(e => e.path === 'dbPath')).toBe(true);
  });

  it('validates embedding dimensions > 0', () => {
    const config = makeValidConfig();
    config.rag.embedding.dimensions = 0;
    expect(validateConfig(config).some(e => e.path === 'rag.embedding.dimensions')).toBe(true);
  });
});

// ── Config defaults ──

describe('getDefaults', () => {
  it('returns a valid config structure', () => {
    const defaults = getDefaults();
    expect(defaults.name).toBe('Ved');
    expect(defaults.llm.provider).toBe('anthropic');
    expect(defaults.trust.defaultTier).toBe(1);
    expect(defaults.channels.length).toBeGreaterThan(0);
  });

  it('returns a deep clone (not shared reference)', () => {
    const a = getDefaults();
    const b = getDefaults();
    a.name = 'modified';
    expect(b.name).toBe('Ved');
  });
});

// ── Logger ──

describe('Logger', () => {
  beforeEach(() => {
    initLogger({ level: 'debug', format: 'json' });
  });

  afterEach(() => {
    shutdownLogger();
  });

  it('respects log level filtering', () => {
    initLogger({ level: 'warn', format: 'json' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    log('debug', 'should be filtered');
    log('info', 'should be filtered');
    log('warn', 'should show');
    log('error', 'should show');

    expect(spy).not.toHaveBeenCalled();
    expect(spyErr).toHaveBeenCalledTimes(2);

    spy.mockRestore();
    spyErr.mockRestore();
  });

  it('outputs JSON format', () => {
    initLogger({ level: 'debug', format: 'json' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    log('info', 'test message', { key: 'value' });

    expect(spy).toHaveBeenCalledTimes(1);
    const output = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.key).toBe('value');
    expect(parsed.ts).toBeTruthy();

    spy.mockRestore();
  });

  it('outputs pretty format', () => {
    initLogger({ level: 'debug', format: 'pretty' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    log('info', 'hello world');

    expect(spy).toHaveBeenCalledTimes(1);
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('INFO');
    expect(output).toContain('hello world');

    spy.mockRestore();
  });

  it('routes warn/error to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    log('warn', 'warning');
    log('error', 'error');

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('createLogger adds module name to entries', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('ved-test');

    logger.info('test');

    const output = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.module).toBe('ved-test');

    spy.mockRestore();
  });
});

// ── VedError ──

describe('VedError', () => {
  it('has code, message, and name', () => {
    const err = new VedError('CONFIG_INVALID', 'bad config');
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toBe('bad config');
    expect(err.name).toBe('VedError');
  });

  it('supports cause chaining', () => {
    const cause = new Error('original');
    const err = new VedError('DB_OPEN_FAILED', 'cannot open', cause);
    expect(err.cause).toBe(cause);
  });

  it('supports context', () => {
    const err = new VedError('TRUST_DENIED', 'blocked', undefined, { tool: 'exec', tier: 1 });
    expect(err.context).toEqual({ tool: 'exec', tier: 1 });
  });

  it('serializes to JSON', () => {
    const cause = new Error('root');
    const err = new VedError('LLM_TIMEOUT', 'timed out', cause, { model: 'gpt-4' });
    const json = err.toJSON();
    expect(json.code).toBe('LLM_TIMEOUT');
    expect(json.message).toBe('timed out');
    expect(json.cause).toBe('root');
    expect(json.context).toEqual({ model: 'gpt-4' });
  });

  it('omits cause and context when undefined', () => {
    const err = new VedError('INTERNAL_ERROR', 'oops');
    const json = err.toJSON();
    expect(json).not.toHaveProperty('cause');
    expect(json).not.toHaveProperty('context');
  });
});
