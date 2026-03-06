/**
 * RAG module tests — chunker, embedder, search, fusion, pipeline.
 *
 * Chunker + fusion tests are pure (no DB, no network).
 * Search + pipeline tests use in-memory SQLite.
 * Embedder tests mock fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { chunkFile, estimateTokens } from './chunker.js';
import { OllamaEmbedder } from './embedder.js';
import { ftsSearch, graphSearch } from './search.js';
import { reciprocalRankFusion, trimToTokenBudget, formatContext } from './fusion.js';
import { RagPipeline } from './pipeline.js';
import type { VaultFile, VedConfig, RagConfig, ChunkConfig } from '../types/index.js';

// ── Helpers ──

function makeVaultFile(overrides: Partial<VaultFile> = {}): VaultFile {
  return {
    path: 'entities/people/bob-friday.md',
    frontmatter: { type: 'person', tags: ['person', 'colleague'], name: 'Bob Friday' },
    body: `# Bob Friday

## Key Facts
- Chief AI Officer at HPE Networking division, leading AI-driven self-driving networks
- Founded Mist Systems in 2014, pioneering indoor location services using BLE and Wi-Fi
- Previously held leadership positions at Cisco Systems for over a decade
- Reports: Nagarjun Srinivasan works under him as Principal Systems Engineer
- Published multiple patents on wireless signal strength methods and indoor positioning
- Known for the "self-driving network" vision that combines AI/ML with networking infrastructure

## Career
- Cisco Systems — Senior VP of Engineering, built the wireless networking division
- Mist Systems — Co-founder and CTO, raised over $100M in venture capital funding
- Juniper Networks — VP and GM after Juniper acquired Mist Systems in 2019 for $405M
- HPE Networking — Chief AI Officer after HPE acquired Juniper Networks in 2024
- Leading the convergence of AI and networking across campus, branch, and data center
- Pioneer in applying reinforcement learning and large language models to network operations`,
    links: ['nagarjun-srinivasan', 'hpe', 'mist-systems'],
    raw: '---\ntype: person\ntags: [person, colleague]\nname: Bob Friday\n---\n# Bob Friday\n...',
    stats: {
      created: new Date('2026-01-15'),
      modified: new Date('2026-03-01'),
      size: 800,
    },
    ...overrides,
  };
}

function defaultChunkConfig(): ChunkConfig {
  return {
    maxTokens: 1024,
    minTokens: 64,
    frontmatterPrefix: true,
  };
}

function makeVedConfig(ragOverrides: Partial<RagConfig> = {}): VedConfig {
  return {
    name: 'Ved',
    version: '0.1.0',
    dbPath: ':memory:',
    logLevel: 'error',
    logFormat: 'json',
    logFile: null,
    llm: {
      provider: 'anthropic',
      model: 'test',
      apiKey: null,
      baseUrl: null,
      maxTokensPerMessage: 4096,
      maxTokensPerSession: 100000,
      temperature: 0.7,
      systemPromptPath: null,
    },
    memory: {
      vaultPath: '/tmp/test-vault',
      workingMemoryMaxTokens: 4000,
      ragContextMaxTokens: 2000,
      compressionThreshold: 3000,
      sessionIdleMinutes: 30,
      gitEnabled: false,
      gitAutoCommitIntervalMinutes: 5,
    },
    trust: {
      ownerIds: ['owner-1'],
      tribeIds: [],
      knownIds: [],
      defaultTier: 1,
      approvalTimeoutMs: 300000,
      maxToolCallsPerMessage: 10,
      maxAgenticLoops: 5,
    },
    audit: {
      anchorInterval: 100,
      hmacSecret: null,
    },
    rag: {
      vectorTopK: 10,
      ftsTopK: 10,
      graphMaxDepth: 1,
      graphMaxNodes: 5,
      maxContextTokens: 2000,
      rrfK: 60,
      embedding: {
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434',
        batchSize: 32,
        dimensions: 768,
      },
      chunking: defaultChunkConfig(),
      ...ragOverrides,
    },
    channels: [],
    mcp: { servers: [] },
  };
}

/** Create test DB with required tables (subset of v001) */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      heading TEXT DEFAULT '',
      heading_level INTEGER DEFAULT 0,
      content TEXT NOT NULL,
      frontmatter TEXT DEFAULT '{}',
      token_count INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      file_modified_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE INDEX idx_chunks_file ON chunks(file_path);

    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content,
      file_path,
      heading,
      content=chunks,
      content_rowid=rowid,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, file_path, heading)
      VALUES (new.rowid, new.content, new.file_path, new.heading);
    END;

    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path, heading)
      VALUES ('delete', old.rowid, old.content, old.file_path, old.heading);
    END;

    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path, heading)
      VALUES ('delete', old.rowid, old.content, old.file_path, old.heading);
      INSERT INTO chunks_fts(rowid, content, file_path, heading)
      VALUES (new.rowid, new.content, new.file_path, new.heading);
    END;

    CREATE TABLE graph_edges (
      id TEXT PRIMARY KEY,
      source_file TEXT NOT NULL,
      target_file TEXT NOT NULL,
      link_text TEXT NOT NULL,
      context TEXT DEFAULT '',
      indexed_at INTEGER NOT NULL
    );
    CREATE INDEX idx_edges_source ON graph_edges(source_file);
    CREATE INDEX idx_edges_target ON graph_edges(target_file);
    CREATE UNIQUE INDEX idx_edges_pair ON graph_edges(source_file, target_file, link_text);
  `);

  return db;
}

/** Insert a test chunk directly */
function insertChunk(
  db: Database.Database,
  filePath: string,
  content: string,
  heading: string = '',
  chunkIndex: number = 0,
): number {
  const id = `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const info = db.prepare(`
    INSERT INTO chunks (id, file_path, heading, heading_level, content, frontmatter, token_count, chunk_index, file_modified_at, indexed_at)
    VALUES (?, ?, ?, 0, ?, '{}', ?, ?, ?, ?)
  `).run(id, filePath, heading, content, estimateTokens(content), chunkIndex, Date.now(), Date.now());
  return Number(info.lastInsertRowid);
}

/** Insert a test edge */
function insertEdge(db: Database.Database, source: string, target: string, linkText: string): void {
  const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT OR IGNORE INTO graph_edges (id, source_file, target_file, link_text, context, indexed_at)
    VALUES (?, ?, ?, ?, '', ?)
  `).run(id, source, target, linkText, Date.now());
}

// ═══════════════════════════════════════════
// Chunker Tests
// ═══════════════════════════════════════════

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    const tokens = estimateTokens('Hello, world! This is a test.');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('chunkFile', () => {
  const config = defaultChunkConfig();

  it('splits by H2 headings', () => {
    const file = makeVaultFile();
    const chunks = chunkFile(file, config);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should mention Key Facts
    expect(chunks.some(c => c.content.includes('Key Facts'))).toBe(true);
    // Second chunk should mention Career
    expect(chunks.some(c => c.content.includes('Career'))).toBe(true);
  });

  it('includes frontmatter prefix when enabled', () => {
    const file = makeVaultFile();
    const chunks = chunkFile(file, { ...config, frontmatterPrefix: true });

    // Prefix should include tags and name
    expect(chunks[0].content).toContain('person');
    expect(chunks[0].content).toContain('Bob Friday');
  });

  it('omits frontmatter prefix when disabled', () => {
    const file = makeVaultFile();
    const chunks = chunkFile(file, { ...config, frontmatterPrefix: false });

    // Should not start with tag prefix
    expect(chunks[0].content).not.toMatch(/^\[person/);
  });

  it('handles file with no headings', () => {
    const file = makeVaultFile({
      body: 'Just a plain text file with no headings. Some content here.',
      frontmatter: {},
    });
    const chunks = chunkFile(file, config);
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBeNull();
  });

  it('assigns sequential chunk indices', () => {
    const file = makeVaultFile();
    const chunks = chunkFile(file, config);
    chunks.forEach((c, i) => {
      expect(c.chunkIndex).toBe(i);
    });
  });

  it('merges small chunks below minTokens', () => {
    const file = makeVaultFile({
      body: '## A\nTiny\n\n## B\nAlso tiny\n\n## C\nThis one has enough content to stand alone on its own with several words and sentences.',
      frontmatter: {},
    });
    const chunks = chunkFile(file, { ...config, minTokens: 20, frontmatterPrefix: false });

    // A and B are tiny, should be merged
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  it('splits large sections at paragraph boundaries', () => {
    // Create a file with one huge section
    const bigBody = '## Big Section\n' +
      Array.from({ length: 50 }, (_, i) =>
        `Paragraph ${i}: This is a long paragraph with enough text to contribute to the token count significantly.`
      ).join('\n\n');

    const file = makeVaultFile({ body: bigBody, frontmatter: {} });
    const chunks = chunkFile(file, { ...config, maxTokens: 200, frontmatterPrefix: false });

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should be under maxTokens (approximately)
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(220); // allow slight overshoot from heading
    }
  });
});

// ═══════════════════════════════════════════
// Embedder Tests
// ═══════════════════════════════════════════

describe('OllamaEmbedder', () => {
  let embedder: OllamaEmbedder;

  beforeEach(() => {
    embedder = new OllamaEmbedder({
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
      batchSize: 2,
      dimensions: 768,
    });
  });

  it('returns empty array for empty input', async () => {
    const result = await embedder.embed([]);
    expect(result).toEqual([]);
  });

  it('reports model and dimensions', () => {
    expect(embedder.model).toBe('nomic-embed-text');
    expect(embedder.dimensions).toBe(768);
  });

  it('isAvailable returns false when Ollama is unreachable', async () => {
    const unreachable = new OllamaEmbedder({
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:99999',
      batchSize: 32,
      dimensions: 768,
    });
    const available = await unreachable.isAvailable();
    expect(available).toBe(false);
  });
});

// ═══════════════════════════════════════════
// FTS Search Tests
// ═══════════════════════════════════════════

describe('ftsSearch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertChunk(db, 'people/bob.md', 'Bob Friday is the Chief AI Officer at HPE', 'Key Facts');
    insertChunk(db, 'people/nag.md', 'Nagarjun works with Bob at HPE Networking', 'Work');
    insertChunk(db, 'concepts/mcp.md', 'MCP is the Model Context Protocol for tools', 'Overview');
  });

  afterEach(() => {
    db.close();
  });

  it('finds matching chunks by keyword', () => {
    const results = ftsSearch(db, 'HPE', 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every(r => r.content.includes('HPE'))).toBe(true);
  });

  it('ranks more relevant results higher', () => {
    const results = ftsSearch(db, 'Chief AI Officer', 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].filePath).toBe('people/bob.md');
  });

  it('returns empty for no matches', () => {
    const results = ftsSearch(db, 'xyzzyz nonexistent', 10);
    expect(results).toHaveLength(0);
  });

  it('respects topK limit', () => {
    const results = ftsSearch(db, 'HPE', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('excludes specified paths', () => {
    const results = ftsSearch(db, 'HPE', 10, ['people/bob.md']);
    expect(results.every(r => r.filePath !== 'people/bob.md')).toBe(true);
  });

  it('normalizes scores to 0-1', () => {
    const results = ftsSearch(db, 'HPE', 10);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('handles empty query', () => {
    const results = ftsSearch(db, '', 10);
    expect(results).toHaveLength(0);
  });

  it('handles special characters in query', () => {
    // Should not throw
    const results = ftsSearch(db, 'test (with) "quotes" AND OR', 10);
    expect(Array.isArray(results)).toBe(true);
  });
});

// ═══════════════════════════════════════════
// Graph Search Tests
// ═══════════════════════════════════════════

describe('graphSearch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Create a small graph: bob → nag → project
    insertChunk(db, 'people/bob.md', 'Bob Friday - Chief AI Officer');
    insertChunk(db, 'people/nag.md', 'Nagarjun Srinivasan - Principal Engineer');
    insertChunk(db, 'projects/ved.md', 'Ved - Personal AI assistant');
    insertChunk(db, 'concepts/audit.md', 'Audit trail for AI agents');

    insertEdge(db, 'people/bob.md', 'people/nag.md', 'nagarjun');
    insertEdge(db, 'people/nag.md', 'projects/ved.md', 'ved');
    insertEdge(db, 'projects/ved.md', 'concepts/audit.md', 'audit');
    insertEdge(db, 'people/nag.md', 'people/bob.md', 'bob-friday');
  });

  afterEach(() => {
    db.close();
  });

  it('finds linked files from seeds', () => {
    const results = graphSearch(db, ['people/bob.md'], 1, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.filePath === 'people/nag.md')).toBe(true);
  });

  it('respects maxDepth', () => {
    // Depth 1: bob → nag only (project is depth 2)
    const results = graphSearch(db, ['people/bob.md'], 1, 10);
    expect(results.every(r => r.depth <= 1)).toBe(true);
  });

  it('respects maxNodes', () => {
    const results = graphSearch(db, ['people/bob.md'], 3, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for no seeds', () => {
    const results = graphSearch(db, [], 1, 5);
    expect(results).toHaveLength(0);
  });

  it('excludes seed files from results', () => {
    const results = graphSearch(db, ['people/bob.md'], 2, 10);
    expect(results.every(r => r.filePath !== 'people/bob.md')).toBe(true);
  });

  it('excludes specified paths', () => {
    const results = graphSearch(db, ['people/bob.md'], 1, 5, ['people/nag.md']);
    expect(results.every(r => r.filePath !== 'people/nag.md')).toBe(true);
  });

  it('scores include backlink count and depth', () => {
    const results = graphSearch(db, ['people/bob.md'], 1, 5);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.backlinkCount).toBeGreaterThanOrEqual(0);
      expect(r.depth).toBeGreaterThanOrEqual(1);
    }
  });

  it('handles deeper walks', () => {
    // Depth 2: bob → nag → project, ved
    const results = graphSearch(db, ['people/bob.md'], 2, 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════
// Fusion Tests
// ═══════════════════════════════════════════

describe('reciprocalRankFusion', () => {
  it('combines results from multiple sources', () => {
    const vec = [
      { chunkId: 'c1', filePath: 'a.md', heading: null, content: 'alpha', distance: 0.1, score: 0.9 },
      { chunkId: 'c2', filePath: 'b.md', heading: null, content: 'beta', distance: 0.2, score: 0.8 },
    ];
    const fts = [
      { chunkId: 'c3', filePath: 'b.md', heading: null, content: 'beta longer', rank: -5, score: 0.9 },
      { chunkId: 'c4', filePath: 'c.md', heading: null, content: 'gamma', rank: -3, score: 0.7 },
    ];
    const graph = [
      { filePath: 'a.md', content: 'alpha graph', depth: 1, backlinkCount: 3, score: 0.5 },
    ];

    const merged = reciprocalRankFusion(vec, fts, graph);

    // All files should appear
    const paths = merged.map(r => r.filePath);
    expect(paths).toContain('a.md');
    expect(paths).toContain('b.md');
    expect(paths).toContain('c.md');

    // Results in multiple sources should score higher
    const aResult = merged.find(r => r.filePath === 'a.md')!;
    const bResult = merged.find(r => r.filePath === 'b.md')!;
    const cResult = merged.find(r => r.filePath === 'c.md')!;

    // a.md appears in vector + graph, b.md in vector + fts
    expect(aResult.sources).toContain('vector');
    expect(aResult.sources).toContain('graph');
    expect(bResult.sources).toContain('vector');
    expect(bResult.sources).toContain('fts');
    expect(cResult.sources).toContain('fts');

    // Multi-source results should have higher RRF scores than single-source
    expect(aResult.rrfScore).toBeGreaterThan(cResult.rrfScore);
    expect(bResult.rrfScore).toBeGreaterThan(cResult.rrfScore);
  });

  it('returns empty for empty inputs', () => {
    const merged = reciprocalRankFusion([], [], []);
    expect(merged).toHaveLength(0);
  });

  it('sorts by RRF score descending', () => {
    const vec = [
      { chunkId: 'c1', filePath: 'a.md', heading: null, content: 'a', distance: 0, score: 1 },
      { chunkId: 'c2', filePath: 'b.md', heading: null, content: 'b', distance: 1, score: 0.5 },
    ];

    const merged = reciprocalRankFusion(vec, [], []);
    expect(merged[0].rrfScore).toBeGreaterThanOrEqual(merged[1].rrfScore);
  });

  it('keeps longest content version', () => {
    const vec = [
      { chunkId: 'c1', filePath: 'a.md', heading: null, content: 'short', distance: 0, score: 1 },
    ];
    const fts = [
      { chunkId: 'c2', filePath: 'a.md', heading: null, content: 'much longer content here', rank: -5, score: 1 },
    ];

    const merged = reciprocalRankFusion(vec, fts, []);
    expect(merged[0].content).toBe('much longer content here');
  });
});

describe('trimToTokenBudget', () => {
  it('trims results to fit budget', () => {
    const results = [
      { filePath: 'a.md', content: 'A'.repeat(100), rrfScore: 0.9, sources: ['vector' as const] },
      { filePath: 'b.md', content: 'B'.repeat(100), rrfScore: 0.8, sources: ['fts' as const] },
      { filePath: 'c.md', content: 'C'.repeat(100), rrfScore: 0.7, sources: ['graph' as const] },
    ];

    const { results: trimmed, tokenCount } = trimToTokenBudget(results, 50);
    expect(trimmed.length).toBeLessThan(results.length);
    expect(tokenCount).toBeLessThanOrEqual(50);
  });

  it('includes at least one result even if over budget', () => {
    const results = [
      { filePath: 'a.md', content: 'A'.repeat(500), rrfScore: 0.9, sources: ['vector' as const] },
    ];

    const { results: trimmed } = trimToTokenBudget(results, 10);
    expect(trimmed.length).toBe(1);
  });

  it('returns all results if within budget', () => {
    const results = [
      { filePath: 'a.md', content: 'Short text', rrfScore: 0.9, sources: ['vector' as const] },
      { filePath: 'b.md', content: 'Also short', rrfScore: 0.8, sources: ['fts' as const] },
    ];

    const { results: trimmed } = trimToTokenBudget(results, 10000);
    expect(trimmed.length).toBe(2);
  });
});

describe('formatContext', () => {
  it('formats results with file path headers', () => {
    const results = [
      { filePath: 'a.md', heading: 'Facts', content: 'Some content', rrfScore: 0.9, sources: ['vector' as const] },
      { filePath: 'b.md', content: 'Other content', rrfScore: 0.8, sources: ['fts' as const] },
    ];

    const text = formatContext(results);
    expect(text).toContain('[a.md § Facts]');
    expect(text).toContain('[b.md]');
    expect(text).toContain('Some content');
    expect(text).toContain('Other content');
  });

  it('returns empty string for no results', () => {
    expect(formatContext([])).toBe('');
  });
});

// ═══════════════════════════════════════════
// Pipeline Tests
// ═══════════════════════════════════════════

describe('RagPipeline', () => {
  let pipeline: RagPipeline;
  let db: Database.Database;

  beforeEach(async () => {
    pipeline = new RagPipeline();
    db = createTestDb();

    // Mock embedder availability (Ollama won't be running in tests)
    const config = makeVedConfig();
    await pipeline.init(config);
    pipeline.setDatabase(db);
  });

  afterEach(async () => {
    await pipeline.shutdown();
    db.close();
  });

  describe('init + healthCheck', () => {
    it('reports healthy after init + setDatabase', async () => {
      const health = await pipeline.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.module).toBe('rag');
    });
  });

  describe('indexFile', () => {
    it('indexes vault file into chunks', async () => {
      const file = makeVaultFile();
      await pipeline.indexFile(file);

      const stats = pipeline.stats();
      expect(stats.filesIndexed).toBe(1);
      expect(stats.chunksStored).toBeGreaterThanOrEqual(2); // H2 sections
    });

    it('stores graph edges from wikilinks', async () => {
      const file = makeVaultFile();
      await pipeline.indexFile(file);

      const stats = pipeline.stats();
      expect(stats.graphEdges).toBe(3); // 3 wikilinks
    });

    it('replaces chunks on re-index', async () => {
      const file = makeVaultFile();
      await pipeline.indexFile(file);
      const statsBefore = pipeline.stats();

      // Re-index same file
      await pipeline.indexFile(file);
      const statsAfter = pipeline.stats();

      expect(statsAfter.chunksStored).toBe(statsBefore.chunksStored);
    });
  });

  describe('removeFile', () => {
    it('removes chunks and edges for file', async () => {
      const file = makeVaultFile();
      await pipeline.indexFile(file);
      expect(pipeline.stats().chunksStored).toBeGreaterThan(0);

      pipeline.removeFile(file.path);
      expect(pipeline.stats().chunksStored).toBe(0);
      expect(pipeline.stats().graphEdges).toBe(0);
    });
  });

  describe('fullReindex', () => {
    it('clears and re-indexes all files', async () => {
      const file1 = makeVaultFile({ path: 'a.md' });
      const file2 = makeVaultFile({ path: 'b.md', links: [] });

      await pipeline.indexFile(file1);

      const stats = await pipeline.fullReindex([file1, file2]);
      expect(stats.filesIndexed).toBe(2);
    });
  });

  describe('retrieve (FTS-only, no vector)', () => {
    it('retrieves matching chunks via FTS', async () => {
      const file = makeVaultFile();
      await pipeline.indexFile(file);

      const ctx = await pipeline.retrieve('Chief AI Officer', {
        sources: ['fts'], // skip vector (no Ollama in tests)
      });

      expect(ctx.results.length).toBeGreaterThanOrEqual(1);
      expect(ctx.text).toContain('Chief AI Officer');
      expect(ctx.tokenCount).toBeGreaterThan(0);
      expect(ctx.metrics.ftsSearchMs).toBeGreaterThanOrEqual(0);
    });

    it('returns empty for no matches', async () => {
      const file = makeVaultFile();
      await pipeline.indexFile(file);

      const ctx = await pipeline.retrieve('xyzzyz nonexistent', {
        sources: ['fts'],
      });

      expect(ctx.results).toHaveLength(0);
      expect(ctx.text).toBe('');
    });

    it('uses graph walk seeded from FTS', async () => {
      // Create linked files
      const bob = makeVaultFile();
      const nag = makeVaultFile({
        path: 'nagarjun-srinivasan',
        body: 'Nagarjun works at HPE with Bob',
        frontmatter: { type: 'person', name: 'Nagarjun' },
        links: [],
      });
      await pipeline.indexFile(bob);
      await pipeline.indexFile(nag);

      const ctx = await pipeline.retrieve('Chief AI Officer HPE', {
        sources: ['fts', 'graph'],
      });

      expect(ctx.metrics.graphWalkMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('enqueueReindex + drainQueue', () => {
    it('processes queued files', async () => {
      const file = makeVaultFile();
      pipeline.enqueueReindex(file.path);

      const processed = await pipeline.drainQueue(async (path) => {
        if (path === file.path) return file;
        return null;
      });

      expect(processed).toBe(1);
      expect(pipeline.stats().chunksStored).toBeGreaterThan(0);
    });

    it('removes deleted files from index', async () => {
      const file = makeVaultFile();
      await pipeline.indexFile(file);
      expect(pipeline.stats().chunksStored).toBeGreaterThan(0);

      pipeline.enqueueReindex(file.path);
      await pipeline.drainQueue(async () => null); // file "deleted"

      expect(pipeline.stats().chunksStored).toBe(0);
    });
  });

  describe('stats', () => {
    it('returns correct counts', async () => {
      const stats = pipeline.stats();
      expect(stats.filesIndexed).toBe(0);
      expect(stats.chunksStored).toBe(0);
      expect(stats.graphEdges).toBe(0);
      expect(stats.queueDepth).toBe(0);
    });
  });
});
