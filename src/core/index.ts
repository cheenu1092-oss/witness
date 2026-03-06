/**
 * ved-core — Event loop, session management, message queue, config, logging.
 *
 * The hub module. Orchestrates all other modules.
 */

// Config
export { loadConfig, getDefaults, getConfigDir, expandPath, deepMerge, validateConfig } from './config.js';
export type { ValidationError } from './config.js';

// Logging
export { initLogger, shutdownLogger, log, createLogger } from './log.js';
export type { LogLevel, LogFormat, LogEntry, Logger } from './log.js';

// Working Memory (T1)
export { WorkingMemory } from './working-memory.js';
export type { ConversationMessage } from './working-memory.js';

// Session Manager
export { SessionManager } from './session.js';
export type { Session, SessionManagerOptions } from './session.js';

// Message Queue
export { MessageQueue } from './queue.js';
export type { MessagePriority } from './queue.js';

// Event Loop
export { EventLoop } from './event-loop.js';
export type { EventLoopOptions } from './event-loop.js';

// Compressor (T1→T2)
export { Compressor } from './compressor.js';
export type { CompressionResult, CompressorOptions } from './compressor.js';

// Approval Command Parser
export { parseApprovalCommand, executeApprovalCommand, formatPendingWorkOrder } from './approval-parser.js';
export type { ParsedCommand, CommandResult, ApprovalAction, ApprovalParserDeps } from './approval-parser.js';

// Session Idle Timer
export { SessionIdleTimer } from './idle-timer.js';
export type { IdleTimerConfig, IdleTimerDeps, IdleCheckResult, IdleTimerStats } from './idle-timer.js';
