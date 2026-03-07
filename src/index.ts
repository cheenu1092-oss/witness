/**
 * Ved — The personal AI agent that remembers everything and proves it.
 *
 * Root module exports for library consumption.
 */

// Core
export { EventLoop } from './core/event-loop.js';
export { SessionManager } from './core/session.js';
export { WorkingMemory } from './core/working-memory.js';
export { MessageQueue } from './core/queue.js';
export { loadConfig } from './core/config.js';
export { createLogger } from './core/log.js';

// Database
export { migrate, currentVersion, verifyMigrations } from './db/migrate.js';

// Audit
export { AuditLog } from './audit/store.js';

// Trust
export { TrustEngine } from './trust/engine.js';
export { WorkOrderManager } from './trust/work-orders.js';

// LLM
export { LLMClient } from './llm/client.js';

// MCP
export { MCPClient } from './mcp/client.js';

// Memory
export { MemoryManager } from './memory/manager.js';
export { VaultManager } from './memory/vault.js';
export { VaultGit } from './memory/vault-git.js';

// RAG
export { RagPipeline } from './rag/pipeline.js';
export { OllamaEmbedder } from './rag/embedder.js';
export { chunkFile, estimateTokens } from './rag/chunker.js';

// Channel
export { ChannelManager } from './channel/manager.js';

// Types
export type {
  VedConfig, VedModule, ModuleHealth,
  VedMessage, VedResponse,
  ChannelId, TrustTier, RiskLevel,
  ToolCall, ToolResult, WorkOrder,
} from './types/index.js';

export { VedError } from './types/errors.js';

// Export/Import
export type { VaultExport, VaultExportFile, ExportOptions, ImportResult } from './export-types.js';

// HTTP
export { VedHttpServer } from './http.js';
export type { HttpServerConfig } from './http.js';

// Event Bus
export { EventBus } from './event-bus.js';
export { WebhookManager } from './webhook.js';
export type { Webhook, WebhookInput, WebhookDelivery, WebhookStats } from './webhook.js';
export type { VedEvent, EventSubscriber, Subscription } from './event-bus.js';
export { getDashboardHtml } from './dashboard.js';

// App
export { VedApp, createApp } from './app.js';
