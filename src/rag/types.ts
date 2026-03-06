/**
 * RAG module types — chunking, embedding, search, fusion.
 */

import type { VedId, RetrievalSource } from '../types/index.js';

// === Chunking ===

export interface ChunkResult {
  heading: string | null;
  headingLevel: number;
  content: string;
  tokenCount: number;
  chunkIndex: number;
}

// === Embedding ===

export interface Embedder {
  /** Embed one or more texts. Returns one Float32Array per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Embed a single text */
  embedOne(text: string): Promise<Float32Array>;
  /** Check if the embedding model is available */
  isAvailable(): Promise<boolean>;
  readonly model: string;
  readonly dimensions: number;
}

// === Search Results (internal) ===

export interface VectorSearchResult {
  chunkId: VedId;
  filePath: string;
  heading: string | null;
  content: string;
  distance: number;
  score: number; // normalized 0-1 (1 = best)
}

export interface FtsSearchResult {
  chunkId: VedId;
  filePath: string;
  heading: string | null;
  content: string;
  rank: number; // BM25 rank (lower = better)
  score: number; // normalized 0-1
}

export interface GraphSearchResult {
  filePath: string;
  content: string;
  depth: number;
  backlinkCount: number;
  score: number;
}

// === Fusion ===

export interface MergedResult {
  filePath: string;
  chunkId?: VedId;
  heading?: string | null;
  content: string;
  rrfScore: number;
  sources: RetrievalSource[];
}

// === Index Stats ===

export interface IndexStats {
  filesIndexed: number;
  chunksStored: number;
  ftsEntries: number;
  graphEdges: number;
  lastFullReindex?: number;
  lastIncrementalReindex?: number;
  queueDepth: number;
}

// === Retrieval Options ===

export interface RetrieveOptions {
  vectorTopK?: number;
  ftsTopK?: number;
  graphMaxDepth?: number;
  graphMaxNodes?: number;
  maxContextTokens?: number;
  excludePaths?: string[];
  boostPaths?: string[];
  sources?: RetrievalSource[];
}

// === Retrieval Context ===

export interface RetrievalContext {
  text: string;
  results: MergedResult[];
  tokenCount: number;
  metrics: RetrievalMetrics;
}

export interface RetrievalMetrics {
  vectorSearchMs: number;
  ftsSearchMs: number;
  graphWalkMs: number;
  fusionMs: number;
  totalMs: number;
  vectorResultCount: number;
  ftsResultCount: number;
  graphResultCount: number;
  mergedResultCount: number;
}

// === Chunk Row (from SQLite) ===

export interface ChunkRow {
  rowid: number;
  id: string;
  file_path: string;
  heading: string;
  heading_level: number;
  content: string;
  frontmatter: string;
  token_count: number;
  chunk_index: number;
  file_modified_at: number;
  indexed_at: number;
}

export interface FtsRow {
  rowid: number;
  id: string;
  file_path: string;
  heading: string;
  content: string;
  rank: number;
}

export interface GraphEdgeRow {
  id: string;
  source_file: string;
  target_file: string;
  link_text: string;
  context: string;
}
