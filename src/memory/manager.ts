/**
 * MemoryManager — Orchestrates the 4-tier memory hierarchy.
 *
 * T1: Working Memory (in-RAM, managed by ved-core's WorkingMemory)
 * T2: Episodic Memory (daily notes in Obsidian vault)
 * T3: Semantic Memory (entity/concept/decision files in vault)
 * T4: Archival + Audit (delegated to ved-audit + ved-rag)
 *
 * This module handles T2 and T3 operations and coordinates with
 * the VaultManager for file I/O.
 */

import { join } from 'node:path';

import type {
  VedConfig, MemoryOp, VaultFile, VaultEntityType,
  Confidence, KnowledgeSource, AuditEntryInput, ModuleHealth,
} from '../types/index.js';
import { VaultManager, type VaultFileUpdate } from './vault.js';
import { TemplateEngine } from './template.js';
import { parseMarkdown } from './markdown.js';
import { createLogger } from '../core/log.js';

const log = createLogger('memory');

// === Types ===

export interface CompressResult {
  dailyPath: string;
  summary: string;
  entitiesCreated: string[];
  entitiesUpdated: string[];
  factCount: number;
}

export interface EntityUpsertInput {
  filename: string;          // kebab-case, no extension
  folder: string;            // e.g. 'entities/people', 'projects', 'concepts'
  type: VaultEntityType;
  name: string;              // display name
  source: KnowledgeSource;
  confidence: Confidence;
  tags?: string[];
  extraFrontmatter?: Record<string, unknown>;
  body?: string;
  links?: string[];
  appendFacts?: string[];
}

export interface EntityQuery {
  type?: VaultEntityType;
  tags?: string[];
  folder?: string;
  frontmatter?: Record<string, unknown>;
  limit?: number;
}

export interface MemoryOpResult {
  op: MemoryOp;
  success: boolean;
  path?: string;
  error?: string;
}

type AuditCallback = (input: AuditEntryInput) => void;

/**
 * MemoryManager coordinates vault reads/writes for T2 (episodic) and T3 (semantic) memory.
 */
export class MemoryManager {
  readonly vault: VaultManager;
  private templates: TemplateEngine;
  private onAudit?: AuditCallback;

  constructor(vault: VaultManager, onAudit?: AuditCallback) {
    this.vault = vault;
    this.templates = new TemplateEngine();
    this.onAudit = onAudit;
  }

  /** Initialize: load templates from vault, ensure vault is ready. */
  async init(_config: VedConfig): Promise<void> {
    await this.vault.init();

    // Load custom templates if they exist
    const templatesDir = join(this.vault.path, 'templates');
    this.templates.loadFromDir(templatesDir);

    log.info('Memory manager initialized', {
      vaultPath: this.vault.path,
      templates: this.templates.list().length,
    });
  }

  /** Graceful shutdown: flush git, stop watcher. */
  async shutdown(): Promise<void> {
    this.vault.git.flush('ved: shutdown — final vault sync');
    this.vault.close();
    log.info('Memory manager shut down');
  }

  /** Health check. */
  healthCheck(): ModuleHealth {
    const index = this.vault.getIndex();
    return {
      module: 'memory',
      healthy: true,
      details: `${index.files.size} files, ${index.tags.size} tags, ${index.types.size} types`,
      checkedAt: Date.now(),
    };
  }

  // === T2: Episodic Memory ===

  /** Get today's daily note path (creates if missing). */
  getTodayPath(): string {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return `daily/${date}.md`;
  }

  /** Get today's daily note, creating it if it doesn't exist. */
  getTodayNote(): VaultFile {
    const path = this.getTodayPath();
    if (this.vault.exists(path)) {
      return this.vault.readFile(path);
    }

    // Create from template
    const date = new Date().toISOString().split('T')[0];
    const content = this.templates.render('daily', { date });
    if (content) {
      const { frontmatter, body } = parseMarkdown(content);
      this.vault.createFile(path, frontmatter, body);
    } else {
      this.vault.createFile(path, { type: 'daily', date }, `# ${date}\n`);
    }

    this.audit('memory_t2_compress', { action: 'daily_created', path });
    return this.vault.readFile(path);
  }

  /** Append content to today's daily note. */
  appendToDaily(content: string): void {
    const path = this.getTodayPath();
    this.vault.appendToFile(path, content);
    this.audit('memory_t2_compress', { action: 'daily_append', path, contentLength: content.length });
  }

  /**
   * Write a session compression result to the daily note.
   * This is called by ved-core after the LLM compresses T1→T2.
   */
  writeCompression(summary: string, sessionId?: string): string {
    const path = this.getTodayPath();
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const header = sessionId ? `## Session ${time} (${sessionId.slice(0, 8)})` : `## Session ${time}`;
    const content = `${header}\n${summary}`;

    this.vault.appendToFile(path, content);
    this.audit('memory_t2_compress', { action: 'session_compress', path, sessionId });

    return path;
  }

  // === T3: Semantic Memory ===

  /**
   * Create or update an entity file in the vault.
   * If the file exists, merges new data. If not, creates from template.
   */
  upsertEntity(input: EntityUpsertInput): string {
    const relPath = `${input.folder}/${input.filename}.md`;
    const now = new Date().toISOString();

    if (this.vault.exists(relPath)) {
      return this.updateEntity(relPath, input, now);
    } else {
      return this.createEntity(relPath, input, now);
    }
  }

  /** Read an entity by path or filename. */
  readEntity(pathOrFilename: string): VaultFile | null {
    // Try as path first
    if (this.vault.exists(pathOrFilename)) {
      return this.vault.readFile(pathOrFilename);
    }

    // Try resolving as wikilink
    const resolved = this.vault.resolveLink(pathOrFilename);
    if (resolved && this.vault.exists(resolved)) {
      return this.vault.readFile(resolved);
    }

    return null;
  }

  /** Query entities by type, tags, folder, or frontmatter. */
  queryEntities(query: EntityQuery): VaultFile[] {
    let paths: string[] = [];

    if (query.type) {
      paths = this.vault.findByType(query.type);
    } else if (query.tags && query.tags.length > 0) {
      // Intersection of all tag results
      const tagSets = query.tags.map(t => new Set(this.vault.findByTag(t)));
      if (tagSets.length > 0) {
        paths = [...tagSets[0]].filter(p => tagSets.every(s => s.has(p)));
      }
    } else if (query.folder) {
      paths = this.vault.listFiles(query.folder);
    } else {
      // All files
      const index = this.vault.getIndex();
      paths = [...index.files.values()];
    }

    // Apply frontmatter filter
    if (query.frontmatter) {
      paths = paths.filter(p => {
        try {
          const file = this.vault.readFile(p);
          return Object.entries(query.frontmatter!).every(
            ([k, v]) => file.frontmatter[k] === v,
          );
        } catch {
          return false;
        }
      });
    }

    // Apply limit
    if (query.limit && paths.length > query.limit) {
      paths = paths.slice(0, query.limit);
    }

    // Read and return files
    return paths
      .map(p => {
        try { return this.vault.readFile(p); } catch { return null; }
      })
      .filter((f): f is VaultFile => f !== null);
  }

  /** Delete an entity file. */
  deleteEntity(path: string): void {
    this.vault.deleteFile(path);
    this.audit('memory_t3_delete', { path });
  }

  // === Cross-tier: Execute memory operations ===

  /**
   * Execute a batch of memory operations from an LLM decision.
   * Returns results for each operation.
   */
  executeOps(ops: MemoryOp[], actor: string): MemoryOpResult[] {
    const results: MemoryOpResult[] = [];

    for (const op of ops) {
      try {
        switch (op.type) {
          case 'episodic_write': {
            if (op.append) {
              this.vault.appendToFile(op.path, op.content);
            } else {
              const { frontmatter, body } = parseMarkdown(op.content);
              if (this.vault.exists(op.path)) {
                this.vault.updateFile(op.path, { body, frontmatter });
              } else {
                this.vault.createFile(op.path, frontmatter, body);
              }
            }
            this.audit('memory_t2_compress', { action: 'episodic_write', path: op.path, actor });
            results.push({ op, success: true, path: op.path });
            break;
          }

          case 'semantic_upsert': {
            const existing = this.vault.exists(op.path);
            if (existing) {
              const update: VaultFileUpdate = {};
              if (op.frontmatter) update.frontmatter = op.frontmatter;
              if (op.body) update.body = op.body;
              this.vault.updateFile(op.path, update);
            } else {
              this.vault.createFile(
                op.path,
                op.frontmatter ?? {},
                op.body ?? '',
              );
            }
            this.audit('memory_t3_upsert', { path: op.path, actor, existed: existing });
            results.push({ op, success: true, path: op.path });
            break;
          }

          case 'rag_index': {
            // Emit event for ved-rag to handle
            this.vault.emit('rag-reindex', op.path);
            results.push({ op, success: true, path: op.path });
            break;
          }

          case 'working_set':
          case 'archival_log': {
            // These are handled by ved-core and ved-audit respectively
            results.push({ op, success: true });
            break;
          }

          default:
            results.push({ op, success: false, error: `Unknown op type: ${(op as MemoryOp).type}` });
        }
      } catch (err) {
        results.push({ op, success: false, error: (err as Error).message });
        log.warn('Memory op failed', { opType: op.type, error: (err as Error).message });
      }
    }

    return results;
  }

  // === Internal ===

  private createEntity(relPath: string, input: EntityUpsertInput, now: string): string {
    const templateVars: Record<string, unknown> = {
      name: input.name,
      created: now,
      updated: now,
      source: input.source,
      confidence: input.confidence,
      date: now.split('T')[0],
      description: input.body ?? '',
      facts: input.appendFacts ?? [],
      connections: input.links?.map(l => `[[${l}]]`) ?? [],
    };

    // Try rendering from template
    const templateName = input.type;
    let content = this.templates.render(templateName, templateVars);

    if (!content) {
      // Fallback: construct manually
      const frontmatter: Record<string, unknown> = {
        type: input.type,
        created: now,
        updated: now,
        source: input.source,
        confidence: input.confidence,
        tags: input.tags ?? [input.type],
        ...(input.extraFrontmatter ?? {}),
      };
      const body = input.body ?? `# ${input.name}\n`;
      this.vault.createFile(relPath, frontmatter, body);
      this.audit('memory_t3_upsert', { path: relPath, action: 'create' });
      return relPath;
    }

    // Parse and create from rendered template
    const { frontmatter, body } = parseMarkdown(content);

    // Merge extra frontmatter
    const fm = {
      ...frontmatter,
      tags: input.tags ?? frontmatter['tags'] ?? [input.type],
      ...(input.extraFrontmatter ?? {}),
    };

    this.vault.createFile(relPath, fm, body);
    this.audit('memory_t3_upsert', { path: relPath, action: 'create' });
    return relPath;
  }

  private updateEntity(relPath: string, input: EntityUpsertInput, now: string): string {
    const update: VaultFileUpdate = {
      frontmatter: {
        updated: now,
        source: input.source,
        confidence: input.confidence,
        ...(input.extraFrontmatter ?? {}),
      },
    };

    if (input.tags) {
      update.frontmatter!['tags'] = input.tags;
    }

    if (input.body) {
      update.body = input.body;
    }

    // Append facts to ## Key Facts section
    if (input.appendFacts && input.appendFacts.length > 0) {
      const existing = this.vault.readFile(relPath);
      const factsSection = input.appendFacts.map(f => `- ${f}`).join('\n');

      if (existing.body.includes('## Key Facts')) {
        // Find the section and append
        const body = existing.body.replace(
          /(## Key Facts\n(?:- .*\n)*)/,
          `$1${factsSection}\n`,
        );
        update.body = body;
      } else {
        // Add section
        update.appendBody = `\n## Key Facts\n${factsSection}`;
      }
    }

    // Append connections/links
    if (input.links && input.links.length > 0) {
      const existing = this.vault.readFile(relPath);
      const linksText = input.links.map(l => `- [[${l}]]`).join('\n');

      if (existing.body.includes('## Connections') || existing.body.includes('## Related')) {
        const sectionName = existing.body.includes('## Connections') ? '## Connections' : '## Related';
        const body = existing.body.replace(
          new RegExp(`(${sectionName}\\n(?:- .*\\n)*)`),
          `$1${linksText}\n`,
        );
        update.body = body;
      }
    }

    this.vault.updateFile(relPath, update);
    this.audit('memory_t3_upsert', { path: relPath, action: 'update' });
    return relPath;
  }

  private audit(eventType: string, detail: Record<string, unknown>): void {
    if (this.onAudit) {
      this.onAudit({
        eventType: eventType as AuditEntryInput['eventType'],
        actor: 'ved',
        detail,
      });
    }
  }
}
