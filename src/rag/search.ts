/**
 * Search — Vector, FTS5, and graph walk retrieval functions.
 *
 * All functions operate on the shared Ved SQLite database.
 * Vector search uses sqlite-vec extension (KNN).
 * FTS uses SQLite FTS5 with BM25 ranking.
 * Graph walk follows wikilinks via graph_edges table.
 */

import type Database from 'better-sqlite3';
import type {
  VectorSearchResult, FtsSearchResult, GraphSearchResult,
  ChunkRow, FtsRow,
} from './types.js';
import type { Embedder } from './types.js';

/**
 * Vector similarity search via sqlite-vec.
 * Embeds the query, then finds nearest neighbors.
 */
export async function vectorSearch(
  db: Database.Database,
  embedder: Embedder,
  query: string,
  topK: number,
  excludePaths?: string[],
): Promise<VectorSearchResult[]> {
  // Embed the query
  const queryVec = await embedder.embedOne(query);

  // KNN search via vec_chunks virtual table
  // sqlite-vec uses MATCH for vector search
  const vecRows = db.prepare(`
    SELECT rowid, distance
    FROM vec_chunks
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(new Uint8Array(queryVec.buffer), topK * 2) as Array<{ rowid: number; distance: number }>;

  if (vecRows.length === 0) return [];

  // Join with chunks table for metadata
  const results: VectorSearchResult[] = [];

  for (const vr of vecRows) {
    const chunk = db.prepare(
      'SELECT * FROM chunks WHERE rowid = ?'
    ).get(vr.rowid) as ChunkRow | undefined;

    if (!chunk) continue;
    if (excludePaths?.includes(chunk.file_path)) continue;

    results.push({
      chunkId: chunk.id,
      filePath: chunk.file_path,
      heading: chunk.heading || null,
      content: chunk.content,
      distance: vr.distance,
      score: 1 / (1 + vr.distance), // normalize: closer → higher
    });

    if (results.length >= topK) break;
  }

  return results;
}

/**
 * Full-text search via FTS5 with BM25 ranking.
 */
export function ftsSearch(
  db: Database.Database,
  query: string,
  topK: number,
  excludePaths?: string[],
): FtsSearchResult[] {
  // Escape FTS5 special chars in user query
  const safeQuery = escapeFts5(query);
  if (!safeQuery) return [];

  let rows: FtsRow[];
  try {
    rows = db.prepare(`
      SELECT c.id, c.file_path, c.heading, c.content, f.rank
      FROM chunks_fts f
      JOIN chunks c ON c.rowid = f.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY f.rank
      LIMIT ?
    `).all(safeQuery, topK * 2) as FtsRow[];
  } catch {
    // FTS5 can throw on malformed queries — return empty
    return [];
  }

  if (rows.length === 0) return [];

  // Filter excluded paths
  const filtered = excludePaths
    ? rows.filter(r => !excludePaths.includes(r.file_path))
    : rows;

  // Normalize BM25 ranks to 0-1 scores
  // BM25 ranks are negative (lower = more relevant)
  const absRanks = filtered.map(r => Math.abs(r.rank));
  const maxRank = Math.max(...absRanks, 1); // avoid div-by-zero

  return filtered.slice(0, topK).map(r => ({
    chunkId: r.id,
    filePath: r.file_path,
    heading: r.heading || null,
    content: r.content,
    rank: r.rank,
    score: 1 - Math.abs(r.rank) / maxRank,
  }));
}

/**
 * Graph walk — follow wikilinks from seed files via graph_edges table.
 * BFS from seed files, scoring by backlink count and depth.
 */
export function graphSearch(
  db: Database.Database,
  seedFiles: string[],
  maxDepth: number,
  maxNodes: number,
  excludePaths?: string[],
): GraphSearchResult[] {
  if (seedFiles.length === 0) return [];

  const visited = new Set<string>(seedFiles); // seeds already in vector/FTS results
  const queue: Array<{ path: string; depth: number }> = [];
  const results: GraphSearchResult[] = [];

  // Initialize queue with outgoing links from seeds
  for (const seed of seedFiles) {
    const edges = db.prepare(
      'SELECT target_file FROM graph_edges WHERE source_file = ?'
    ).all(seed) as Array<{ target_file: string }>;

    for (const edge of edges) {
      if (!visited.has(edge.target_file)) {
        queue.push({ path: edge.target_file, depth: 1 });
      }
    }
  }

  while (queue.length > 0 && results.length < maxNodes) {
    const { path, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    if (visited.has(path)) continue;
    visited.add(path);

    if (excludePaths?.includes(path)) continue;

    // Get backlink count for this file
    const backlinkRow = db.prepare(
      'SELECT COUNT(*) as cnt FROM graph_edges WHERE target_file = ?'
    ).get(path) as { cnt: number } | undefined;
    const backlinkCount = backlinkRow?.cnt ?? 0;

    // Get chunk content for this file (first chunk as representative)
    const chunk = db.prepare(
      'SELECT content FROM chunks WHERE file_path = ? ORDER BY chunk_index LIMIT 1'
    ).get(path) as { content: string } | undefined;

    if (!chunk) continue; // file not indexed yet

    results.push({
      filePath: path,
      content: chunk.content,
      depth,
      backlinkCount,
      // Score: decay by depth, boost by backlink count (diminishing returns)
      score: (backlinkCount / (backlinkCount + 5)) * (1 / (depth + 1)),
    });

    // Enqueue outgoing links for deeper walk
    if (depth < maxDepth) {
      const edges = db.prepare(
        'SELECT target_file FROM graph_edges WHERE source_file = ?'
      ).all(path) as Array<{ target_file: string }>;

      for (const edge of edges) {
        if (!visited.has(edge.target_file)) {
          queue.push({ path: edge.target_file, depth: depth + 1 });
        }
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxNodes);
}

/**
 * Escape FTS5 special characters.
 * FTS5 operators: AND OR NOT NEAR " *
 * We wrap each word in quotes to treat them as literals.
 */
function escapeFts5(query: string): string {
  // Split into words, wrap each in quotes, join with space (implicit AND)
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  return words
    .map(w => `"${w.replace(/"/g, '""')}"`)
    .join(' ');
}
