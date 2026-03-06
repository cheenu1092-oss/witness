/**
 * RagPipeline — Top-level RAG module implementing VedModule lifecycle.
 *
 * Orchestrates: chunk → embed → index → retrieve (vector + FTS + graph) → fuse → trim.
 * All data stored in the shared Ved SQLite database.
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type {
  VedConfig, VedModule, ModuleHealth, VaultFile, RagConfig,
} from '../types/index.js';
import { VedError } from '../types/errors.js';
import { OllamaEmbedder } from './embedder.js';
import { chunkFile } from './chunker.js';
import { vectorSearch, ftsSearch, graphSearch } from './search.js';
import { reciprocalRankFusion, trimToTokenBudget, formatContext } from './fusion.js';
import type {
  Embedder, IndexStats, RetrieveOptions, RetrievalContext,
} from './types.js';

export class RagPipeline implements VedModule {
  readonly name = 'rag';

  private db: Database.Database | null = null;
  private embedder: Embedder | null = null;
  private config: RagConfig | null = null;
  private reindexQueue: Set<string> = new Set();
  private vecAvailable = false;

  async init(config: VedConfig): Promise<void> {
    this.config = config.rag;
    this.embedder = new OllamaEmbedder(config.rag.embedding);

    // Check if embedder is available
    const available = await this.embedder.isAvailable();
    if (!available) {
      // RAG still initializes — operates in FTS-only mode
      console.warn('[ved-rag] Embedding model not available — vector search disabled');
    }
  }

  /** Must be called after init, passing the opened database handle */
  setDatabase(db: Database.Database): void {
    this.db = db;

    // Check if vec_chunks virtual table exists (sqlite-vec loaded)
    try {
      db.prepare('SELECT COUNT(*) FROM vec_chunks').get();
      this.vecAvailable = true;
    } catch {
      this.vecAvailable = false;
    }
  }

  async shutdown(): Promise<void> {
    this.db = null;
    this.embedder = null;
    this.config = null;
    this.reindexQueue.clear();
    this.vecAvailable = false;
  }

  async healthCheck(): Promise<ModuleHealth> {
    const hasDb = this.db !== null;
    const hasEmbedder = this.embedder !== null;
    const embeddable = hasEmbedder && await this.embedder!.isAvailable();

    return {
      module: 'rag',
      healthy: hasDb,
      details: `db=${hasDb}, embedder=${embeddable ? 'ready' : 'unavailable'}, vec=${this.vecAvailable}, queue=${this.reindexQueue.size}`,
      checkedAt: Date.now(),
    };
  }

  /**
   * Retrieve relevant context for a query.
   * Runs vector + FTS + graph retrieval paths, fuses with RRF, trims to budget.
   */
  async retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalContext> {
    this.assertReady();

    const cfg = this.config!;
    const vectorTopK = options?.vectorTopK ?? cfg.vectorTopK;
    const ftsTopK = options?.ftsTopK ?? cfg.ftsTopK;
    const graphMaxDepth = options?.graphMaxDepth ?? cfg.graphMaxDepth;
    const graphMaxNodes = options?.graphMaxNodes ?? cfg.graphMaxNodes;
    const maxContextTokens = options?.maxContextTokens ?? cfg.maxContextTokens;
    const excludePaths = options?.excludePaths;
    const activeSources = options?.sources ?? ['vector', 'fts', 'graph'];

    const totalStart = Date.now();

    // 1. Vector search
    let vectorResults: Awaited<ReturnType<typeof vectorSearch>> = [];
    let vectorMs = 0;
    if (activeSources.includes('vector') && this.vecAvailable && this.embedder) {
      const start = Date.now();
      try {
        vectorResults = await vectorSearch(
          this.db!, this.embedder, query, vectorTopK, excludePaths
        );
      } catch {
        // Vector search failed — continue with FTS + graph
      }
      vectorMs = Date.now() - start;
    }

    // 2. FTS search
    let ftsResults: ReturnType<typeof ftsSearch> = [];
    let ftsMs = 0;
    if (activeSources.includes('fts')) {
      const start = Date.now();
      ftsResults = ftsSearch(this.db!, query, ftsTopK, excludePaths);
      ftsMs = Date.now() - start;
    }

    // 3. Graph walk (seeded from vector + FTS results)
    let graphResults: ReturnType<typeof graphSearch> = [];
    let graphMs = 0;
    if (activeSources.includes('graph')) {
      const start = Date.now();
      const seedFiles = [
        ...new Set([
          ...vectorResults.map(r => r.filePath),
          ...ftsResults.map(r => r.filePath),
        ]),
      ];
      if (seedFiles.length > 0) {
        graphResults = graphSearch(
          this.db!, seedFiles, graphMaxDepth, graphMaxNodes, excludePaths
        );
      }
      graphMs = Date.now() - start;
    }

    // 4. Fuse with RRF
    const fusionStart = Date.now();
    const merged = reciprocalRankFusion(
      vectorResults, ftsResults, graphResults, cfg.rrfK
    );
    const fusionMs = Date.now() - fusionStart;

    // 5. Trim to token budget
    const { results: trimmed, tokenCount } = trimToTokenBudget(merged, maxContextTokens);

    // 6. Format context string
    const text = formatContext(trimmed);

    return {
      text,
      results: trimmed,
      tokenCount,
      metrics: {
        vectorSearchMs: vectorMs,
        ftsSearchMs: ftsMs,
        graphWalkMs: graphMs,
        fusionMs,
        totalMs: Date.now() - totalStart,
        vectorResultCount: vectorResults.length,
        ftsResultCount: ftsResults.length,
        graphResultCount: graphResults.length,
        mergedResultCount: trimmed.length,
      },
    };
  }

  /**
   * Index a single vault file: chunk → embed → store.
   * Replaces any existing chunks for this file path.
   */
  async indexFile(file: VaultFile): Promise<void> {
    this.assertReady();

    const chunks = chunkFile(file, this.config!.chunking);
    if (chunks.length === 0) return;

    const now = Date.now();
    const fileMtime = file.stats.modified.getTime();

    // Delete existing chunks for this file
    this.deleteFileChunks(file.path);

    // Insert new chunks
    const insertChunk = this.db!.prepare(`
      INSERT INTO chunks (rowid, id, file_path, heading, heading_level, content, frontmatter, token_count, chunk_index, file_modified_at, indexed_at)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertedChunks: Array<{ id: string; rowid: number; content: string }> = [];

    const insertAll = this.db!.transaction(() => {
      for (const chunk of chunks) {
        const id = ulid();
        const info = insertChunk.run(
          id,
          file.path,
          chunk.heading ?? '',
          chunk.headingLevel,
          chunk.content,
          JSON.stringify(file.frontmatter),
          chunk.tokenCount,
          chunk.chunkIndex,
          fileMtime,
          now,
        );
        insertedChunks.push({ id, rowid: Number(info.lastInsertRowid), content: chunk.content });
      }
    });

    insertAll();

    // Embed and store vectors (if available)
    if (this.vecAvailable && this.embedder) {
      try {
        const texts = insertedChunks.map(c => c.content);
        const embeddings = await this.embedder.embed(texts);

        const insertVec = this.db!.prepare(
          'INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)'
        );

        const insertVecs = this.db!.transaction(() => {
          for (let i = 0; i < insertedChunks.length; i++) {
            insertVec.run(
              insertedChunks[i].rowid,
              new Uint8Array(embeddings[i].buffer),
            );
          }
        });

        insertVecs();
      } catch {
        // Embedding failed — chunks are still FTS-searchable
        console.warn(`[ved-rag] Embedding failed for ${file.path} — FTS-only`);
      }
    }

    // Update graph edges
    this.updateGraphEdges(file);
  }

  /**
   * Full re-index of all vault files.
   */
  async fullReindex(files: VaultFile[]): Promise<IndexStats> {
    this.assertReady();

    // Clear all existing data
    this.db!.exec('DELETE FROM chunks');
    this.db!.exec('DELETE FROM graph_edges');
    if (this.vecAvailable) {
      try {
        this.db!.exec('DELETE FROM vec_chunks');
      } catch {
        // vec_chunks might not exist
      }
    }

    // Rebuild FTS
    this.db!.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");

    // Index each file
    for (const file of files) {
      await this.indexFile(file);
    }

    return this.stats();
  }

  /**
   * Remove a file from the index.
   */
  removeFile(filePath: string): void {
    this.assertReady();
    this.deleteFileChunks(filePath);
    this.db!.prepare('DELETE FROM graph_edges WHERE source_file = ? OR target_file = ?')
      .run(filePath, filePath);
  }

  /**
   * Enqueue a file for async re-indexing.
   */
  enqueueReindex(filePath: string): void {
    this.reindexQueue.add(filePath);
  }

  /**
   * Process pending re-index queue.
   * Caller must provide a function to read vault files.
   */
  async drainQueue(readFile: (path: string) => Promise<VaultFile | null>): Promise<number> {
    const paths = [...this.reindexQueue];
    this.reindexQueue.clear();

    let processed = 0;
    for (const path of paths) {
      const file = await readFile(path);
      if (file) {
        await this.indexFile(file);
        processed++;
      } else {
        // File deleted — remove from index
        this.removeFile(path);
        processed++;
      }
    }

    return processed;
  }

  /**
   * Get index stats.
   */
  stats(): IndexStats {
    this.assertReady();

    const chunksCount = (this.db!.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt;
    const filesCount = (this.db!.prepare('SELECT COUNT(DISTINCT file_path) as cnt FROM chunks').get() as { cnt: number }).cnt;
    const edgesCount = (this.db!.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number }).cnt;

    // FTS entry count
    let ftsCount = 0;
    try {
      const ftsRow = this.db!.prepare("SELECT COUNT(*) as cnt FROM chunks_fts").get() as { cnt: number } | undefined;
      ftsCount = ftsRow?.cnt ?? 0;
    } catch {
      // FTS5 count can fail on empty tables
    }

    return {
      filesIndexed: filesCount,
      chunksStored: chunksCount,
      ftsEntries: ftsCount,
      graphEdges: edgesCount,
      queueDepth: this.reindexQueue.size,
    };
  }

  // ── Private ──

  private assertReady(): void {
    if (!this.db) {
      throw new VedError('INTERNAL_ERROR', 'RagPipeline not ready — call init() and setDatabase()');
    }
    if (!this.config) {
      throw new VedError('INTERNAL_ERROR', 'RagPipeline not initialized — call init() first');
    }
  }

  private deleteFileChunks(filePath: string): void {
    // Get rowids before deleting (needed for vec_chunks cleanup)
    if (this.vecAvailable) {
      const rows = this.db!.prepare(
        'SELECT rowid FROM chunks WHERE file_path = ?'
      ).all(filePath) as Array<{ rowid: number }>;

      if (rows.length > 0) {
        const deleteVec = this.db!.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
        const deleteVecs = this.db!.transaction(() => {
          for (const row of rows) {
            try { deleteVec.run(row.rowid); } catch { /* vec row may not exist */ }
          }
        });
        deleteVecs();
      }
    }

    this.db!.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
  }

  /**
   * Update graph_edges table from vault file wikilinks.
   */
  private updateGraphEdges(file: VaultFile): void {
    // Remove existing edges from this source
    this.db!.prepare('DELETE FROM graph_edges WHERE source_file = ?').run(file.path);

    if (file.links.length === 0) return;

    const insertEdge = this.db!.prepare(`
      INSERT OR IGNORE INTO graph_edges (id, source_file, target_file, link_text, context, indexed_at)
      VALUES (?, ?, ?, ?, '', ?)
    `);

    const now = Date.now();
    const insertEdges = this.db!.transaction(() => {
      for (const link of file.links) {
        // Link text → possible file paths
        // Convention: [[Bob Friday]] → entities/people/bob-friday.md (or just the wikilink text)
        insertEdge.run(ulid(), file.path, link, link, now);
      }
    });

    insertEdges();
  }
}
