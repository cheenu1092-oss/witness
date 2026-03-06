/**
 * MCP transports — stdio (child process) and HTTP/SSE.
 *
 * Both implement MCPTransport: connect, disconnect, send (JSON-RPC 2.0).
 * Stdio spawns a child process; HTTP uses fetch + EventSource-style SSE.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { VedError } from '../types/errors.js';
import type {
  MCPTransport, MCPServerConfig, MCPJsonRpcResponse, PendingRequest,
} from './types.js';

const VED_VERSION = '0.1.0';

// ── Stdio Transport ──

export class StdioTransport implements MCPTransport {
  private process: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private _connected = false;
  private readonly config: MCPServerConfig;

  constructor(config: MCPServerConfig) {
    if (!config.command) {
      throw new VedError('CONFIG_INVALID', `Stdio transport requires 'command' for server "${config.name}"`);
    }
    // Reject shell metacharacters for security
    if (/[;&|`$]/.test(config.command)) {
      throw new VedError('CONFIG_INVALID', `Command contains shell metacharacters: "${config.command}"`);
    }
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    const { command, args, env, name } = this.config;

    this.process = spawn(command!, args ?? [], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // security: no shell injection
    });

    // stdout: JSON-RPC responses (line-delimited)
    this.process.stdout!.on('data', (chunk: Buffer) => this.handleData(chunk));

    // stderr: diagnostics (log, don't crash)
    this.process.stderr!.on('data', (_chunk: Buffer) => {
      // Future: pipe to logger
    });

    // Process exit → reject all pending, mark disconnected
    this.process.on('exit', (code, signal) => {
      this._connected = false;
      this.rejectAllPending(
        new VedError('MCP_TRANSPORT_ERROR',
          `Server "${name}" exited (code=${code}, signal=${signal})`)
      );
    });

    this.process.on('error', (err) => {
      this._connected = false;
      this.rejectAllPending(
        new VedError('MCP_TRANSPORT_ERROR',
          `Server "${name}" process error: ${err.message}`, err)
      );
    });

    // MCP initialize handshake
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ved', version: VED_VERSION },
    });

    // Send initialized notification (required by MCP spec)
    this.sendNotification('notifications/initialized', {});

    this._connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.process) return;

    // Close stdin gracefully
    this.process.stdin!.end();

    // Wait for exit, then force kill
    const exited = await Promise.race([
      new Promise<string>(r => {
        this.process!.on('exit', () => r('exit'));
      }),
      new Promise<string>(r => setTimeout(() => r('timeout'), 3000)),
    ]);

    if (exited === 'timeout' && this.process) {
      this.process.kill('SIGKILL');
    }

    this.process = null;
    this._connected = false;
    this.rejectAllPending(new VedError('MCP_TRANSPORT_ERROR', 'Transport disconnected'));
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.process?.stdin?.writable) {
      throw new VedError('MCP_TRANSPORT_ERROR', 'Not connected');
    }

    const id = this.nextId++;
    const request = { jsonrpc: '2.0' as const, id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VedError('MCP_SERVER_TIMEOUT',
          `No response from "${this.config.name}" after ${this.config.timeout}ms`));
      }, this.config.timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  /** Send a notification (no response expected) */
  private sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin?.writable) return;
    const notification = { jsonrpc: '2.0', method, params };
    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as MCPJsonRpcResponse;
        // Only handle responses (have id), skip notifications
        if ('id' in msg && msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);

          if (msg.error) {
            p.reject(new VedError('MCP_TOOL_EXECUTION_ERROR',
              msg.error.message ?? 'Unknown MCP error'));
          } else {
            p.resolve(msg.result);
          }
        }
        // Notifications (no id) — ignore for now
      } catch {
        // Unparseable line — skip
      }
    }
  }

  private rejectAllPending(err: VedError): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

// ── HTTP/SSE Transport ──

export class HttpTransport implements MCPTransport {
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private sessionUrl: string | null = null;
  private _connected = false;
  private abortController: AbortController | null = null;
  private readonly config: MCPServerConfig;

  constructor(config: MCPServerConfig) {
    if (!config.url) {
      throw new VedError('CONFIG_INVALID', `HTTP transport requires 'url' for server "${config.name}"`);
    }
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    const { url, timeout, name } = this.config;

    this.abortController = new AbortController();

    // Open SSE connection for server→client messages
    // Node 22+ has native fetch; for SSE we use a streaming approach
    const sseUrl = `${url}/sse`;

    const sseResponse = await fetch(sseUrl, {
      headers: { Accept: 'text/event-stream' },
      signal: this.abortController.signal,
    });

    if (!sseResponse.ok || !sseResponse.body) {
      throw new VedError('MCP_TRANSPORT_ERROR',
        `SSE connection to "${name}" failed: HTTP ${sseResponse.status}`);
    }

    // Parse SSE stream for endpoint and messages
    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';

    // Wait for 'endpoint' event with timeout
    const endpointPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(
        new VedError('MCP_SERVER_TIMEOUT', `SSE handshake timeout for "${name}"`)
      ), timeout);

      const readLoop = async (): Promise<void> => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            reject(new VedError('MCP_TRANSPORT_ERROR', 'SSE stream ended during handshake'));
            return;
          }
          sseBuf += decoder.decode(value, { stream: true });

          // Parse SSE events
          const events = sseBuf.split('\n\n');
          sseBuf = events.pop()!;

          for (const event of events) {
            const lines = event.split('\n');
            let eventType = 'message';
            let data = '';
            for (const l of lines) {
              if (l.startsWith('event: ')) eventType = l.slice(7).trim();
              if (l.startsWith('data: ')) data = l.slice(6).trim();
            }

            if (eventType === 'endpoint') {
              clearTimeout(timer);
              resolve(new URL(data, url!).toString());
              // Continue reading for messages in background
              this.startMessageReader(reader, decoder, sseBuf);
              return;
            }
          }

          // Keep reading
          await readLoop();
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      };

      readLoop();
    });

    this.sessionUrl = await endpointPromise;

    // MCP initialize handshake
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ved', version: VED_VERSION },
    });

    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.sessionUrl = null;
    this._connected = false;
    this.rejectAllPending(new VedError('MCP_TRANSPORT_ERROR', 'Transport disconnected'));
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.sessionUrl) {
      throw new VedError('MCP_TRANSPORT_ERROR', 'No session URL — not connected');
    }

    const id = this.nextId++;
    const request = { jsonrpc: '2.0' as const, id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VedError('MCP_SERVER_TIMEOUT',
          `No response from "${this.config.name}" after ${this.config.timeout}ms`));
      }, this.config.timeout);

      this.pending.set(id, { resolve, reject, timer });

      fetch(this.sessionUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeout),
      }).catch(err => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new VedError('MCP_TRANSPORT_ERROR', String(err)));
      });
      // Response comes via SSE, not HTTP response body
    });
  }

  /** Background SSE message reader — dispatches responses to pending map */
  private startMessageReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    initialBuf: string
  ): void {
    let buf = initialBuf;
    const readLoop = async (): Promise<void> => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this._connected = false;
          return;
        }
        buf += decoder.decode(value, { stream: true });

        const events = buf.split('\n\n');
        buf = events.pop()!;

        for (const event of events) {
          const lines = event.split('\n');
          let data = '';
          for (const l of lines) {
            if (l.startsWith('data: ')) data = l.slice(6).trim();
          }
          if (!data) continue;

          try {
            const msg = JSON.parse(data) as MCPJsonRpcResponse;
            if ('id' in msg && msg.id != null && this.pending.has(msg.id)) {
              const p = this.pending.get(msg.id)!;
              clearTimeout(p.timer);
              this.pending.delete(msg.id);
              if (msg.error) {
                p.reject(new VedError('MCP_TOOL_EXECUTION_ERROR',
                  msg.error.message ?? 'Unknown MCP error'));
              } else {
                p.resolve(msg.result);
              }
            }
          } catch {
            // Unparseable — skip
          }
        }

        await readLoop();
      } catch {
        this._connected = false;
      }
    };
    readLoop();
  }

  private rejectAllPending(err: VedError): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

// ── Factory ──

export function createTransport(config: MCPServerConfig): MCPTransport {
  switch (config.transport) {
    case 'stdio':
      return new StdioTransport(config);
    case 'http':
      return new HttpTransport(config);
    default:
      throw new VedError('CONFIG_INVALID',
        `Unknown MCP transport: ${config.transport}`);
  }
}
