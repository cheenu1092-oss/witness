/**
 * Reciprocal Rank Fusion (RRF) — combines three ranked retrieval lists.
 *
 * RRF formula: score(d) = Σ 1/(k + rank(d)) for each list containing d.
 * Default k=60 (standard in literature).
 *
 * Simple, parameter-free (besides k), handles heterogeneous score scales.
 */

import type { RetrievalSource } from '../types/index.js';
import type {
  VectorSearchResult, FtsSearchResult, GraphSearchResult,
  MergedResult,
} from './types.js';
import { estimateTokens } from './chunker.js';

/**
 * Fuse three retrieval result lists into a single ranked list via RRF.
 */
export function reciprocalRankFusion(
  vectorResults: VectorSearchResult[],
  ftsResults: FtsSearchResult[],
  graphResults: GraphSearchResult[],
  k: number = 60,
): MergedResult[] {
  const scoreMap = new Map<string, {
    score: number;
    sources: Set<RetrievalSource>;
    content: string;
    heading?: string | null;
    chunkId?: string;
  }>();

  function addScore(
    key: string,
    rank: number,
    source: RetrievalSource,
    content: string,
    heading?: string | null,
    chunkId?: string,
  ): void {
    const existing = scoreMap.get(key) ?? {
      score: 0, sources: new Set(), content, heading, chunkId,
    };
    existing.score += 1 / (k + rank + 1);
    existing.sources.add(source);
    // Keep longest content version
    if (content.length > existing.content.length) {
      existing.content = content;
    }
    if (heading && !existing.heading) {
      existing.heading = heading;
    }
    if (chunkId && !existing.chunkId) {
      existing.chunkId = chunkId;
    }
    scoreMap.set(key, existing);
  }

  // Add vector results (keyed by filePath to merge file-level)
  vectorResults.forEach((r, i) =>
    addScore(r.filePath, i, 'vector', r.content, r.heading, r.chunkId)
  );

  // Add FTS results
  ftsResults.forEach((r, i) =>
    addScore(r.filePath, i, 'fts', r.content, r.heading, r.chunkId)
  );

  // Add graph results
  graphResults.forEach((r, i) =>
    addScore(r.filePath, i, 'graph', r.content)
  );

  // Sort by RRF score descending
  const merged: MergedResult[] = [...scoreMap.entries()]
    .map(([filePath, entry]) => ({
      filePath,
      chunkId: entry.chunkId,
      heading: entry.heading,
      content: entry.content,
      rrfScore: entry.score,
      sources: [...entry.sources] as RetrievalSource[],
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore);

  return merged;
}

/**
 * Trim merged results to fit within a token budget.
 * Greedily adds results by RRF score until budget is exhausted.
 */
export function trimToTokenBudget(
  results: MergedResult[],
  maxTokens: number,
): { results: MergedResult[]; tokenCount: number } {
  const kept: MergedResult[] = [];
  let totalTokens = 0;

  for (const r of results) {
    const tokens = estimateTokens(r.content);
    if (totalTokens + tokens > maxTokens) {
      // If we haven't kept anything yet, include at least one (truncated)
      if (kept.length === 0) {
        const truncated = r.content.slice(0, maxTokens * 3); // rough char estimate
        kept.push({ ...r, content: truncated });
        totalTokens += estimateTokens(truncated);
      }
      break;
    }
    kept.push(r);
    totalTokens += tokens;
  }

  return { results: kept, tokenCount: totalTokens };
}

/**
 * Format merged results into a context string for prompt injection.
 */
export function formatContext(results: MergedResult[]): string {
  if (results.length === 0) return '';

  return results.map((r, i) => {
    const header = r.heading
      ? `[${r.filePath} § ${r.heading}]`
      : `[${r.filePath}]`;
    return `--- Context ${i + 1} ${header} ---\n${r.content}`;
  }).join('\n\n');
}
