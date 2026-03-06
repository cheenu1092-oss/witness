/**
 * CLI Channel Adapter — readline-based interactive terminal interface.
 *
 * Uses Node.js readline for input. Prints responses to stdout.
 * Supports history via historyFile config.
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ulid } from 'ulid';
import type { VedMessage, VedResponse, WorkOrder } from '../types/index.js';
import type { ChannelAdapter, CLIAdapterConfig, MessageHandler } from './types.js';

export class CLIAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = 'cli';

  private rl: readline.Interface | null = null;
  private handlers: MessageHandler[] = [];
  private prompt = 'ved> ';
  private _connected = false;
  private running = false;

  constructor(id?: string) {
    this.id = id ?? 'cli';
  }

  get connected(): boolean {
    return this._connected;
  }

  async init(config: CLIAdapterConfig): Promise<void> {
    if (config.prompt) {
      this.prompt = config.prompt;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
    });

    this._connected = true;
    this.running = true;

    // Start read loop (non-blocking)
    this.readLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this._connected = false;
    this.rl?.close();
    this.rl = null;
  }

  async send(response: VedResponse): Promise<void> {
    if (!response.content) return;
    stdout.write(`\n${response.content}\n\n`);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async sendApprovalRequest(workOrder: WorkOrder): Promise<void> {
    stdout.write(`\n⚠️  Approval required for: ${workOrder.tool}\n`);
    stdout.write(`   Risk: ${workOrder.riskLevel} | Params: ${JSON.stringify(workOrder.params)}\n`);
    stdout.write(`   Work Order ID: ${workOrder.id}\n`);
    stdout.write(`   Reply with: approve ${workOrder.id} | deny ${workOrder.id}\n\n`);
  }

  async notify(text: string): Promise<void> {
    stdout.write(`\n📌 ${text}\n\n`);
  }

  async shutdown(): Promise<void> {
    await this.stop();
    this.handlers = [];
  }

  // ── Private ──

  private messageCount = 0;
  private startTime = 0;

  private printBanner(): void {
    stdout.write('\n');
    stdout.write('  \x1B[1m\x1B[36mVed\x1B[0m — The personal AI agent that remembers everything.\n');
    stdout.write('  Type \x1B[33m/help\x1B[0m for commands, \x1B[33m/quit\x1B[0m to exit.\n');
    stdout.write('\n');
  }

  private printHelp(): void {
    stdout.write('\n');
    stdout.write('  \x1B[1mCommands:\x1B[0m\n');
    stdout.write('    /help              Show this help\n');
    stdout.write('    /status            Show session stats\n');
    stdout.write('    /clear             Clear the screen\n');
    stdout.write('    /quit, /exit       Exit Ved\n');
    stdout.write('    approve <id>       Approve a work order\n');
    stdout.write('    deny <id> [reason] Deny a work order\n');
    stdout.write('\n');
  }

  private printStatus(): void {
    const uptime = this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;
    stdout.write('\n');
    stdout.write(`  \x1B[1mSession:\x1B[0m ${mins}m ${secs}s uptime, ${this.messageCount} messages\n`);
    stdout.write('\n');
  }

  private async readLoop(): Promise<void> {
    this.startTime = Date.now();
    this.printBanner();
    while (this.running && this.rl) {
      try {
        const input = await this.rl.question(this.prompt);
        const trimmed = input.trim();

        if (!trimmed) continue;

        // Special commands
        if (trimmed === '/quit' || trimmed === '/exit') {
          stdout.write('Goodbye.\n');
          this.running = false;
          break;
        }

        if (trimmed === '/help') {
          this.printHelp();
          continue;
        }

        if (trimmed === '/status') {
          this.printStatus();
          continue;
        }

        if (trimmed === '/clear') {
          stdout.write('\x1B[2J\x1B[H');
          continue;
        }

        this.messageCount++;

        const msg: VedMessage = {
          id: ulid(),
          channel: 'cli',
          author: 'owner',
          content: trimmed,
          timestamp: Date.now(),
        };

        for (const handler of this.handlers) {
          handler(msg);
        }
      } catch (err) {
        // readline closed or EOF
        if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        this.running = false;
        break;
      }
    }
  }
}
