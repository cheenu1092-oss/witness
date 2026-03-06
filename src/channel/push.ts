/**
 * Push Channel Adapter — notification-only channel (ntfy or pushover).
 *
 * Push channels are output-only: they send notifications to the user
 * but cannot receive messages. Used for alerts, approval requests,
 * and background task completions.
 */

import type { VedResponse, WorkOrder } from '../types/index.js';
import type { ChannelAdapter, PushAdapterConfig, MessageHandler } from './types.js';

export class PushAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = 'push';

  private config: PushAdapterConfig | null = null;
  private _connected = false;

  constructor(id?: string) {
    this.id = id ?? 'push';
  }

  get connected(): boolean {
    return this._connected;
  }

  async init(config: PushAdapterConfig): Promise<void> {
    if (config.provider === 'ntfy' && !config.topic) {
      throw new Error('ntfy push adapter requires a topic');
    }
    if (config.provider === 'pushover' && (!config.userKey || !config.apiToken)) {
      throw new Error('Pushover push adapter requires userKey and apiToken');
    }
    this.config = config;
  }

  async start(): Promise<void> {
    // Push is output-only — just mark as connected
    this._connected = true;
  }

  async stop(): Promise<void> {
    this._connected = false;
  }

  async send(response: VedResponse): Promise<void> {
    if (!response.content) return;
    await this.pushMessage('Ved', response.content);
  }

  onMessage(_handler: MessageHandler): void {
    // Push channels can't receive messages — no-op
  }

  async sendApprovalRequest(workOrder: WorkOrder): Promise<void> {
    const text = `⚠️ Approval needed: ${workOrder.tool} (${workOrder.riskLevel})\nID: ${workOrder.id}`;
    await this.pushMessage('Ved — Approval Required', text, 'high');
  }

  async notify(text: string): Promise<void> {
    await this.pushMessage('Ved', text);
  }

  async shutdown(): Promise<void> {
    this._connected = false;
    this.config = null;
  }

  // ── Private ──

  private async pushMessage(title: string, body: string, priority?: string): Promise<void> {
    if (!this.config) return;

    if (this.config.provider === 'ntfy') {
      await this.pushNtfy(title, body, priority);
    } else if (this.config.provider === 'pushover') {
      await this.pushPushover(title, body, priority);
    }
  }

  private async pushNtfy(title: string, body: string, priority?: string): Promise<void> {
    const baseUrl = this.config!.baseUrl ?? 'https://ntfy.sh';
    const url = `${baseUrl}/${this.config!.topic}`;

    const headers: Record<string, string> = {
      'Title': title,
    };
    if (priority) {
      headers['Priority'] = priority === 'high' ? '4' : '3';
    }

    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Push failure is non-fatal
    }
  }

  private async pushPushover(title: string, body: string, priority?: string): Promise<void> {
    const params = new URLSearchParams({
      token: this.config!.apiToken!,
      user: this.config!.userKey!,
      title,
      message: body,
    });

    if (priority === 'high') {
      params.set('priority', '1');
    }

    try {
      await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        body: params,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Push failure is non-fatal
    }
  }
}
