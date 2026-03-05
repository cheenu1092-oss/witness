/**
 * VedError — Structured error class with grep-friendly codes.
 *
 * All Ved errors use string codes (not numeric). Codes are module-prefixed,
 * UPPER_SNAKE_CASE, and serializable.
 */

export type VedErrorCode =
  // Config
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_PARSE_ERROR'
  | 'CONFIG_INVALID'
  | 'CONFIG_PATH_NOT_FOUND'
  // Database
  | 'DB_OPEN_FAILED'
  | 'DB_MIGRATION_FAILED'
  | 'DB_MIGRATION_CHECKSUM'
  | 'DB_QUERY_FAILED'
  | 'DB_CONSTRAINT_VIOLATION'
  // LLM
  | 'LLM_API_KEY_MISSING'
  | 'LLM_REQUEST_FAILED'
  | 'LLM_TIMEOUT'
  | 'LLM_RATE_LIMITED'
  | 'LLM_CONTEXT_OVERFLOW'
  | 'LLM_INVALID_RESPONSE'
  | 'LLM_BUDGET_EXCEEDED'
  // MCP / Tools
  | 'MCP_SERVER_UNREACHABLE'
  | 'MCP_SERVER_TIMEOUT'
  | 'MCP_TOOL_NOT_FOUND'
  | 'MCP_TOOL_EXECUTION_ERROR'
  | 'MCP_TRANSPORT_ERROR'
  | 'MCP_SCHEMA_INVALID'
  // Memory
  | 'MEMORY_VAULT_NOT_FOUND'
  | 'MEMORY_VAULT_NOT_GIT'
  | 'MEMORY_FILE_READ_ERROR'
  | 'MEMORY_FILE_WRITE_ERROR'
  | 'MEMORY_COMPRESSION_FAILED'
  | 'MEMORY_GIT_ERROR'
  | 'MEMORY_TEMPLATE_NOT_FOUND'
  | 'MEMORY_FRONTMATTER_INVALID'
  // RAG
  | 'RAG_EMBED_FAILED'
  | 'RAG_EMBED_UNREACHABLE'
  | 'RAG_INDEX_FAILED'
  | 'RAG_SEARCH_FAILED'
  // Audit
  | 'AUDIT_HASH_MISMATCH'
  | 'AUDIT_ANCHOR_FAILED'
  | 'AUDIT_WRITE_FAILED'
  // Trust
  | 'TRUST_DENIED'
  | 'TRUST_APPROVAL_TIMEOUT'
  | 'TRUST_APPROVAL_REJECTED'
  | 'TRUST_LOOP_LIMIT'
  | 'TRUST_TOOL_LIMIT'
  // Channel
  | 'CHANNEL_SEND_FAILED'
  | 'CHANNEL_CONNECT_FAILED'
  | 'CHANNEL_AUTH_FAILED'
  // Session
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CLOSED'
  // General
  | 'INTERNAL_ERROR'
  | 'SHUTDOWN_ERROR';

/**
 * Structured error for all Ved operations.
 * Designed for logging (toJSON), pattern matching (code), and chaining (cause).
 */
export class VedError extends Error {
  public readonly code: VedErrorCode;
  public readonly context?: Record<string, unknown>;
  public override readonly cause?: Error;

  constructor(
    code: VedErrorCode,
    message: string,
    cause?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'VedError';
    this.code = code;
    this.cause = cause;
    this.context = context;
  }

  /** Structured representation for logging. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.context ? { context: this.context } : {}),
      ...(this.cause ? { cause: this.cause.message } : {}),
    };
  }
}
