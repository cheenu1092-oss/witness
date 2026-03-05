// ============================================================
// ved-types/index.ts — Shared type definitions for all modules
// Types-only: no runtime code.
// ============================================================

// === Identifiers ===

/** ULID — sortable, unique, monotonic */
export type VedId = string;

/** Channel identifier */
export type ChannelId = 'discord' | 'cli' | 'push' | 'cron';

/** Author identifier — user ID string or 'ved' for system */
export type AuthorId = string;

/** Trust tier — 1 (stranger) to 4 (owner) */
export type TrustTier = 1 | 2 | 3 | 4;

/** Risk level for tool operations */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Action lifecycle status */
export type ActionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'executing' | 'completed' | 'failed';

/** Session lifecycle states */
export type SessionStatus = 'active' | 'idle' | 'closed';

/** Confidence levels for vault entries */
export type Confidence = 'high' | 'medium' | 'low';

/** Source of knowledge */
export type KnowledgeSource = 'conversation' | 'observation' | 'research' | 'manual';

/** Vault entity types (maps to folder structure) */
export type VaultEntityType = 'person' | 'org' | 'place' | 'project' | 'concept' | 'decision' | 'topic' | 'daily';

/** Trust decision from the trust×risk matrix */
export type TrustDecision = 'auto' | 'approve' | 'deny';

// === Core Messages ===

export interface VedMessage {
  id: VedId;
  channel: ChannelId;
  author: AuthorId;
  content: string;
  attachments?: Attachment[];
  replyTo?: VedId;
  timestamp: number; // unix ms
}

export interface Attachment {
  filename: string;
  contentType: string;
  url?: string;
  data?: Buffer;
  size: number;
}

export interface VedResponse {
  id: VedId;
  inReplyTo: VedId;
  content: string;
  actions: WorkOrder[];
  memoryOps: MemoryOp[];
  channelRef?: string; // channel-specific routing info
}

// === Memory Operations ===

export type MemoryOp =
  | WorkingMemoryOp
  | EpisodicWriteOp
  | SemanticUpsertOp
  | ArchivalLogOp
  | RagIndexOp;

export interface WorkingMemoryOp {
  type: 'working_set';
  action: 'add' | 'update' | 'remove';
  key: string;
  value?: string;
}

export interface EpisodicWriteOp {
  type: 'episodic_write';
  path: string; // relative vault path (e.g. daily/2026-03-04.md)
  content: string;
  append: boolean; // true = append, false = overwrite
}

export interface SemanticUpsertOp {
  type: 'semantic_upsert';
  path: string; // relative vault path
  frontmatter?: Record<string, unknown>;
  body?: string;
  links: string[]; // wikilinks to add
}

export interface ArchivalLogOp {
  type: 'archival_log';
  entry: AuditEntryInput;
}

export interface RagIndexOp {
  type: 'rag_index';
  path: string; // file to re-index
}

// === Work Orders ===

export interface WorkOrder {
  id: VedId;
  sessionId: VedId;
  messageId: VedId;
  tool: string;
  toolServer: string;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
  riskReasons: string[];
  trustTier: TrustTier;
  status: ActionStatus;
  result?: unknown;
  error?: string;
  createdAt: number; // unix ms
  expiresAt: number; // unix ms
  resolvedAt?: number;
  resolvedBy?: string;
  auditId?: string;
}

// === Audit ===

export interface AuditEntry {
  id: VedId;
  timestamp: number; // unix ms
  eventType: AuditEventType;
  actor: AuthorId;
  sessionId?: string;
  detail: string; // JSON-serialized payload
  prevHash: string;
  hash: string; // SHA-256(prevHash + timestamp + eventType + actor + detail)
}

export interface AuditEntryInput {
  eventType: AuditEventType;
  actor?: AuthorId; // defaults to 'ved'
  sessionId?: string;
  detail: Record<string, unknown>;
}

export type AuditEventType =
  | 'message_received'
  | 'message_sent'
  | 'llm_call'
  | 'llm_response'
  | 'tool_requested'
  | 'tool_approved'
  | 'tool_denied'
  | 'tool_executed'
  | 'tool_error'
  | 'memory_t1_write'
  | 'memory_t1_delete'
  | 'memory_t2_compress'
  | 'memory_t3_upsert'
  | 'memory_t3_delete'
  | 'rag_reindex'
  | 'rag_query'
  | 'session_start'
  | 'session_close'
  | 'session_idle'
  | 'trust_change'
  | 'work_order_created'
  | 'work_order_resolved'
  | 'anchor_created'
  | 'config_change'
  | 'startup'
  | 'shutdown'
  | 'error';

// === LLM ===

export interface LLMDecision {
  response?: string;
  toolCalls: ToolCall[];
  memoryOps: MemoryOp[];
  reasoning?: string; // chain-of-thought (logged, not shown to user)
  usage?: LLMUsage;
}

export interface ToolCall {
  id: string; // tool-call ID from LLM
  tool: string; // MCP tool name
  params: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  tool: string;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  provider: string;
}

// === Vault ===

export interface VaultFile {
  path: string; // relative to vault root
  frontmatter: Record<string, unknown>;
  body: string; // markdown content without frontmatter
  links: string[]; // parsed [[wikilinks]]
  raw: string; // full file content including frontmatter
  stats: VaultFileStats;
}

export interface VaultFileStats {
  created: Date;
  modified: Date;
  size: number; // bytes
}

export interface VaultIndex {
  files: Map<string, string>; // filename (no ext) → relative path
  backlinks: Map<string, Set<string>>; // filename → set of filenames linking to it
  tags: Map<string, Set<string>>; // tag → set of file paths
  types: Map<string, Set<string>>; // entity type → set of file paths
}

// === RAG ===

export interface VaultChunk {
  id: VedId;
  filePath: string;
  heading: string | null;
  content: string;
  tokenCount: number;
  embedding?: Float32Array; // 768-dim, undefined before embedding
  updatedAt: number;
  fileModifiedAt: number;
}

export interface RetrievalResult {
  filePath: string;
  chunkId?: VedId;
  heading?: string | null;
  content: string;
  rrfScore: number;
  sources: RetrievalSource[];
}

export type RetrievalSource = 'vector' | 'fts' | 'graph';

// === Graph ===

export interface GraphNode {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  links: string[];
  backlinks: string[];
  depth: number;
}

export interface GraphWalkOptions {
  startFiles: string[];
  maxDepth: number; // default: 1
  maxNodes: number; // default: 5
  maxTokens: number;
  excludeFolders?: string[];
}

// === Risk Assessment ===

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

// === Configuration ===

export interface VedConfig {
  name: string; // 'Ved'
  version: string;
  dbPath: string; // SQLite file path
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'pretty';
  logFile: string | null;
  llm: LLMConfig;
  memory: MemoryConfig;
  trust: TrustConfig;
  audit: AuditConfig;
  rag: RagConfig;
  channels: ChannelConfig[];
  mcp: MCPConfig;
}

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama';
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  maxTokensPerMessage: number;
  maxTokensPerSession: number;
  temperature: number;
  systemPromptPath: string | null;
}

export interface MemoryConfig {
  vaultPath: string;
  workingMemoryMaxTokens: number; // T1 budget
  ragContextMaxTokens: number; // injected RAG context budget
  compressionThreshold: number; // T1 token count before compress
  sessionIdleMinutes: number; // idle before T1→T2 flush
  gitEnabled: boolean;
  gitAutoCommitIntervalMinutes: number;
}

export interface TrustConfig {
  ownerIds: string[];
  tribeIds: string[];
  knownIds: string[];
  defaultTier: TrustTier;
  approvalTimeoutMs: number;
  maxToolCallsPerMessage: number;
  maxAgenticLoops: number; // max DECIDE→ACT iterations
}

export interface AuditConfig {
  anchorInterval: number;
  hmacSecret: string | null;
}

export interface RagConfig {
  vectorTopK: number;
  ftsTopK: number;
  graphMaxDepth: number;
  graphMaxNodes: number;
  maxContextTokens: number;
  rrfK: number;
  embedding: EmbeddingConfig;
  chunking: ChunkConfig;
}

export interface EmbeddingConfig {
  model: string; // 'nomic-embed-text'
  baseUrl: string; // 'http://localhost:11434'
  batchSize: number; // 32
  dimensions: number; // 768
}

export interface ChunkConfig {
  maxTokens: number; // 1024
  minTokens: number; // 64
  frontmatterPrefix: boolean;
}

export interface ChannelConfig {
  type: ChannelId;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface MCPConfig {
  servers: MCPServerEntry[];
}

export interface MCPServerEntry {
  name: string;
  transport: 'stdio' | 'http';
  command?: string; // stdio transport
  args?: string[]; // stdio transport
  url?: string; // http transport
  enabled: boolean;
  trustOverride?: TrustTier | null;
}

// === Lifecycle ===

/** Standard module lifecycle — all modules implement this */
export interface VedModule {
  readonly name: string;
  init(config: VedConfig): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<ModuleHealth>;
}

export interface ModuleHealth {
  module: string;
  healthy: boolean;
  details?: string;
  checkedAt: number; // unix ms
}

// === Trust × Risk Matrix ===

/**
 * Trust decision matrix: trustMatrix[tier][riskLevel]
 *
 *              low      medium    high      critical
 * Tier 4(own)  auto     auto      auto      approve
 * Tier 3(tri)  auto     auto      approve   deny
 * Tier 2(kno)  auto     approve   deny      deny
 * Tier 1(str)  approve  deny      deny      deny
 */
export type TrustMatrix = Record<TrustTier, Record<RiskLevel, TrustDecision>>;

export const TRUST_RISK_MATRIX: TrustMatrix = {
  4: { low: 'auto', medium: 'auto', high: 'auto', critical: 'approve' },
  3: { low: 'auto', medium: 'auto', high: 'approve', critical: 'deny' },
  2: { low: 'auto', medium: 'approve', high: 'deny', critical: 'deny' },
  1: { low: 'approve', medium: 'deny', high: 'deny', critical: 'deny' },
};
