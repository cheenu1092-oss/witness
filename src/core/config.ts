/**
 * Ved configuration loader.
 *
 * Loading order (deep merge, later wins):
 * 1. Built-in defaults
 * 2. ~/.ved/config.yaml
 * 3. ~/.ved/config.local.yaml (secrets)
 * 4. VED_* environment variables
 * 5. CLI overrides (passed as argument)
 *
 * All path fields support ~ expansion and env vars.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { VedError } from '../types/errors.js';
import type { VedConfig, TrustTier } from '../types/index.js';
import { createLogger } from './log.js';

const log = createLogger('config');

// === Constants ===

const VED_DIR = join(homedir(), '.ved');
const CONFIG_PATH = join(VED_DIR, 'config.yaml');
const LOCAL_CONFIG_PATH = join(VED_DIR, 'config.local.yaml');

// === Defaults ===

const DEFAULTS: VedConfig = {
  name: 'Ved',
  version: '0.1.0',
  dbPath: join(VED_DIR, 'ved.db'),
  logLevel: 'info',
  logFormat: 'json',
  logFile: null,
  llm: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    apiKey: null,
    baseUrl: null,
    maxTokensPerMessage: 4096,
    maxTokensPerSession: 100_000,
    temperature: 0.7,
    systemPromptPath: null,
  },
  memory: {
    vaultPath: join(homedir(), 'ved-vault'),
    workingMemoryMaxTokens: 8000,
    ragContextMaxTokens: 4000,
    compressionThreshold: 6000,
    sessionIdleMinutes: 30,
    gitEnabled: true,
    gitAutoCommitIntervalMinutes: 5,
  },
  trust: {
    ownerIds: [],
    tribeIds: [],
    knownIds: [],
    defaultTier: 1 as TrustTier,
    approvalTimeoutMs: 300_000,
    maxToolCallsPerMessage: 10,
    maxAgenticLoops: 10,
  },
  audit: {
    anchorInterval: 100,
    hmacSecret: null,
  },
  rag: {
    vectorTopK: 10,
    ftsTopK: 10,
    graphMaxDepth: 2,
    graphMaxNodes: 20,
    maxContextTokens: 4000,
    rrfK: 60,
    embedding: {
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
      batchSize: 32,
      dimensions: 768,
    },
    chunking: {
      maxTokens: 1024,
      minTokens: 64,
      frontmatterPrefix: true,
    },
  },
  channels: [
    { type: 'cli', enabled: true, config: {} },
  ],
  mcp: {
    servers: [],
  },
};

// === Path expansion ===

/**
 * Expand ~, $ENV_VAR, ${ENV_VAR} in paths.
 * Relative paths resolved from ~/.ved/.
 */
export function expandPath(raw: string): string {
  let p = raw;
  p = p.replace(/^~(?=\/|$)/, homedir());
  p = p.replace(/\$\{?(\w+)\}?/g, (_, name: string) => process.env[name] ?? '');
  if (!isAbsolute(p)) {
    p = resolve(VED_DIR, p);
  }
  return p;
}

// === Deep merge ===

/**
 * Deep merge source into target. Arrays are replaced (not concatenated).
 * null in source explicitly overrides target.
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = (target as Record<string, unknown>)[key];
    if (sv !== undefined) {
      if (
        typeof sv === 'object' && sv !== null && !Array.isArray(sv) &&
        typeof tv === 'object' && tv !== null && !Array.isArray(tv)
      ) {
        result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
      } else {
        result[key] = sv;
      }
    }
  }
  return result as T;
}

// === Environment variable mapping ===

const ENV_MAP: Record<string, string[]> = {
  VED_DB_PATH: ['dbPath'],
  VED_LOG_LEVEL: ['logLevel'],
  VED_LOG_FORMAT: ['logFormat'],
  VED_LOG_FILE: ['logFile'],
  VED_LLM_PROVIDER: ['llm', 'provider'],
  VED_LLM_MODEL: ['llm', 'model'],
  VED_LLM_API_KEY: ['llm', 'apiKey'],
  VED_LLM_BASE_URL: ['llm', 'baseUrl'],
  VED_LLM_TEMPERATURE: ['llm', 'temperature'],
  VED_MEMORY_VAULT_PATH: ['memory', 'vaultPath'],
  VED_TRUST_APPROVAL_TIMEOUT_MS: ['trust', 'approvalTimeoutMs'],
  VED_AUDIT_HMAC_SECRET: ['audit', 'hmacSecret'],
};

function mergeEnvVars(config: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(config);
  for (const [envKey, path] of Object.entries(ENV_MAP)) {
    const val = process.env[envKey];
    if (val === undefined) continue;

    // Navigate to parent and set leaf
    let current = result as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      if (typeof current[path[i]] !== 'object' || current[path[i]] === null) {
        current[path[i]] = {};
      }
      current = current[path[i]] as Record<string, unknown>;
    }
    const leaf = path[path.length - 1];

    // Coerce value based on existing type
    const existing = current[leaf];
    if (typeof existing === 'number') {
      current[leaf] = Number(val);
    } else {
      current[leaf] = val;
    }
  }
  return result;
}

// === Validation ===

export interface ValidationError {
  path: string;
  code: 'REQUIRED' | 'INVALID_TYPE' | 'OUT_OF_RANGE' | 'INVALID_VALUE';
  message: string;
}

export function validateConfig(config: VedConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // Hard errors
  if (!config.trust.ownerIds || config.trust.ownerIds.length === 0) {
    errors.push({ path: 'trust.ownerIds', code: 'REQUIRED', message: 'At least one owner ID required' });
  }
  if (!['anthropic', 'openai', 'openrouter', 'ollama'].includes(config.llm.provider)) {
    errors.push({ path: 'llm.provider', code: 'INVALID_VALUE', message: `Invalid provider: ${config.llm.provider}` });
  }
  if (!config.llm.model || config.llm.model.trim() === '') {
    errors.push({ path: 'llm.model', code: 'REQUIRED', message: 'LLM model required' });
  }
  if (config.llm.temperature < 0 || config.llm.temperature > 2) {
    errors.push({ path: 'llm.temperature', code: 'OUT_OF_RANGE', message: 'Temperature must be 0.0-2.0' });
  }
  if (config.llm.maxTokensPerMessage <= 0) {
    errors.push({ path: 'llm.maxTokensPerMessage', code: 'OUT_OF_RANGE', message: 'Must be > 0' });
  }
  if (config.llm.maxTokensPerSession <= config.llm.maxTokensPerMessage) {
    errors.push({ path: 'llm.maxTokensPerSession', code: 'OUT_OF_RANGE', message: 'Must be > maxTokensPerMessage' });
  }
  if (!config.memory.vaultPath || config.memory.vaultPath.trim() === '') {
    errors.push({ path: 'memory.vaultPath', code: 'REQUIRED', message: 'Vault path required' });
  }
  if (config.memory.workingMemoryMaxTokens <= 0) {
    errors.push({ path: 'memory.workingMemoryMaxTokens', code: 'OUT_OF_RANGE', message: 'Must be > 0' });
  }
  if (config.memory.compressionThreshold >= config.memory.workingMemoryMaxTokens) {
    errors.push({ path: 'memory.compressionThreshold', code: 'OUT_OF_RANGE', message: 'Must be < workingMemoryMaxTokens' });
  }
  if (config.rag.embedding.dimensions <= 0) {
    errors.push({ path: 'rag.embedding.dimensions', code: 'OUT_OF_RANGE', message: 'Must be > 0' });
  }
  if (!config.channels || !config.channels.some(c => c.enabled)) {
    errors.push({ path: 'channels', code: 'REQUIRED', message: 'At least one enabled channel required' });
  }
  if (!config.dbPath || config.dbPath.trim() === '') {
    errors.push({ path: 'dbPath', code: 'REQUIRED', message: 'Database path required' });
  }

  return errors;
}

// === Main loader ===

/**
 * Load and validate Ved configuration.
 *
 * @param overrides CLI or programmatic overrides (highest priority)
 * @returns Fully merged, path-expanded, validated VedConfig
 * @throws VedError with code CONFIG_* on failure
 */
export function loadConfig(overrides?: Partial<VedConfig>): VedConfig {
  let config: Record<string, unknown> = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;

  // Load config.yaml
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = parseYaml(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
      if (raw && typeof raw === 'object') {
        config = deepMerge(config as VedConfig & Record<string, unknown>, raw);
      }
    } catch (err) {
      throw new VedError('CONFIG_PARSE_ERROR', `Failed to parse ${CONFIG_PATH}`, err as Error);
    }
  }

  // Load config.local.yaml (secrets)
  if (existsSync(LOCAL_CONFIG_PATH)) {
    try {
      const local = parseYaml(readFileSync(LOCAL_CONFIG_PATH, 'utf8')) as Record<string, unknown>;
      if (local && typeof local === 'object') {
        config = deepMerge(config as VedConfig & Record<string, unknown>, local);
      }
    } catch (err) {
      throw new VedError('CONFIG_PARSE_ERROR', `Failed to parse ${LOCAL_CONFIG_PATH}`, err as Error);
    }
  }

  // Merge environment variables
  config = mergeEnvVars(config);

  // Merge CLI overrides
  if (overrides) {
    config = deepMerge(config as VedConfig & Record<string, unknown>, overrides as Record<string, unknown>);
  }

  const vedConfig = config as unknown as VedConfig;

  // Expand paths
  vedConfig.dbPath = expandPath(vedConfig.dbPath);
  vedConfig.memory.vaultPath = expandPath(vedConfig.memory.vaultPath);
  if (vedConfig.logFile) vedConfig.logFile = expandPath(vedConfig.logFile);
  if (vedConfig.llm.systemPromptPath) vedConfig.llm.systemPromptPath = expandPath(vedConfig.llm.systemPromptPath);

  // Validate
  const errors = validateConfig(vedConfig);
  const hard = errors.filter(e => ['REQUIRED', 'OUT_OF_RANGE', 'INVALID_VALUE'].includes(e.code));
  if (hard.length > 0) {
    throw new VedError('CONFIG_INVALID',
      `Config validation failed:\n${hard.map(e => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  // Warnings (non-fatal)
  if (!vedConfig.audit.hmacSecret) {
    log.warn('HMAC anchoring disabled — audit chain not externally verifiable');
  }
  if (vedConfig.llm.provider !== 'ollama' && !vedConfig.llm.apiKey) {
    log.warn(`No API key for ${vedConfig.llm.provider} — LLM calls will fail`);
  }

  return vedConfig;
}

/**
 * Get the default config directory path.
 */
export function getConfigDir(): string {
  return VED_DIR;
}

/**
 * Get the built-in defaults (for testing/initialization).
 */
export function getDefaults(): VedConfig {
  return structuredClone(DEFAULTS);
}
