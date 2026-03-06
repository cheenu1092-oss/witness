/**
 * VedApp — Top-level application wiring.
 *
 * Creates, initializes, and wires all modules together.
 * Provides the main `start()` / `stop()` lifecycle.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from './core/log.js';
import { loadConfig } from './core/config.js';
import { migrate } from './db/migrate.js';
import { EventLoop } from './core/event-loop.js';
import { LLMClient } from './llm/client.js';
import { MCPClient } from './mcp/client.js';
import { MemoryManager } from './memory/manager.js';
import { VaultManager } from './memory/vault.js';
import { RagPipeline } from './rag/pipeline.js';
import { ChannelManager } from './channel/manager.js';
import type { VedConfig, ModuleHealth } from './types/index.js';

const log = createLogger('app');

export interface VedAppOptions {
  /** Override config (merged on top of files + env) */
  configOverrides?: Partial<VedConfig>;
  /** Skip config validation (for testing) */
  skipValidation?: boolean;
}

export class VedApp {
  readonly config: VedConfig;

  // Database
  private db: Database.Database | null = null;

  // Modules
  readonly eventLoop: EventLoop;
  readonly llm: LLMClient;
  readonly mcp: MCPClient;
  readonly memory: MemoryManager;
  readonly rag: RagPipeline;
  readonly channels: ChannelManager;

  private initialized = false;

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

    // Start channel adapters (Discord, CLI, etc.)
    await this.channels.startAll();

    // Wire channel messages → event loop
    this.channels.onMessage((msg) => {
      this.eventLoop.receive(msg);
    });

    // Start vault filesystem watcher → RAG re-index on changes
    this.startVaultWatcher();

    log.info('Ved is running');

    // Enter the main event loop (blocks)
    await this.eventLoop.run();
  }

  /**
   * Request graceful shutdown.
   */
  async stop(): Promise<void> {
    log.info('Stopping Ved...');

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
