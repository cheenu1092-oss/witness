/**
 * VedApp — Top-level application wiring.
 *
 * Creates, initializes, and wires all modules together.
 * Provides the main `start()` / `stop()` lifecycle.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createLogger } from './core/log.js';
import { loadConfig, validateConfig } from './core/config.js';
import { migrate, currentVersion, verifyMigrations } from './db/migrate.js';
import { EventLoop } from './core/event-loop.js';
import { CronScheduler, type CronJob, type CronJobInput, type CronRunResult, type CronHistoryEntry } from './core/cron.js';
import { LLMClient } from './llm/client.js';
import { MCPClient } from './mcp/client.js';
import { MemoryManager } from './memory/manager.js';
import { VaultManager } from './memory/vault.js';
import { RagPipeline } from './rag/pipeline.js';
import { ChannelManager } from './channel/manager.js';
import { VedError } from './types/errors.js';
import type { VedConfig, ModuleHealth, VaultFile, AuditEntry } from './types/index.js';
import type { IndexStats, RetrieveOptions, RetrievalContext } from './rag/types.js';
import type { VaultExport, VaultExportFile, ExportOptions, ImportResult } from './export-types.js';
import type { MCPServerConfig, MCPToolDefinition, ServerInfo } from './mcp/types.js';
import { EventBus } from './event-bus.js';
import { WebhookManager } from './webhook.js';
import type { Webhook, WebhookInput, WebhookDelivery, WebhookStats } from './webhook.js';

const log = createLogger('app');

export interface VedAppOptions {
  /** Override config (merged on top of files + env) */
  configOverrides?: Partial<VedConfig>;
  /** Skip config validation (for testing) */
  skipValidation?: boolean;
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  fixable?: boolean;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  passed: number;
  warned: number;
  failed: number;
  infos: number;
}

export interface PluginTestResult {
  serverName: string;
  success: boolean;
  toolCount: number;
  tools: string[];
  durationMs: number;
  error?: string;
}

export interface GcStatus {
  staleSessions: number;
  staleSessionIds: string[];
  oldAuditEntries: number;
  oldAuditCutoff: number;
  auditWarning?: string;
}

export interface GcResult {
  sessionsClosed: number;
  auditEntriesDeleted: number;
  vacuumed: boolean;
  durationMs: number;
}

export class VedApp {
  readonly config: VedConfig;

  // Database
  private db: Database.Database | null = null;

  // Modules
  readonly eventLoop: EventLoop;
  readonly cron: CronScheduler;
  readonly llm: LLMClient;
  readonly mcp: MCPClient;
  readonly memory: MemoryManager;
  readonly rag: RagPipeline;
  readonly channels: ChannelManager;
  readonly eventBus: EventBus;
  readonly webhooks: WebhookManager;

  private initialized = false;
  private cronTickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: VedConfig) {
    this.config = config;

    // Open database
    const dbDir = dirname(config.dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    // Run migrations
    const applied = migrate(this.db);
    if (applied > 0) {
      log.info(`Applied ${applied} migration(s)`);
    }

    // Create modules
    this.llm = new LLMClient();
    this.mcp = new MCPClient();
    const vault = new VaultManager(config.memory.vaultPath, config.memory.gitEnabled);
    this.memory = new MemoryManager(vault);
    this.rag = new RagPipeline();
    this.channels = new ChannelManager();

    // Create event loop (owns audit, trust, sessions, queue)
    this.eventLoop = new EventLoop({
      config,
      db: this.db,
    });

    // Create event bus (real-time event stream for SSE/webhooks)
    this.eventBus = new EventBus();

    // Wire audit → event bus (every audit append triggers bus emit)
    this.eventLoop.audit.onAppend = (entry) => this.eventBus.emitFromAudit(entry);

    // Create webhook manager (delivers events to registered HTTP endpoints)
    this.webhooks = new WebhookManager(this.db, this.eventBus);

    // Create cron scheduler
    this.cron = new CronScheduler(this.db);
    this.cron.setAudit((input) => this.eventLoop.audit.append(input));
    this.cron.setExecutor((job) => this.executeCronJob(job));
  }

  /**
   * Initialize all modules. Must be called before start().
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    log.info('Initializing modules...');

    // Initialize independent modules in parallel
    await Promise.all([
      this.llm.init(this.config),
      this.mcp.init(this.config),
      this.memory.init(this.config),
      this.channels.init(this.config),
    ]);

    // RAG needs special init (database handle + embedder check)
    await this.rag.init(this.config);
    this.rag.setDatabase(this.db!);

    // Discover MCP tools
    const tools = await this.mcp.discoverTools();
    log.info(`Discovered ${tools.length} MCP tools`);

    // Wire modules into event loop
    this.eventLoop.setModules({
      llm: this.llm,
      mcp: this.mcp,
      memory: this.memory,
      rag: this.rag,
      channels: this.channels,
    });

    this.initialized = true;
    log.info('All modules initialized');
  }

  /**
   * Start Ved: init all modules, start channels, enter event loop.
   * Blocks until stop() is called.
   */
  async start(): Promise<void> {
    await this.init();

    // Auto-commit any dirty vault files before indexing
    this.autoCommitVault();

    // Index all existing vault files into RAG before entering event loop
    await this.indexVaultOnStartup();

    // Start channel adapters (Discord, CLI, etc.)
    await this.channels.startAll();

    // Wire channel messages → event loop
    this.channels.onMessage((msg) => {
      this.eventLoop.receive(msg);
    });

    // Start vault filesystem watcher → RAG re-index on changes
    this.startVaultWatcher();

    // Start cron tick (check for due jobs every 30s)
    this.startCronTick();

    // Recalculate next_run for all jobs on startup (handles clock drift)
    this.cron.recalculateAll();

    // Start webhook delivery (subscribes to EventBus)
    this.webhooks.start();

    log.info('Ved is running');

    // Enter the main event loop (blocks)
    await this.eventLoop.run();
  }

  /**
   * Request graceful shutdown.
   */
  async stop(): Promise<void> {
    log.info('Stopping Ved...');

    // Stop webhook delivery
    this.webhooks.stop();

    // Stop cron tick
    this.stopCronTick();

    // Stop vault watcher
    this.stopVaultWatcher();

    // Stop event loop (completes current message)
    this.eventLoop.requestShutdown();

    // Stop channels
    await this.channels.stopAll();

    // Shutdown modules
    await Promise.allSettled([
      this.llm.shutdown(),
      this.mcp.shutdown(),
      this.memory.shutdown(),
      this.rag.shutdown(),
      this.channels.shutdown(),
    ]);

    // Close database
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    log.info('Ved stopped');
  }

  /**
   * Health check across all modules.
   */
  async healthCheck(): Promise<{ healthy: boolean; modules: ModuleHealth[] }> {
    const results = await Promise.all([
      this.eventLoop.healthCheck(),
      this.llm.healthCheck(),
      this.mcp.healthCheck(),
      this.memory.healthCheck(),
      this.rag.healthCheck(),
      this.channels.healthCheck(),
    ]);

    const healthy = results.every(r => r.healthy);
    return { healthy, modules: results };
  }

  // ── Stats ──

  /**
   * Get comprehensive system stats for `ved stats` CLI.
   */
  getStats(): {
    rag: IndexStats;
    vault: { fileCount: number; tagCount: number; typeCount: number; gitClean: boolean; gitDirtyCount: number };
    audit: { chainLength: number; chainHead: string };
    sessions: { active: number; total: number };
  } {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }

    // RAG stats
    const rag = this.rag.stats();

    // Vault stats
    const vaultIndex = this.memory.vault.getIndex();
    const vault = {
      fileCount: vaultIndex.files.size,
      tagCount: vaultIndex.tags.size,
      typeCount: vaultIndex.types.size,
      gitClean: this.memory.vault.git.isClean(),
      gitDirtyCount: this.memory.vault.git.dirtyCount,
    };

    // Audit stats
    const chainHead = this.eventLoop.audit.getChainHead();
    const audit = {
      chainLength: chainHead.count,
      chainHead: chainHead.hash.slice(0, 12),
    };

    // Session stats
    const activeSessions = (this.db!.prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE status IN ('active', 'idle')"
    ).get() as { cnt: number }).cnt;
    const totalSessions = (this.db!.prepare(
      'SELECT COUNT(*) as cnt FROM sessions'
    ).get() as { cnt: number }).cnt;
    const sessions = { active: activeSessions, total: totalSessions };

    return { rag, vault, audit, sessions };
  }

  /**
   * Search the vault via RAG pipeline (vector + FTS + graph fusion).
   * Used by `ved search` CLI command.
   */
  async search(query: string, options?: RetrieveOptions): Promise<RetrievalContext> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }
    return this.rag.retrieve(query, options);
  }

  // ── Webhooks ──

  webhookAdd(input: WebhookInput): Webhook {
    return this.webhooks.add(input);
  }

  webhookRemove(idOrName: string): boolean {
    return this.webhooks.remove(idOrName);
  }

  webhookGet(idOrName: string): Webhook | null {
    return this.webhooks.get(idOrName);
  }

  webhookList(): Webhook[] {
    return this.webhooks.list();
  }

  webhookToggle(idOrName: string, enabled: boolean): Webhook | null {
    return this.webhooks.toggle(idOrName, enabled);
  }

  webhookDeliveries(webhookIdOrName?: string, limit?: number): WebhookDelivery[] {
    return this.webhooks.deliveries(webhookIdOrName, limit);
  }

  webhookStats(): WebhookStats {
    return this.webhooks.stats();
  }

  // ── Export / Import ──

  /**
   * Export the vault to a portable JSON object.
   * Used by `ved export` CLI command.
   */
  async exportVault(options?: ExportOptions): Promise<VaultExport> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }

    const files = this.readAllVaultFiles(options?.folder);
    const exportFiles: VaultExportFile[] = files.map(f => ({
      path: f.path,
      frontmatter: f.frontmatter,
      body: f.body,
      links: f.links,
    }));

    const result: VaultExport = {
      vedVersion: '0.1.0',
      exportedAt: new Date().toISOString(),
      vaultPath: this.config.memory.vaultPath,
      fileCount: exportFiles.length,
      files: exportFiles,
    };

    if (options?.includeAudit) {
      const chainHead = this.eventLoop.audit.getChainHead();
      result.audit = {
        chainLength: chainHead.count,
        chainHead: chainHead.hash,
        entries: chainHead.count,
      };
    }

    if (options?.includeStats) {
      const s = this.getStats();
      result.stats = {
        rag: {
          filesIndexed: s.rag.filesIndexed,
          chunksStored: s.rag.chunksStored,
          ftsEntries: s.rag.ftsEntries,
          graphEdges: s.rag.graphEdges,
        },
        vault: {
          fileCount: s.vault.fileCount,
          tagCount: s.vault.tagCount,
          typeCount: s.vault.typeCount,
        },
        sessions: {
          active: s.sessions.active,
          total: s.sessions.total,
        },
      };
    }

    return result;
  }

  /**
   * Import vault files from a JSON export.
   * Used by `ved import` CLI command.
   */
  async importVault(data: VaultExport, mode: 'merge' | 'overwrite' | 'fail' = 'fail'): Promise<ImportResult> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }

    const result: ImportResult = { created: 0, overwritten: 0, skipped: 0, errors: 0, errorPaths: [] };
    const vault = this.memory.vault;

    for (const f of data.files) {
      try {
        // Validate path containment BEFORE any filesystem operations
        vault.assertPathSafe(f.path);

        const exists = vault.exists(f.path);

        if (exists) {
          if (mode === 'merge') {
            result.skipped++;
            continue;
          } else if (mode === 'overwrite') {
            vault.updateFile(f.path, { frontmatter: f.frontmatter, body: f.body });
            result.overwritten++;
          } else {
            // mode === 'fail'
            result.skipped++;
            continue;
          }
        } else {
          vault.createFile(f.path, f.frontmatter, f.body);
          result.created++;
        }
      } catch (err) {
        result.errors++;
        result.errorPaths.push(f.path);
        log.warn('Failed to import vault file', {
          path: f.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Check if a vault file exists. Used by dry-run import.
   */
  vaultFileExists(path: string): boolean {
    return this.memory.vault.exists(path);
  }

  // ── History ──

  /**
   * Get audit history entries for `ved history` CLI.
   */
  getHistory(options?: { type?: string; from?: number; to?: number; limit?: number }): AuditEntry[] {
    return this.eventLoop.audit.getFiltered({
      type: options?.type,
      from: options?.from,
      to: options?.to,
      limit: options?.limit ?? 20,
    });
  }

  /**
   * Verify audit chain integrity for `ved history --verify`.
   */
  verifyAuditChain(limit?: number): { intact: boolean; brokenAt?: number; total: number } {
    return this.eventLoop.audit.verifyChain(limit);
  }

  /**
   * Get all unique event types present in the audit log.
   */
  getAuditEventTypes(): string[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT DISTINCT event_type FROM audit_log ORDER BY event_type'
    ).all() as { event_type: string }[];
    return rows.map(r => r.event_type);
  }

  // ── Doctor ──

  /**
   * Run self-diagnostics. Returns structured results for `ved doctor` CLI.
   */
  async doctor(): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [];

    // 1. Config validity
    try {
      const errors = validateConfig(this.config);
      if (errors.length === 0) {
        checks.push({ name: 'Config', status: 'ok', message: 'Valid configuration' });
      } else {
        const required = errors.filter(e => e.code === 'REQUIRED');
        const warnings = errors.filter(e => e.code !== 'REQUIRED');
        if (required.length > 0) {
          checks.push({
            name: 'Config',
            status: 'fail',
            message: `${required.length} required field(s) missing: ${required.map(e => e.path).join(', ')}`,
            fixable: true,
          });
        } else {
          checks.push({
            name: 'Config',
            status: 'warn',
            message: `${warnings.length} warning(s): ${warnings.map(e => e.path).join(', ')}`,
          });
        }
      }
    } catch (err) {
      checks.push({
        name: 'Config',
        status: 'fail',
        message: `Config load error: ${err instanceof Error ? err.message : String(err)}`,
        fixable: true,
      });
    }

    // 2. Database health
    if (this.db) {
      try {
        const integrity = this.db.pragma('integrity_check') as { integrity_check: string }[];
        const isOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
        if (isOk) {
          checks.push({ name: 'Database', status: 'ok', message: `SQLite OK (${this.config.dbPath})` });
        } else {
          checks.push({
            name: 'Database',
            status: 'fail',
            message: `Integrity check failed: ${integrity.map(r => r.integrity_check).join('; ')}`,
          });
        }
      } catch (err) {
        checks.push({
          name: 'Database',
          status: 'fail',
          message: `Database error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      checks.push({ name: 'Database', status: 'fail', message: 'No database connection' });
    }

    // 3. Vault directory structure
    const vaultPath = this.config.memory.vaultPath;
    const expectedDirs = ['daily', 'entities', 'concepts', 'decisions'];
    const missingDirs: string[] = [];
    if (existsSync(vaultPath)) {
      for (const dir of expectedDirs) {
        if (!existsSync(join(vaultPath, dir))) {
          missingDirs.push(dir);
        }
      }
      if (missingDirs.length === 0) {
        checks.push({ name: 'Vault structure', status: 'ok', message: `All 4 folders present (${vaultPath})` });
      } else {
        checks.push({
          name: 'Vault structure',
          status: 'warn',
          message: `Missing folders: ${missingDirs.join(', ')}`,
          fixable: true,
        });
      }
    } else {
      checks.push({
        name: 'Vault structure',
        status: 'fail',
        message: `Vault path does not exist: ${vaultPath}`,
        fixable: true,
      });
    }

    // 4. Vault git status
    try {
      const git = this.memory.vault.git;
      if (!git.isRepo) {
        if (this.config.memory.gitEnabled) {
          checks.push({
            name: 'Vault git',
            status: 'warn',
            message: 'Git enabled in config but vault is not a git repo',
            fixable: true,
          });
        } else {
          checks.push({ name: 'Vault git', status: 'info', message: 'Git tracking disabled' });
        }
      } else if (git.isClean()) {
        checks.push({ name: 'Vault git', status: 'ok', message: 'Clean working tree' });
      } else {
        checks.push({
          name: 'Vault git',
          status: 'warn',
          message: `${git.dirtyCount} uncommitted file(s)`,
        });
      }
    } catch (err) {
      checks.push({
        name: 'Vault git',
        status: 'warn',
        message: `Git check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 5. Audit chain integrity
    try {
      const chainHead = this.eventLoop.audit.getChainHead();
      if (chainHead.count === 0) {
        checks.push({ name: 'Audit chain', status: 'info', message: 'Empty chain (no entries yet)' });
      } else {
        // Verify last 100 entries for speed (full verify would be slow on large chains)
        const verifyLimit = Math.min(chainHead.count, 100);
        const result = this.eventLoop.audit.verifyChain(verifyLimit);
        if (result.intact) {
          checks.push({
            name: 'Audit chain',
            status: 'ok',
            message: `${chainHead.count} entries, chain intact (verified last ${verifyLimit})`,
          });
        } else {
          checks.push({
            name: 'Audit chain',
            status: 'fail',
            message: `Chain broken at entry ${result.brokenAt} of ${result.total}`,
          });
        }
      }
    } catch (err) {
      checks.push({
        name: 'Audit chain',
        status: 'fail',
        message: `Audit check error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 6. RAG index health
    try {
      const ragStats = this.rag.stats();
      const vaultFiles = this.memory.vault.listFiles();
      const indexedCount = ragStats.filesIndexed;
      const totalFiles = vaultFiles.length;

      if (totalFiles === 0) {
        checks.push({ name: 'RAG index', status: 'info', message: 'No vault files to index' });
      } else if (indexedCount >= totalFiles) {
        checks.push({
          name: 'RAG index',
          status: 'ok',
          message: `${indexedCount}/${totalFiles} files indexed, ${ragStats.chunksStored} chunks`,
        });
      } else if (indexedCount > 0) {
        checks.push({
          name: 'RAG index',
          status: 'warn',
          message: `${indexedCount}/${totalFiles} files indexed (${totalFiles - indexedCount} stale). Run 'ved reindex'`,
          fixable: true,
        });
      } else {
        checks.push({
          name: 'RAG index',
          status: 'warn',
          message: `Index empty with ${totalFiles} vault files. Run 'ved reindex'`,
          fixable: true,
        });
      }
    } catch (err) {
      checks.push({
        name: 'RAG index',
        status: 'warn',
        message: `RAG check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 7. LLM connectivity
    try {
      const llmHealth = await this.llm.healthCheck();
      if (llmHealth.healthy) {
        checks.push({ name: 'LLM', status: 'ok', message: llmHealth.details ?? 'Connected' });
      } else {
        checks.push({
          name: 'LLM',
          status: 'warn',
          message: llmHealth.details ?? 'LLM health check failed',
        });
      }
    } catch (err) {
      checks.push({
        name: 'LLM',
        status: 'warn',
        message: `LLM check error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 8. MCP tools
    try {
      const mcpHealth = await this.mcp.healthCheck();
      if (mcpHealth.healthy) {
        checks.push({ name: 'MCP tools', status: 'ok', message: mcpHealth.details ?? 'Connected' });
      } else {
        checks.push({
          name: 'MCP tools',
          status: 'info',
          message: mcpHealth.details ?? 'No MCP servers configured',
        });
      }
    } catch (err) {
      checks.push({
        name: 'MCP tools',
        status: 'info',
        message: `MCP check: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Tally
    const passed = checks.filter(c => c.status === 'ok').length;
    const warned = checks.filter(c => c.status === 'warn').length;
    const failed = checks.filter(c => c.status === 'fail').length;
    const infos = checks.filter(c => c.status === 'info').length;

    return { checks, passed, warned, failed, infos };
  }

  // ── Plugin (MCP Server Manager) ──

  /**
   * List all configured MCP servers with state/tool count.
   */
  pluginList(): ServerInfo[] {
    return this.mcp.getServers();
  }

  /**
   * List all discovered MCP tools. If serverName given, filter to that server.
   */
  pluginTools(serverName?: string): MCPToolDefinition[] {
    const tools = this.mcp.tools;
    if (!serverName) return tools;
    return tools.filter(t => t.serverName === serverName);
  }

  /**
   * Test a server: connect, list tools, return results.
   */
  async pluginTest(serverName: string): Promise<PluginTestResult> {
    const startMs = Date.now();
    const servers = this.mcp.getServers();
    const info = servers.find(s => s.name === serverName);
    if (!info) {
      return {
        serverName,
        success: false,
        toolCount: 0,
        tools: [],
        durationMs: 0,
        error: `Server "${serverName}" not registered`,
      };
    }

    try {
      const result = await this.mcp.testServer(serverName);
      return {
        serverName,
        success: true,
        toolCount: result.tools.length,
        tools: result.tools.map(t => t.originalName),
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        serverName,
        success: false,
        toolCount: 0,
        tools: [],
        durationMs: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Add a server to the MCP client at runtime.
   * Note: not persisted to config.yaml — session only.
   */
  async pluginAdd(config: MCPServerConfig): Promise<void> {
    await this.mcp.addServer(config);
  }

  /**
   * Remove a server from the MCP client at runtime.
   * Returns true if removed, false if not found.
   */
  async pluginRemove(name: string): Promise<boolean> {
    return this.mcp.removeServer(name);
  }

  // ── GC (Garbage Collection) ──

  /**
   * Report what GC would clean without acting.
   */
  gcStatus(options?: { sessionsDays?: number; auditDays?: number }): GcStatus {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');

    const sessionsDays = options?.sessionsDays ?? 30;
    const auditDays = options?.auditDays ?? 90;
    const sessionsCutoff = Date.now() - sessionsDays * 24 * 60 * 60 * 1000;
    const auditCutoff = Date.now() - auditDays * 24 * 60 * 60 * 1000;

    const staleSessions = this.db.prepare(
      `SELECT id FROM sessions WHERE status IN ('active', 'idle') AND last_active < ?`
    ).all(sessionsCutoff) as { id: string }[];

    const oldAuditCount = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM audit_log WHERE timestamp < ?`
    ).get(auditCutoff) as { cnt: number }).cnt;

    return {
      staleSessions: staleSessions.length,
      staleSessionIds: staleSessions.map(s => s.id),
      oldAuditEntries: oldAuditCount,
      oldAuditCutoff: auditCutoff,
      auditWarning: oldAuditCount > 0
        ? 'Deleting audit entries breaks the hash chain. Use --force to proceed.'
        : undefined,
    };
  }

  /**
   * Run garbage collection: close stale sessions, optionally purge old audit entries, VACUUM.
   */
  gcRun(options?: { sessionsDays?: number; auditDays?: number; auditForce?: boolean }): GcResult {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');

    const startMs = Date.now();
    const sessionsDays = options?.sessionsDays ?? 30;
    const auditDays = options?.auditDays ?? 90;
    const sessionsCutoff = Date.now() - sessionsDays * 24 * 60 * 60 * 1000;
    const auditCutoff = Date.now() - auditDays * 24 * 60 * 60 * 1000;

    // Close stale sessions
    const sessionResult = this.db.prepare(
      `UPDATE sessions SET status = 'closed', closed_at = ? WHERE status IN ('active', 'idle') AND last_active < ?`
    ).run(Date.now(), sessionsCutoff);
    const sessionsClosed = sessionResult.changes;

    if (sessionsClosed > 0 && this.initialized) {
      this.eventLoop.audit.append({
        eventType: 'gc_sessions_cleaned',
        actor: 'ved',
        detail: { count: sessionsClosed, cutoffDays: sessionsDays },
      });
    }

    // Delete old audit entries only with explicit --force
    let auditEntriesDeleted = 0;
    if (options?.auditForce) {
      const auditResult = this.db.prepare(
        `DELETE FROM audit_log WHERE timestamp < ?`
      ).run(auditCutoff);
      auditEntriesDeleted = auditResult.changes;
    }

    // VACUUM SQLite to reclaim space
    this.db.exec('VACUUM');

    if (this.initialized) {
      this.eventLoop.audit.append({
        eventType: 'gc_vacuum',
        actor: 'ved',
        detail: { sessionsClosed, auditEntriesDeleted },
      });
    }

    return {
      sessionsClosed,
      auditEntriesDeleted,
      vacuumed: true,
      durationMs: Date.now() - startMs,
    };
  }

  // ── Backup ──

  /**
   * Create a backup of the vault + database.
   * Returns the backup filename and path.
   */
  createBackup(options?: { backupDir?: string; maxBackups?: number }): {
    filename: string;
    path: string;
    vaultFiles: number;
    sizeBytes: number;
  } {
    const backupDir = options?.backupDir ?? join(dirname(this.config.dbPath), 'backups');
    const maxBackups = options?.maxBackups ?? 10;

    mkdirSync(backupDir, { recursive: true });

    // Generate timestamped filename
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const filename = `ved-backup-${ts}.tar.gz`;
    const backupPath = join(backupDir, filename);

    // Create temp staging directory
    const stagingDir = join(backupDir, `.staging-${Date.now()}`);
    mkdirSync(join(stagingDir, 'vault'), { recursive: true });

    try {
      // Copy vault files
      const vaultFiles = this._copyDir(this.config.memory.vaultPath, join(stagingDir, 'vault'));

      // Copy database (safe: WAL checkpoint first)
      if (this.db) {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      }
      copyFileSync(this.config.dbPath, join(stagingDir, 'ved.db'));

      // Create tar.gz
      execSync(`tar -czf "${backupPath}" -C "${stagingDir}" .`, { stdio: 'pipe' });

      // Get size
      const sizeBytes = statSync(backupPath).size;

      // Audit log
      if (this.initialized) {
        this.eventLoop.audit.append({
          eventType: 'backup_created',
          actor: 'ved',
          detail: { filename, vaultFiles, sizeBytes, backupDir },
        });
      }

      // Rotate old backups
      this._rotateBackups(backupDir, maxBackups);

      return { filename, path: backupPath, vaultFiles, sizeBytes };
    } finally {
      // Clean up staging
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * List existing backups.
   */
  listBackups(backupDir?: string): {
    filename: string;
    path: string;
    sizeBytes: number;
    createdAt: Date;
  }[] {
    const dir = backupDir ?? join(dirname(this.config.dbPath), 'backups');
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter(f => f.startsWith('ved-backup-') && f.endsWith('.tar.gz'))
      .map(f => {
        const fullPath = join(dir, f);
        const stat = statSync(fullPath);
        return {
          filename: f,
          path: fullPath,
          sizeBytes: stat.size,
          createdAt: stat.mtime,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Restore vault + database from a backup archive.
   * WARNING: This overwrites the current vault and database.
   */
  restoreBackup(backupPath: string, options?: { dryRun?: boolean }): {
    vaultFiles: number;
    dbRestored: boolean;
  } {
    if (!existsSync(backupPath)) {
      throw new VedError('BACKUP_NOT_FOUND', `Backup not found: ${backupPath}`);
    }

    // Extract to temp dir to inspect
    const extractDir = join(dirname(backupPath), `.restore-${Date.now()}`);
    mkdirSync(extractDir, { recursive: true });

    try {
      execSync(`tar -xzf "${backupPath}" -C "${extractDir}"`, { stdio: 'pipe' });

      // Validate contents
      const hasVault = existsSync(join(extractDir, 'vault'));
      const hasDb = existsSync(join(extractDir, 'ved.db'));

      if (!hasVault && !hasDb) {
        throw new VedError('BACKUP_INVALID', 'Backup archive contains neither vault nor database');
      }

      // Count vault files
      let vaultFiles = 0;
      if (hasVault) {
        vaultFiles = this._countFiles(join(extractDir, 'vault'));
      }

      if (options?.dryRun) {
        return { vaultFiles, dbRestored: hasDb };
      }

      // Restore vault
      if (hasVault) {
        // Clear existing vault contents (keep the directory)
        const vaultPath = this.config.memory.vaultPath;
        if (existsSync(vaultPath)) {
          for (const entry of readdirSync(vaultPath)) {
            if (entry === '.git') continue; // Preserve git history
            rmSync(join(vaultPath, entry), { recursive: true, force: true });
          }
        } else {
          mkdirSync(vaultPath, { recursive: true });
        }
        // Copy restored files
        this._copyDir(join(extractDir, 'vault'), vaultPath);
      }

      // Restore database
      if (hasDb) {
        // Close current DB connection
        if (this.db) {
          this.db.close();
          this.db = null;
        }
        copyFileSync(join(extractDir, 'ved.db'), this.config.dbPath);
      }

      // Audit log (re-open DB for this)
      if (hasDb) {
        this.db = new Database(this.config.dbPath);
        this.db.pragma('journal_mode = WAL');
      }

      if (this.db) {
        // Re-create audit with new DB
        this.eventLoop.audit.reload(this.db);
        this.eventLoop.audit.append({
          eventType: 'backup_restored',
          actor: 'ved',
          detail: { source: basename(backupPath), vaultFiles, dbRestored: hasDb },
        });
      }

      return { vaultFiles, dbRestored: hasDb };
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }

  /**
   * Recursively copy a directory. Returns file count.
   */
  private _copyDir(src: string, dest: string): number {
    if (!existsSync(src)) return 0;
    mkdirSync(dest, { recursive: true });
    let count = 0;

    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.name === '.git') continue; // Skip .git dirs

      if (entry.isDirectory()) {
        count += this._copyDir(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
        count++;
      }
    }
    return count;
  }

  /**
   * Count files recursively in a directory.
   */
  private _countFiles(dir: string): number {
    if (!existsSync(dir)) return 0;
    let count = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += this._countFiles(join(dir, entry.name));
      } else {
        count++;
      }
    }
    return count;
  }

  /**
   * Rotate backups: keep only the most recent maxBackups.
   */
  private _rotateBackups(backupDir: string, maxBackups: number): void {
    const backups = this.listBackups(backupDir);
    if (backups.length <= maxBackups) return;

    // Delete oldest backups
    const toDelete = backups.slice(maxBackups);
    for (const b of toDelete) {
      rmSync(b.path, { force: true });
      log.info('Rotated old backup', { filename: b.filename });
    }
  }

  // ── Cron ──

  /**
   * List all cron jobs.
   */
  cronList(): CronJob[] {
    return this.cron.list();
  }

  /**
   * Get a cron job by ID or name.
   */
  cronGet(idOrName: string): CronJob | null {
    return this.cron.get(idOrName);
  }

  /**
   * Add a new cron job.
   */
  cronAdd(input: CronJobInput): CronJob {
    return this.cron.add(input);
  }

  /**
   * Remove a cron job.
   */
  cronRemove(idOrName: string): boolean {
    return this.cron.remove(idOrName);
  }

  /**
   * Enable/disable a cron job.
   */
  cronToggle(idOrName: string, enabled: boolean): CronJob | null {
    return this.cron.toggle(idOrName, enabled);
  }

  /**
   * Manually run a cron job.
   */
  async cronRun(idOrName: string): Promise<CronRunResult> {
    return this.cron.runNow(idOrName);
  }

  /**
   * Get cron execution history.
   */
  cronHistory(jobName?: string, limit?: number): CronHistoryEntry[] {
    return this.cron.history(jobName, limit);
  }

  /**
   * Execute a cron job by type.
   * Built-in types: backup, reindex, doctor.
   */
  private async executeCronJob(job: CronJob): Promise<CronRunResult> {
    const startTime = Date.now();
    const config = JSON.parse(job.jobConfig || '{}');

    try {
      switch (job.jobType) {
        case 'backup': {
          const result = this.createBackup({
            backupDir: config.backupDir,
            maxBackups: config.maxBackups,
          });
          return {
            jobId: job.id,
            jobName: job.name,
            jobType: job.jobType,
            success: true,
            message: `Backup created: ${result.filename} (${result.vaultFiles} files, ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
            durationMs: Date.now() - startTime,
          };
        }

        case 'reindex': {
          const stats = await this.reindexVault();
          return {
            jobId: job.id,
            jobName: job.name,
            jobType: job.jobType,
            success: true,
            message: `Re-indexed: ${stats.filesIndexed} files, ${stats.chunksStored} chunks, ${stats.graphEdges} edges`,
            durationMs: Date.now() - startTime,
          };
        }

        case 'doctor': {
          const result = await this.doctor();
          const ok = result.failed === 0;
          return {
            jobId: job.id,
            jobName: job.name,
            jobType: job.jobType,
            success: ok,
            message: `Doctor: ${result.passed} passed, ${result.warned} warnings, ${result.failed} failed`,
            durationMs: Date.now() - startTime,
            error: ok ? undefined : `${result.failed} check(s) failed`,
          };
        }

        default:
          return {
            jobId: job.id,
            jobName: job.name,
            jobType: job.jobType,
            success: false,
            message: `Unknown job type: ${job.jobType}`,
            durationMs: Date.now() - startTime,
            error: `Unsupported job type: ${job.jobType}`,
          };
      }
    } catch (err) {
      return {
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: false,
        message: `Job failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Start the cron tick interval (checks for due jobs every 30s).
   */
  private startCronTick(): void {
    this.cronTickInterval = setInterval(async () => {
      try {
        const executed = await this.cron.tick();
        if (executed > 0) {
          log.info('Cron tick executed jobs', { count: executed });
        }
      } catch (err) {
        log.warn('Cron tick error', { error: err instanceof Error ? err.message : String(err) });
      }
    }, 30_000);
    this.cronTickInterval.unref();
    log.info('Cron tick started (30s interval)');
  }

  /**
   * Stop the cron tick interval.
   */
  private stopCronTick(): void {
    if (this.cronTickInterval) {
      clearInterval(this.cronTickInterval);
      this.cronTickInterval = null;
    }
  }

  // ── Upgrade (Version Migration Management) ──

  /**
   * Get current schema version and available migration info.
   */
  getUpgradeStatus(): {
    currentVersion: number;
    availableVersions: number;
    pendingCount: number;
    dbPath: string;
  } {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');
    const current = currentVersion(this.db);
    // Count available migration files
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'db', 'migrations');
    const files = readdirSync(migrationsDir).filter(f => /^v\d{3}_.*\.sql$/.test(f));
    const available = files.length;
    return {
      currentVersion: current,
      availableVersions: available,
      pendingCount: Math.max(0, available - current),
      dbPath: this.config.dbPath,
    };
  }

  /**
   * Verify migration integrity (checksums of applied vs on-disk).
   */
  verifyMigrations(): string[] {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');
    return verifyMigrations(this.db);
  }

  /**
   * Run pending migrations. Returns count applied.
   * Migrations are already run on VedApp construction, so this is mainly
   * for explicit CLI invocation after adding new migration files.
   */
  runMigrations(): number {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');
    return migrate(this.db);
  }

  /**
   * Get details of all applied migrations from schema_version table.
   */
  getAppliedMigrations(): Array<{
    version: number;
    filename: string;
    checksum: string;
    appliedAt: number;
    description: string;
  }> {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');
    const tableExists = this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'
    `).get();
    if (!tableExists) return [];

    return this.db.prepare(`
      SELECT version, filename, checksum, applied_at as appliedAt, description
      FROM schema_version ORDER BY version
    `).all() as Array<{
      version: number;
      filename: string;
      checksum: string;
      appliedAt: number;
      description: string;
    }>;
  }

  // ── Watch (Standalone Vault Watcher) ──

  /**
   * Run vault watcher in standalone mode (no event loop, no channels).
   * Watches vault files for changes and triggers RAG re-indexing.
   * Blocks until stopped via signal.
   */
  async runWatch(): Promise<void> {
    await this.init();

    // Auto-commit dirty vault files
    this.autoCommitVault();

    // Index existing vault files
    await this.indexVaultOnStartup();

    // Start watcher
    this.startVaultWatcher();

    log.info('Vault watcher running in standalone mode (Ctrl+C to stop)');

    // Block until shutdown signal
    return new Promise<void>((resolve) => {
      const shutdown = () => {
        this.stopVaultWatcher();
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  }

  // ── Completions ──

  /**
   * Generate shell completions for bash, zsh, or fish.
   */
  static generateCompletions(shell: 'bash' | 'zsh' | 'fish'): string {
    const commands = [
      'init', 'start', 'run', 'serve', 'status', 'stats', 'search', 'reindex',
      'config', 'export', 'import', 'history', 'doctor', 'backup', 'cron',
      'completions', 'upgrade', 'watch', 'webhook', 'plugin', 'gc', 'version',
    ];
    const configSubs = ['validate', 'show', 'path'];
    const backupSubs = ['create', 'list', 'restore'];
    const cronSubs = ['list', 'add', 'remove', 'enable', 'disable', 'run', 'history'];
    const upgradeSubs = ['status', 'run', 'verify', 'history'];
    const pluginSubs = ['list', 'tools', 'test', 'add', 'remove'];
    const webhookSubs = ['list', 'add', 'remove', 'enable', 'disable', 'deliveries', 'stats', 'test'];
    const gcSubs = ['run', 'status'];

    switch (shell) {
      case 'bash':
        return `# Ved bash completions — add to ~/.bashrc or ~/.bash_completion
_ved_completions() {
  local cur prev cmds
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmds="${commands.join(' ')}"

  case "\${prev}" in
    config)
      COMPREPLY=( $(compgen -W "${configSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    backup)
      COMPREPLY=( $(compgen -W "${backupSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    cron)
      COMPREPLY=( $(compgen -W "${cronSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    upgrade)
      COMPREPLY=( $(compgen -W "${upgradeSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    plugin)
      COMPREPLY=( $(compgen -W "${pluginSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    gc)
      COMPREPLY=( $(compgen -W "${gcSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    webhook)
      COMPREPLY=( $(compgen -W "${webhookSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    restore)
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return 0
      ;;
    search)
      COMPREPLY=( $(compgen -W "-n --limit --fts-only --verbose" -- "\${cur}") )
      return 0
      ;;
    history)
      COMPREPLY=( $(compgen -W "-n --limit --type --from --to --verify --types --json" -- "\${cur}") )
      return 0
      ;;
    export)
      COMPREPLY=( $(compgen -W "-o --output --pretty --include-audit --include-stats --folder" -- "\${cur}") )
      return 0
      ;;
    import)
      COMPREPLY=( $(compgen -f -W "--dry-run --merge --overwrite" -- "\${cur}") )
      return 0
      ;;
  esac

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${cmds}" -- "\${cur}") )
  fi

  return 0
}
complete -F _ved_completions ved
`;

      case 'zsh':
        return `#compdef ved
# Ved zsh completions — add to fpath or source in ~/.zshrc

_ved() {
  local -a commands
  commands=(
    'init:Create ~/.ved/ with default config'
    'start:Start Ved in interactive mode'
    'run:Alias for start'
    'serve:Start HTTP API server'
    'status:Show health check'
    'stats:Show vault/RAG/audit/session metrics'
    'search:Search vault via RAG pipeline'
    'reindex:Force full RAG re-index'
    'config:Manage configuration'
    'export:Export vault to JSON'
    'import:Import vault from JSON'
    'history:View audit history'
    'doctor:Run self-diagnostics'
    'backup:Vault + database snapshots'
    'cron:Manage scheduled jobs'
    'upgrade:Manage database migrations'
    'watch:Watch vault for changes (standalone)'
    'webhook:Manage webhook event delivery'
    'completions:Generate shell completions'
    'version:Show version'
  )

  _arguments -C \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case \$state in
    cmd)
      _describe 'ved commands' commands
      ;;
    args)
      case \$words[1] in
        config)
          _values 'subcommand' 'validate[Check config for errors]' 'show[Print resolved config]' 'path[Print config directory]'
          ;;
        backup)
          _values 'subcommand' 'create[Create a new backup]' 'list[List existing backups]' 'restore[Restore from backup]'
          ;;
        cron)
          _values 'subcommand' 'list[List scheduled jobs]' 'add[Add a job]' 'remove[Remove a job]' 'enable[Enable a job]' 'disable[Disable a job]' 'run[Manually trigger a job]' 'history[Show execution history]'
          ;;
        upgrade)
          _values 'subcommand' 'status[Show migration status]' 'run[Apply pending migrations]' 'verify[Check migration integrity]' 'history[Show applied migrations]'
          ;;
        webhook)
          _values 'subcommand' 'list[List webhooks]' 'add[Register a webhook]' 'remove[Remove a webhook]' 'enable[Enable a webhook]' 'disable[Disable a webhook]' 'deliveries[View delivery history]' 'stats[Delivery statistics]' 'test[Send a test event]'
          ;;
        serve)
          _arguments \\
            '-p[Port]:port' \\
            '--port[Port]:port' \\
            '-h[Host]:host' \\
            '--host[Host]:host' \\
            '-t[API token]:token' \\
            '--token[API token]:token' \\
            '--cors[CORS origin]:origin'
          ;;
        search)
          _arguments \\
            '-n[Max results]:number' \\
            '--limit[Max results]:number' \\
            '--fts-only[FTS search only]' \\
            '--verbose[Show search metrics]' \\
            '*:query'
          ;;
        history)
          _arguments \\
            '-n[Max entries]:number' \\
            '--type[Filter by event type]:type' \\
            '--from[Filter from date]:date' \\
            '--to[Filter to date]:date' \\
            '--verify[Verify hash chain]' \\
            '--types[List event types]' \\
            '--json[JSON output]'
          ;;
        export)
          _arguments \\
            '-o[Output file]:file:_files' \\
            '--pretty[Pretty-print JSON]' \\
            '--include-audit[Include audit entries]' \\
            '--include-stats[Include stats]' \\
            '--folder[Export single folder]:folder'
          ;;
        import)
          _arguments \\
            '--dry-run[Preview without writing]' \\
            '--merge[Skip existing files]' \\
            '--overwrite[Overwrite existing files]' \\
            '*:file:_files'
          ;;
        restore)
          _files -g '*.tar.gz'
          ;;
      esac
      ;;
  esac
}

_ved
`;

      case 'fish':
        return `# Ved fish completions — save to ~/.config/fish/completions/ved.fish

# Disable file completions by default
complete -c ved -f

# Top-level commands
${commands.map(c => `complete -c ved -n '__fish_use_subcommand' -a '${c}'`).join('\n')}

# config subcommands
${configSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from config' -a '${s}'`).join('\n')}

# backup subcommands
${backupSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from backup' -a '${s}'`).join('\n')}

# cron subcommands
${cronSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from cron' -a '${s}'`).join('\n')}

# upgrade subcommands
${upgradeSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from upgrade' -a '${s}'`).join('\n')}

# webhook subcommands
${webhookSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from webhook' -a '${s}'`).join('\n')}

# serve flags
complete -c ved -n '__fish_seen_subcommand_from serve' -s p -l port -d 'Port'
complete -c ved -n '__fish_seen_subcommand_from serve' -s h -l host -d 'Host'
complete -c ved -n '__fish_seen_subcommand_from serve' -s t -l token -d 'API token'
complete -c ved -n '__fish_seen_subcommand_from serve' -l cors -d 'CORS origin'

# search flags
complete -c ved -n '__fish_seen_subcommand_from search' -s n -l limit -d 'Max results'
complete -c ved -n '__fish_seen_subcommand_from search' -l fts-only -d 'FTS search only'
complete -c ved -n '__fish_seen_subcommand_from search' -s v -l verbose -d 'Show metrics'

# history flags
complete -c ved -n '__fish_seen_subcommand_from history' -s n -l limit -d 'Max entries'
complete -c ved -n '__fish_seen_subcommand_from history' -s t -l type -d 'Filter by event type'
complete -c ved -n '__fish_seen_subcommand_from history' -l from -d 'From date'
complete -c ved -n '__fish_seen_subcommand_from history' -l to -d 'To date'
complete -c ved -n '__fish_seen_subcommand_from history' -l verify -d 'Verify chain'
complete -c ved -n '__fish_seen_subcommand_from history' -l types -d 'List event types'
complete -c ved -n '__fish_seen_subcommand_from history' -l json -d 'JSON output'

# export flags
complete -c ved -n '__fish_seen_subcommand_from export' -s o -l output -d 'Output file' -F
complete -c ved -n '__fish_seen_subcommand_from export' -l pretty -d 'Pretty-print'
complete -c ved -n '__fish_seen_subcommand_from export' -l include-audit -d 'Include audit'
complete -c ved -n '__fish_seen_subcommand_from export' -l include-stats -d 'Include stats'
complete -c ved -n '__fish_seen_subcommand_from export' -l folder -d 'Single folder'

# import flags
complete -c ved -n '__fish_seen_subcommand_from import' -l dry-run -d 'Preview only'
complete -c ved -n '__fish_seen_subcommand_from import' -l merge -d 'Skip existing'
complete -c ved -n '__fish_seen_subcommand_from import' -l overwrite -d 'Overwrite existing'

# backup flags
complete -c ved -n '__fish_seen_subcommand_from backup; and __fish_seen_subcommand_from create' -s d -l dir -d 'Backup directory'
complete -c ved -n '__fish_seen_subcommand_from backup; and __fish_seen_subcommand_from create' -s n -l max -d 'Max backups to keep'
complete -c ved -n '__fish_seen_subcommand_from backup; and __fish_seen_subcommand_from restore' -F
`;

      default:
        throw new Error(`Unknown shell: ${shell}`);
    }
  }

  // ── Vault Indexing ──

  /**
   * Read all vault files and return them as VaultFile objects.
   */
  private readAllVaultFiles(folder?: string): VaultFile[] {
    const vault = this.memory.vault;
    const allPaths = vault.listFiles(folder);
    const files: VaultFile[] = [];

    for (const relPath of allPaths) {
      try {
        const file = vault.readFile(relPath);
        files.push(file);
      } catch (err) {
        log.warn('Failed to read vault file for indexing', {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return files;
  }

  /**
   * Index vault files into RAG on startup.
   * - If index is empty → full reindex.
   * - If index is populated → incremental (only files modified since last indexed_at).
   */
  private async indexVaultOnStartup(): Promise<void> {
    const existingStats = this.rag.stats();

    const files = this.readAllVaultFiles();
    if (files.length === 0) {
      log.info('No vault files found, skipping startup indexing');
      return;
    }

    if (existingStats.filesIndexed === 0) {
      // Empty index → full reindex
      log.info('RAG index empty, performing full startup indexing...', { fileCount: files.length });
      const startTime = Date.now();
      const stats = await this.rag.fullReindex(files);
      const elapsed = Date.now() - startTime;

      log.info('Full startup indexing complete', {
        filesIndexed: stats.filesIndexed,
        chunksStored: stats.chunksStored,
        graphEdges: stats.graphEdges,
        elapsedMs: elapsed,
      });
      return;
    }

    // Populated index → incremental: only re-index files modified since their last indexed_at
    const staleFiles = this.findStaleFiles(files);

    if (staleFiles.length === 0) {
      log.info('All vault files up-to-date in RAG index', {
        filesIndexed: existingStats.filesIndexed,
      });
      return;
    }

    log.info('Incremental startup indexing...', {
      staleFiles: staleFiles.length,
      totalFiles: files.length,
    });

    const startTime = Date.now();
    for (const file of staleFiles) {
      await this.rag.indexFile(file);
    }
    const elapsed = Date.now() - startTime;

    log.info('Incremental startup indexing complete', {
      reindexed: staleFiles.length,
      elapsedMs: elapsed,
    });
  }

  /**
   * Find vault files that have been modified since they were last indexed.
   * Also returns files not yet in the index.
   */
  private findStaleFiles(files: VaultFile[]): VaultFile[] {
    const stale: VaultFile[] = [];

    for (const file of files) {
      const fileMtime = file.stats.modified.getTime();
      const indexedAt = this.getFileIndexedAt(file.path);

      if (indexedAt === null || fileMtime > indexedAt) {
        stale.push(file);
      }
    }

    return stale;
  }

  /**
   * Get the indexed_at timestamp for a file from the RAG chunks table.
   * Returns null if file is not indexed.
   */
  private getFileIndexedAt(filePath: string): number | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      'SELECT MAX(indexed_at) as indexed_at FROM chunks WHERE file_path = ?'
    ).get(filePath) as { indexed_at: number | null } | undefined;
    return row?.indexed_at ?? null;
  }

  /**
   * Force full RAG re-index of all vault files.
   * Used by `ved reindex` CLI command.
   */
  async reindexVault(): Promise<IndexStats> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }

    const files = this.readAllVaultFiles();
    log.info('Starting full vault re-index...', { fileCount: files.length });

    const startTime = Date.now();
    const stats = await this.rag.fullReindex(files);
    const elapsed = Date.now() - startTime;

    log.info('Full vault re-index complete', {
      filesIndexed: stats.filesIndexed,
      chunksStored: stats.chunksStored,
      graphEdges: stats.graphEdges,
      elapsedMs: elapsed,
    });

    return stats;
  }

  // ── Vault Git ──

  /**
   * Auto-commit any untracked/modified vault files on startup.
   * Ensures git state is clean before indexing begins.
   */
  private autoCommitVault(): void {
    const git = this.memory.vault.git;
    if (!git.isRepo) return;

    if (git.isClean()) {
      log.debug('Vault git is clean, no auto-commit needed');
      return;
    }

    // Stage all untracked/modified files and commit
    try {
      git.stage(['.']);
      git.commit('ved: startup auto-commit — uncommitted changes found');
      log.info('Auto-committed dirty vault files on startup');
    } catch (err) {
      log.warn('Vault auto-commit failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Vault Watcher ──

  private vaultDrainInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Wire vault file changes → RAG re-index queue.
   * Starts the vault filesystem watcher and a periodic drain loop.
   */
  private startVaultWatcher(): void {
    const vault = this.memory.vault;

    // Register handler: enqueue changed files for RAG re-index
    vault.onFileChanged((path: string, changeType: 'create' | 'update' | 'delete') => {
      if (changeType === 'delete') {
        this.rag.removeFile(path);
        log.debug('Vault file removed from RAG index', { path });
      } else {
        this.rag.enqueueReindex(path);
        log.debug('Vault file queued for RAG re-index', { path, changeType });
      }
    });

    // Start filesystem watch
    vault.startWatch();

    // Drain re-index queue every 10 seconds
    this.vaultDrainInterval = setInterval(async () => {
      try {
        const processed = await this.rag.drainQueue(async (p: string) => {
          try {
            return vault.readFile(p);
          } catch {
            return null;
          }
        });
        if (processed > 0) {
          log.info('RAG re-index drained', { processed });
        }
      } catch (err) {
        log.warn('RAG drain failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }, 10_000);

    // Unref so timer doesn't prevent process exit
    this.vaultDrainInterval.unref();

    log.info('Vault watcher started — file changes will trigger RAG re-indexing');
  }

  /**
   * Stop the vault watcher and drain timer.
   */
  private stopVaultWatcher(): void {
    if (this.vaultDrainInterval) {
      clearInterval(this.vaultDrainInterval);
      this.vaultDrainInterval = null;
    }

    this.memory.vault.stopWatch();
    log.info('Vault watcher stopped');
  }
}

/**
 * Create a VedApp with config loaded from files + env + overrides.
 */
export function createApp(options?: VedAppOptions): VedApp {
  const config = loadConfig(options?.configOverrides);
  return new VedApp(config);
}
