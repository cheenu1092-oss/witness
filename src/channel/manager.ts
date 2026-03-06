/**
 * ChannelManager — orchestrates all channel adapters.
 *
 * Implements VedModule lifecycle. Routes messages from any channel
 * to the EventLoop, and sends responses back to the originating channel.
 */

import type {
  VedConfig, VedModule, ModuleHealth, VedResponse,
  ChannelId, WorkOrder,
} from '../types/index.js';
import type { ChannelAdapter, ChannelAdapterConfig, MessageHandler } from './types.js';
import { CLIAdapter } from './cli.js';
import { DiscordAdapter } from './discord.js';
import { PushAdapter } from './push.js';
import { CronAdapter } from './cron.js';
import { VedError } from '../types/errors.js';

export class ChannelManager implements VedModule {
  readonly name = 'channel';

  private adapters = new Map<string, ChannelAdapter>();
  private messageHandlers: MessageHandler[] = [];

  async init(config: VedConfig): Promise<void> {
    for (const channelConf of config.channels) {
      if (!channelConf.enabled) continue;

      const adapter = createAdapter(channelConf.type);
      adapter.onMessage((msg) => {
        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      });

      await adapter.init(channelConf.config as unknown as ChannelAdapterConfig);
      this.adapters.set(adapter.id, adapter);
    }
  }

  async shutdown(): Promise<void> {
    const shutdowns: Promise<void>[] = [];
    for (const adapter of this.adapters.values()) {
      shutdowns.push(adapter.shutdown());
    }
    await Promise.allSettled(shutdowns);
    this.adapters.clear();
    this.messageHandlers = [];
  }

  async healthCheck(): Promise<ModuleHealth> {
    const total = this.adapters.size;
    const connected = [...this.adapters.values()].filter(a => a.connected).length;

    return {
      module: 'channel',
      healthy: total === 0 || connected > 0,
      details: `${connected}/${total} channels connected`,
      checkedAt: Date.now(),
    };
  }

  /** Start all channel adapters */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.start();
      } catch (err) {
        // Non-fatal: log and continue. Other channels may still work.
        console.error(`[ved-channel] Failed to start ${adapter.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Stop all channel adapters */
  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch {
        // Best-effort stop
      }
    }
  }

  /** Subscribe to messages from all channels */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /** Send a response via the appropriate channel */
  async send(channelId: string, response: VedResponse): Promise<void> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) {
      throw new VedError('CHANNEL_SEND_FAILED',
        `Unknown channel: ${channelId}`);
    }
    await adapter.send(response);
  }

  /** Send approval request to appropriate channel */
  async notifyApproval(channelId: string, workOrder: WorkOrder): Promise<void> {
    const adapter = this.adapters.get(channelId);
    if (adapter) {
      await adapter.sendApprovalRequest(workOrder);
    }
  }

  /** Broadcast notification to all connected channels */
  async broadcastNotify(text: string): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.connected) {
        try {
          await adapter.notify(text);
        } catch {
          // Best-effort
        }
      }
    }
  }

  /** Get a specific channel adapter */
  getChannel(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Get all adapters */
  get channels(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}

function createAdapter(type: ChannelId): ChannelAdapter {
  switch (type) {
    case 'cli': return new CLIAdapter();
    case 'discord': return new DiscordAdapter();
    case 'push': return new PushAdapter();
    case 'cron': return new CronAdapter();
    default:
      throw new VedError('CONFIG_INVALID', `Unknown channel type: ${type}`);
  }
}
