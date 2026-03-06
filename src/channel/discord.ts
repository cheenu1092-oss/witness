/**
 * Discord Channel Adapter — discord.js-based bot integration.
 *
 * Features:
 * - Message listening with prefix/mention activation
 * - Reply support (replies to the original message)
 * - Typing indicators while processing
 * - Rich embed formatting for approval requests
 * - Attachment handling (maps Discord attachments to VedMessage format)
 * - Guild and channel filtering
 * - Approval command handling (approve/deny work orders)
 *
 * NOTE: discord.js is an OPTIONAL dependency — Ved does not require Discord.
 * If discord.js is not installed, this adapter will fail on init() with a
 * clear error. To use: `npm install discord.js`
 */

import { ulid } from 'ulid';
import type { VedMessage, VedResponse, WorkOrder } from '../types/index.js';
import type {
  ChannelAdapter, DiscordAdapterConfig, MessageHandler,
} from './types.js';

// === Message length limits ===
const DISCORD_MAX_LENGTH = 2000;

/**
 * Discord adapter.
 */
export class DiscordAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = 'discord';

  private client: DiscordClient | null = null;
  private handlers: MessageHandler[] = [];
  private config: DiscordAdapterConfig | null = null;
  private _connected = false;

  // Track messages for reply support
  private messageMap = new Map<string, string>(); // vedMessageId → discordMessageId
  private messageMapMaxSize = 1000;

  // Track typing state per channel
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(id?: string) {
    this.id = id ?? 'discord';
  }

  get connected(): boolean {
    return this._connected;
  }

  async init(config: DiscordAdapterConfig): Promise<void> {
    if (!config.token) {
      throw new Error('Discord adapter requires a bot token');
    }
    this.config = config;

    // Dynamic import — discord.js is optional
    let discordjs: DiscordModule;
    try {
      // @ts-expect-error — discord.js is an optional peer dependency
      discordjs = await import('discord.js') as unknown as DiscordModule;
    } catch {
      throw new Error(
        'discord.js is not installed. Run: npm install discord.js'
      );
    }

    const intents = discordjs.GatewayIntentBits;
    this.client = new discordjs.Client({
      intents: [
        intents.Guilds,
        intents.GuildMessages,
        intents.MessageContent,
        intents.DirectMessages,
      ],
    }) as DiscordClient;
  }

  async start(): Promise<void> {
    if (!this.client || !this.config) {
      throw new Error('Discord adapter not initialized — call init() first');
    }

    // Message handler
    this.client.on('messageCreate', (raw: unknown) => {
      const dm = raw as DiscordMessage;
      // Ignore bot messages
      if (dm.author.bot) return;

      // Filter by guild
      if (this.config!.guildId && dm.guild?.id !== this.config!.guildId) {
        return;
      }

      // Filter by channels
      if (this.config!.channelIds?.length) {
        if (!this.config!.channelIds.includes(dm.channel.id)) return;
      }

      // Check prefix (if set)
      let content = dm.content;
      if (this.config!.prefix) {
        if (!content.startsWith(this.config!.prefix)) return;
        content = content.slice(this.config!.prefix.length).trim();
      }

      // Map attachments
      const attachments = dm.attachments
        ? [...dm.attachments.values()].map((a: DiscordAttachment) => ({
          filename: a.name ?? 'unknown',
          contentType: a.contentType ?? 'application/octet-stream',
          url: a.url,
          size: a.size,
        }))
        : [];

      const vedMsgId = ulid();

      // Track Discord message ID for reply support
      this.trackMessage(vedMsgId, dm.id);

      const vedMsg: VedMessage = {
        id: vedMsgId,
        channel: 'discord',
        author: dm.author.id,
        content,
        attachments: attachments.length > 0 ? attachments : undefined,
        replyTo: dm.reference?.messageId ?? undefined,
        timestamp: dm.createdTimestamp,
      };

      // Start typing indicator in the channel
      this.startTyping(dm.channel);

      for (const handler of this.handlers) {
        handler(vedMsg);
      }
    });

    this.client.on('ready', () => {
      this._connected = true;
    });

    this.client.on('error', () => {
      this._connected = false;
    });

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    if (this.client) {
      this.client.destroy();
      this._connected = false;
    }
  }

  async send(response: VedResponse): Promise<void> {
    if (!this.client || !response.content) return;

    // Stop typing in the channel
    if (response.channelRef) {
      this.stopTyping(response.channelRef);
    }

    // Route via channelRef (Discord channel ID)
    if (response.channelRef) {
      try {
        const channel = await this.client.channels.fetch(response.channelRef);
        if (channel && 'send' in Object(channel)) {
          const sendable = channel as SendableChannel;

          // Split long messages
          const chunks = splitMessage(response.content);

          // First chunk: reply to original message if available
          const discordReplyId = response.inReplyTo
            ? this.messageMap.get(response.inReplyTo)
            : undefined;

          for (let i = 0; i < chunks.length; i++) {
            const options: SendOptions = { content: chunks[i] };

            // Reply to original message on first chunk
            if (i === 0 && discordReplyId) {
              options.reply = {
                messageReference: discordReplyId,
                failIfNotExists: false,
              };
            }

            await sendable.send(options);
          }
        }
      } catch {
        // Channel not found or no permissions — stop typing as cleanup
        if (response.channelRef) {
          this.stopTyping(response.channelRef);
        }
      }
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async sendApprovalRequest(workOrder: WorkOrder): Promise<void> {
    if (!this.config?.channelIds?.length || !this.client) return;

    // Build a rich embed for approval requests
    const embed = buildApprovalEmbed(workOrder);

    for (const chId of this.config.channelIds) {
      try {
        const channel = await this.client.channels.fetch(chId);
        if (channel && 'send' in Object(channel)) {
          await (channel as SendableChannel).send({ embeds: [embed] });
        }
      } catch {
        // Fall back to plain text
        try {
          const channel = await this.client.channels.fetch(chId);
          if (channel && 'send' in Object(channel)) {
            const text = formatApprovalPlaintext(workOrder);
            await (channel as SendableChannel).send({ content: text });
          }
        } catch {
          // Channel not accessible
        }
      }
    }
  }

  async notify(text: string): Promise<void> {
    if (!this.config?.channelIds?.length || !this.client) return;

    for (const chId of this.config.channelIds) {
      try {
        const channel = await this.client.channels.fetch(chId);
        if (channel && 'send' in Object(channel)) {
          await (channel as SendableChannel).send({ content: `📌 ${text}` });
        }
      } catch {
        // Continue
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
    this.handlers = [];
    this.messageMap.clear();
    this.client = null;
  }

  // ── Typing Indicator ──

  /**
   * Start showing typing indicator in a channel.
   * Discord typing indicators last ~10s, so we re-send every 8s.
   */
  private startTyping(channel: DiscordChannel): void {
    const channelId = channel.id;

    // Don't double-type
    if (this.typingIntervals.has(channelId)) return;

    // Send initial typing
    if ('sendTyping' in Object(channel)) {
      (channel as unknown as TypableChannel).sendTyping().catch(() => {});
    }

    // Re-send every 8s to keep the indicator active
    const interval = setInterval(() => {
      if (this.client && 'sendTyping' in Object(channel)) {
        (channel as unknown as TypableChannel).sendTyping().catch(() => {
          // Channel gone, stop typing
          this.stopTyping(channelId);
        });
      }
    }, 8000);

    this.typingIntervals.set(channelId, interval);
  }

  /**
   * Stop typing indicator for a channel.
   */
  private stopTyping(channelId: string): void {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
    }
  }

  // ── Message Tracking ──

  /**
   * Track a Ved message ID → Discord message ID mapping for reply support.
   * Uses a bounded map to prevent memory leaks.
   */
  private trackMessage(vedId: string, discordId: string): void {
    if (this.messageMap.size >= this.messageMapMaxSize) {
      // Evict oldest entries (FIFO via iteration order)
      const toDelete = this.messageMap.size - this.messageMapMaxSize + 100;
      let deleted = 0;
      for (const key of this.messageMap.keys()) {
        if (deleted >= toDelete) break;
        this.messageMap.delete(key);
        deleted++;
      }
    }
    this.messageMap.set(vedId, discordId);
  }
}

// ── Message Splitting ──

/**
 * Split a message into chunks that fit Discord's 2000-char limit.
 * Code-block-aware: properly closes/reopens ``` blocks at split boundaries.
 * Tries to split at newlines, then sentences, then hard-cuts.
 */
function splitMessage(content: string): string[] {
  if (content.length <= DISCORD_MAX_LENGTH) return [content];

  const chunks: string[] = [];
  let remaining = content;
  let openCodeBlock: string | null = null; // tracks the opening ``` line (e.g. "```json")

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      // If we had an open code block from previous split, prepend opener
      if (openCodeBlock !== null) {
        remaining = openCodeBlock + '\n' + remaining;
        // Check if prepending pushed us over the limit
        if (remaining.length > DISCORD_MAX_LENGTH) {
          openCodeBlock = null; // will be recalculated below
          continue;
        }
      }
      chunks.push(remaining);
      break;
    }

    // If we had an open code block from previous chunk, prepend the opener
    if (openCodeBlock !== null) {
      remaining = openCodeBlock + '\n' + remaining;
      openCodeBlock = null;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitIdx < DISCORD_MAX_LENGTH * 0.5) {
      // Newline too early — try sentence boundary
      splitIdx = remaining.lastIndexOf('. ', DISCORD_MAX_LENGTH);
      if (splitIdx < DISCORD_MAX_LENGTH * 0.5) {
        // Hard split at limit
        splitIdx = DISCORD_MAX_LENGTH;
      } else {
        splitIdx += 1; // include the period
      }
    }

    let chunk = remaining.slice(0, splitIdx);
    remaining = remaining.slice(splitIdx).trimStart();

    // GAP-3: Track code block state across the chunk
    // Count triple-backtick fences to determine if we're leaving a block open
    const fences = chunk.match(/```[^\n]*/g) ?? [];
    let insideBlock = openCodeBlock !== null;
    let lastOpener: string | null = openCodeBlock;

    for (const fence of fences) {
      if (insideBlock) {
        // This fence closes the block
        insideBlock = false;
        lastOpener = null;
      } else {
        // This fence opens a block (capture the full line like "```json")
        insideBlock = true;
        lastOpener = fence;
      }
    }

    if (insideBlock) {
      // Code block is left open — close it at end of this chunk
      chunk += '\n```';
      // Remember the opener so we can prepend it to the next chunk
      openCodeBlock = lastOpener;
    } else {
      openCodeBlock = null;
    }

    chunks.push(chunk);
  }

  return chunks;
}

// ── Embed Builder ──

function buildApprovalEmbed(workOrder: WorkOrder): DiscordEmbed {
  const riskColor = riskToColor(workOrder.riskLevel);
  const paramsText = JSON.stringify(workOrder.params, null, 2);
  const truncatedParams = paramsText.length > 1000
    ? paramsText.slice(0, 997) + '...'
    : paramsText;

  return {
    title: '⚠️ Approval Required',
    color: riskColor,
    fields: [
      { name: 'Tool', value: `\`${workOrder.tool}\``, inline: true },
      { name: 'Risk', value: riskEmoji(workOrder.riskLevel) + ' ' + workOrder.riskLevel, inline: true },
      { name: 'Trust Tier', value: String(workOrder.trustTier), inline: true },
      { name: 'Parameters', value: `\`\`\`json\n${truncatedParams}\n\`\`\`` },
      { name: 'Work Order ID', value: `\`${workOrder.id}\`` },
      { name: 'Action', value: `Reply with:\n\`approve ${workOrder.id}\` or \`deny ${workOrder.id}\`` },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Ved Trust Engine' },
  };
}

function formatApprovalPlaintext(workOrder: WorkOrder): string {
  return [
    `⚠️ **Approval Required**`,
    `**Tool:** \`${workOrder.tool}\``,
    `**Risk:** ${riskEmoji(workOrder.riskLevel)} ${workOrder.riskLevel}`,
    `**Params:** \`\`\`json\n${JSON.stringify(workOrder.params, null, 2)}\n\`\`\``,
    `**ID:** \`${workOrder.id}\``,
    `Reply: \`approve ${workOrder.id}\` or \`deny ${workOrder.id}\``,
  ].join('\n');
}

function riskToColor(risk: string): number {
  switch (risk) {
    case 'low': return 0x2ecc71;      // green
    case 'medium': return 0xf39c12;   // orange
    case 'high': return 0xe74c3c;     // red
    case 'critical': return 0x8e44ad; // purple
    default: return 0x95a5a6;         // grey
  }
}

function riskEmoji(risk: string): string {
  switch (risk) {
    case 'low': return '🟢';
    case 'medium': return '🟡';
    case 'high': return '🔴';
    case 'critical': return '🟣';
    default: return '⚪';
  }
}

// Export helpers for testing
export { splitMessage, buildApprovalEmbed, riskToColor, riskEmoji };

// ── Minimal discord.js type stubs (avoid importing full types) ──

interface DiscordModule {
  Client: new (options: unknown) => DiscordClient;
  GatewayIntentBits: Record<string, number>;
}

interface DiscordClient {
  on(event: string, handler: (...args: unknown[]) => void): void;
  login(token: string): Promise<string>;
  destroy(): void;
  channels: { fetch(id: string): Promise<unknown> };
}

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; bot: boolean };
  guild?: { id: string };
  channel: DiscordChannel;
  attachments?: Map<string, DiscordAttachment>;
  reference?: { messageId?: string };
  createdTimestamp: number;
}

interface DiscordChannel {
  id: string;
}

interface DiscordAttachment {
  name?: string;
  contentType?: string;
  url: string;
  size: number;
}

interface SendOptions {
  content?: string;
  embeds?: DiscordEmbed[];
  reply?: {
    messageReference: string;
    failIfNotExists: boolean;
  };
}

interface SendableChannel {
  send(options: string | SendOptions): Promise<unknown>;
}

interface TypableChannel {
  sendTyping(): Promise<void>;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  thumbnail?: { url: string };
  author?: { name: string; icon_url?: string; url?: string };
}
