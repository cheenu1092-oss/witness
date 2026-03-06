/**
 * Channel module types — adapters, configs, message routing.
 */

import type { VedMessage, VedResponse, WorkOrder } from '../types/index.js';

// === Channel Adapter Interface ===

export interface ChannelAdapter {
  readonly id: string;
  readonly type: string;
  readonly connected: boolean;

  /** Initialize the channel */
  init(config: ChannelAdapterConfig): Promise<void>;

  /** Start listening for messages */
  start(): Promise<void>;

  /** Stop listening */
  stop(): Promise<void>;

  /** Send a response */
  send(response: VedResponse): Promise<void>;

  /** Subscribe to incoming messages */
  onMessage(handler: MessageHandler): void;

  /** Send an approval request notification */
  sendApprovalRequest(workOrder: WorkOrder): Promise<void>;

  /** Send a plaintext notification */
  notify(text: string): Promise<void>;

  /** Graceful shutdown */
  shutdown(): Promise<void>;
}

export type MessageHandler = (msg: VedMessage) => void;

// === Discord Config ===

export interface DiscordAdapterConfig {
  type: 'discord';
  token: string;
  guildId?: string;
  channelIds?: string[];
  prefix?: string; // command prefix (e.g. '!ved')
}

// === CLI Config ===

export interface CLIAdapterConfig {
  type: 'cli';
  prompt?: string; // default: 'ved> '
  historyFile?: string;
}

// === Push Config ===

export interface PushAdapterConfig {
  type: 'push';
  provider: 'ntfy' | 'pushover';
  topic?: string;
  userKey?: string;
  apiToken?: string;
  baseUrl?: string;
}

// === Cron Config ===

export interface CronAdapterConfig {
  type: 'cron';
  jobs: CronJobConfig[];
}

export interface CronJobConfig {
  name: string;
  schedule: string; // cron expression (5-field)
  message: string;
  enabled: boolean;
}

// === Union ===

export type ChannelAdapterConfig =
  | DiscordAdapterConfig
  | CLIAdapterConfig
  | PushAdapterConfig
  | CronAdapterConfig;

// === Cron Tick ===

export interface CronTick {
  jobName: string;
  message: string;
  firedAt: number; // unix ms
}
