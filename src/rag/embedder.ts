/**
 * Embedder — Ollama-based embedding client.
 *
 * Uses POST /api/embed with batch support.
 * Default model: nomic-embed-text (768-dim, 8192 token context).
 */

import type { EmbeddingConfig } from '../types/index.js';
import { VedError } from '../types/errors.js';
import type { Embedder } from './types.js';

export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly batchSize: number;

  constructor(config: EmbeddingConfig) {
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.batchSize = config.batchSize;
  }

  /**
   * Embed multiple texts. Batches automatically if input exceeds batchSize.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const results: Float32Array[] = [];

    // Batch requests
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const embeddings = await this.callEmbed(batch);
      results.push(...embeddings);
    }

    return results;
  }

  /**
   * Embed a single text.
   */
  async embedOne(text: string): Promise<Float32Array> {
    const [result] = await this.embed([text]);
    return result;
  }

  /**
   * Check if the embedding model is available in Ollama.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;

      const data = await response.json() as { models?: Array<{ name?: string }> };
      const models = data.models ?? [];
      return models.some((m: { name?: string }) =>
        m.name === this.model || m.name?.startsWith(`${this.model}:`)
      );
    } catch {
      return false;
    }
  }

  // ── Private ──

  private async callEmbed(texts: string[]): Promise<Float32Array[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(60_000), // embedding can be slow
      });
    } catch (err) {
      throw new VedError('RAG_EMBED_FAILED',
        `Ollama embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new VedError('RAG_EMBED_FAILED',
        `Ollama returned HTTP ${response.status}: ${body}`);
    }

    const data = await response.json() as { embeddings?: number[][] };

    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new VedError('RAG_EMBED_FAILED', 'Ollama response missing embeddings array');
    }

    return data.embeddings.map((e: number[]) => {
      const arr = new Float32Array(e);
      if (arr.length !== this.dimensions) {
        throw new VedError('RAG_EMBED_FAILED',
          `Expected ${this.dimensions} dimensions, got ${arr.length}`);
      }
      return arr;
    });
  }
}
