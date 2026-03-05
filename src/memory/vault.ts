/**
 * VaultManager — Read/write/watch Obsidian vault files.
 *
 * Maintains an in-memory index of:
 * - files: Map<filename, filepath>
 * - backlinks: Map<filename, Set<filenames linking to it>>
 * - tags: Map<tag, Set<filepaths>>
 * - types: Map<entityType, Set<filepaths>>
 *
 * Emits 'file-changed' events for external watchers (RAG re-index, audit).
 */

import {
  readFileSync, writeFileSync, readdirSync, existsSync,
  mkdirSync, unlinkSync, renameSync, statSync, watch,
} from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { EventEmitter } from 'node:events';

import type { VaultFile, VaultFileStats, VaultIndex, VaultEntityType, GraphNode, GraphWalkOptions } from '../types/index.js';
import { parseMarkdown, serializeMarkdown, mergeFrontmatter, extractLinkTargets } from './markdown.js';
import { VaultGit } from './vault-git.js';
import { createLogger } from '../core/log.js';

const log = createLogger('vault');

export interface VaultFileUpdate {
  frontmatter?: Partial<Record<string, unknown>>;
  body?: string;
  appendBody?: string;
  mergeFrontmatter?: boolean;  // default true
}

type FileChangeHandler = (path: string, changeType: 'create' | 'update' | 'delete') => void;

/**
 * Manages the Obsidian vault filesystem, index, and graph.
 */
export class VaultManager extends EventEmitter {
  private vaultPath: string = '';
  private initialized = false;

  // In-memory index
  private fileIndex: Map<string, string> = new Map();   // filename (no ext) → relative path
  private backlinkIndex: Map<string, Set<string>> = new Map(); // filename → set of filenames linking to it
  private tagIndex: Map<string, Set<string>> = new Map();      // tag → set of file paths
  private typeIndex: Map<string, Set<string>> = new Map();     // entity type → set of file paths

  // FS watcher
  private watcher: ReturnType<typeof watch> | null = null;
  private watchDebounce: Map<string, NodeJS.Timeout> = new Map();

  // Git
  readonly git: VaultGit;

  // Change handlers
  private changeHandlers: Set<FileChangeHandler> = new Set();

  constructor(vaultPath: string, gitEnabled = true) {
    super();
    this.vaultPath = vaultPath;
    this.git = new VaultGit(vaultPath, gitEnabled);
  }

  /** Initialize the vault: create structure, build index. */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Create vault directory structure
    const folders = [
      'daily', 'entities/people', 'entities/orgs', 'entities/places',
      'projects', 'concepts', 'decisions', 'topics', 'templates',
    ];
    for (const folder of folders) {
      mkdirSync(join(this.vaultPath, folder), { recursive: true });
    }

    // Initialize git if not already
    this.git.init();

    // Build index
    await this.rebuildIndex();

    this.initialized = true;
    log.info('Vault initialized', { path: this.vaultPath, files: this.fileIndex.size });
  }

  /** Start watching for filesystem changes (human edits). */
  startWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.vaultPath, { recursive: true }, (_eventType, filename) => {
        if (!filename || filename.startsWith('.git') || filename.startsWith('.obsidian')) return;
        if (!filename.endsWith('.md')) return;

        // Debounce rapid changes
        const key = filename;
        const existing = this.watchDebounce.get(key);
        if (existing) clearTimeout(existing);

        this.watchDebounce.set(key, setTimeout(() => {
          this.watchDebounce.delete(key);
          this.handleExternalChange(filename);
        }, 500));
      });
      log.info('Vault watcher started');
    } catch (err) {
      log.warn('Failed to start vault watcher', { error: (err as Error).message });
    }
  }

  /** Stop watching. */
  stopWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timeout of this.watchDebounce.values()) {
      clearTimeout(timeout);
    }
    this.watchDebounce.clear();
  }

  /** Close the vault manager. */
  close(): void {
    this.stopWatch();
    this.initialized = false;
  }

  // === Read ===

  /** Read and parse a vault file. Path is relative to vault root. */
  readFile(relPath: string): VaultFile {
    const absPath = join(this.vaultPath, relPath);
    if (!existsSync(absPath)) {
      throw new Error(`Vault file not found: ${relPath}`);
    }

    const raw = readFileSync(absPath, 'utf-8');
    const { frontmatter, body } = parseMarkdown(raw);
    const links = extractLinkTargets(raw);
    const stats = this.getFileStats(absPath);

    return { path: relPath, frontmatter, body, links, raw, stats };
  }

  /** Check if a file exists in the vault. */
  exists(relPath: string): boolean {
    return existsSync(join(this.vaultPath, relPath));
  }

  /** List all .md files in a folder (or entire vault). */
  listFiles(folder?: string): string[] {
    const dir = folder ? join(this.vaultPath, folder) : this.vaultPath;
    if (!existsSync(dir)) return [];
    return this.walkDir(dir).map(f => relative(this.vaultPath, f));
  }

  /** Get files that link TO this filename. */
  getBacklinks(filename: string): string[] {
    const normalized = filename.replace(/\.md$/, '').toLowerCase();
    const links = this.backlinkIndex.get(normalized);
    return links ? [...links] : [];
  }

  /** Resolve a wikilink target to a file path. */
  resolveLink(wikilink: string): string | null {
    const normalized = wikilink.toLowerCase().replace(/\.md$/, '');
    return this.fileIndex.get(normalized) ?? null;
  }

  // === Write ===

  /** Create a new file with frontmatter and body. */
  createFile(relPath: string, frontmatter: Record<string, unknown>, body: string): void {
    const absPath = join(this.vaultPath, relPath);
    mkdirSync(dirname(absPath), { recursive: true });

    const content = serializeMarkdown(frontmatter, body);
    writeFileSync(absPath, content, 'utf-8');

    this.indexFile(relPath, content);
    this.git.markDirty(relPath);
    this.emitChange(relPath, 'create');
    log.debug('Created vault file', { path: relPath });
  }

  /** Update an existing file. */
  updateFile(relPath: string, updates: VaultFileUpdate): void {
    const file = this.readFile(relPath);
    const absPath = join(this.vaultPath, relPath);

    let fm = file.frontmatter;
    if (updates.frontmatter) {
      fm = updates.mergeFrontmatter !== false
        ? mergeFrontmatter(fm, updates.frontmatter)
        : { ...fm, ...updates.frontmatter };
    }

    let body = file.body;
    if (updates.body !== undefined) {
      body = updates.body;
    }
    if (updates.appendBody) {
      body = body + '\n' + updates.appendBody;
    }

    // Update the "updated" timestamp
    fm['updated'] = new Date().toISOString();

    const content = serializeMarkdown(fm, body);
    writeFileSync(absPath, content, 'utf-8');

    this.indexFile(relPath, content);
    this.git.markDirty(relPath);
    this.emitChange(relPath, 'update');
    log.debug('Updated vault file', { path: relPath });
  }

  /** Append content to a file (used for daily notes). */
  appendToFile(relPath: string, content: string): void {
    const absPath = join(this.vaultPath, relPath);
    if (!existsSync(absPath)) {
      // Create with minimal frontmatter
      this.createFile(relPath, { type: 'daily', date: basename(relPath, '.md') }, content);
      return;
    }

    const existing = readFileSync(absPath, 'utf-8');
    const newContent = existing.trimEnd() + '\n\n' + content + '\n';
    writeFileSync(absPath, newContent, 'utf-8');

    this.indexFile(relPath, newContent);
    this.git.markDirty(relPath);
    this.emitChange(relPath, 'update');
    log.debug('Appended to vault file', { path: relPath });
  }

  /** Delete a vault file. */
  deleteFile(relPath: string): void {
    const absPath = join(this.vaultPath, relPath);
    if (!existsSync(absPath)) return;

    unlinkSync(absPath);
    this.unindexFile(relPath);
    this.git.markDirty(relPath);
    this.emitChange(relPath, 'delete');
    log.debug('Deleted vault file', { path: relPath });
  }

  /** Rename/move a vault file. Updates all wikilinks referencing it. */
  renameFile(oldPath: string, newPath: string): void {
    const absOld = join(this.vaultPath, oldPath);
    const absNew = join(this.vaultPath, newPath);
    mkdirSync(dirname(absNew), { recursive: true });

    renameSync(absOld, absNew);
    this.unindexFile(oldPath);

    const content = readFileSync(absNew, 'utf-8');
    this.indexFile(newPath, content);

    this.git.markDirty(oldPath);
    this.git.markDirty(newPath);
    this.emitChange(oldPath, 'delete');
    this.emitChange(newPath, 'create');
    log.debug('Renamed vault file', { from: oldPath, to: newPath });
  }

  // === Search (local, non-RAG) ===

  /** Find files with a specific tag. */
  findByTag(tag: string): string[] {
    const normalized = tag.toLowerCase().replace(/^#/, '');
    const paths = this.tagIndex.get(normalized);
    return paths ? [...paths] : [];
  }

  /** Find files of a specific entity type. */
  findByType(type: VaultEntityType): string[] {
    const paths = this.typeIndex.get(type);
    return paths ? [...paths] : [];
  }

  /** Find files where frontmatter key matches value. */
  findByFrontmatter(key: string, value: unknown): string[] {
    const results: string[] = [];
    for (const [, relPath] of this.fileIndex) {
      try {
        const file = this.readFile(relPath);
        if (file.frontmatter[key] === value) {
          results.push(relPath);
        }
      } catch {
        // Skip unreadable files
      }
    }
    return results;
  }

  // === Graph ===

  /** Walk the wikilink graph from starting files via BFS. */
  walkGraph(opts: GraphWalkOptions): GraphNode[] {
    const visited = new Map<string, GraphNode>();
    const queue: Array<{ path: string; depth: number }> = [];
    let totalTokens = 0;

    // Initialize queue with start files
    for (const start of opts.startFiles) {
      const resolved = this.resolveLink(start) ?? start;
      if (this.exists(resolved)) {
        queue.push({ path: resolved, depth: 0 });
      }
    }

    while (queue.length > 0 && visited.size < opts.maxNodes) {
      const item = queue.shift()!;
      if (visited.has(item.path)) continue;
      if (item.depth > opts.maxDepth) continue;

      // Check excluded folders
      if (opts.excludeFolders?.some(f => item.path.startsWith(f))) continue;

      try {
        const file = this.readFile(item.path);
        const tokenEstimate = Math.ceil(file.body.length / 4);

        if (totalTokens + tokenEstimate > opts.maxTokens && visited.size > 0) {
          continue; // skip if over budget (but allow at least the first node)
        }

        const filename = basename(item.path, '.md').toLowerCase();
        const backlinks = this.getBacklinks(filename);

        const node: GraphNode = {
          path: item.path,
          content: file.body,
          frontmatter: file.frontmatter,
          links: file.links,
          backlinks,
          depth: item.depth,
        };

        visited.set(item.path, node);
        totalTokens += tokenEstimate;

        // Enqueue linked files at depth+1
        if (item.depth < opts.maxDepth) {
          for (const link of file.links) {
            const resolved = this.resolveLink(link);
            if (resolved && !visited.has(resolved)) {
              queue.push({ path: resolved, depth: item.depth + 1 });
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by depth (closer first), then by backlink count (more connected first)
    return [...visited.values()].sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return b.backlinks.length - a.backlinks.length;
    });
  }

  /** Get outgoing wikilinks from a file. */
  getLinks(relPath: string): string[] {
    try {
      const file = this.readFile(relPath);
      return file.links;
    } catch {
      return [];
    }
  }

  /** Get the full backlink index. */
  getAllBacklinks(): Map<string, Set<string>> {
    return new Map(this.backlinkIndex);
  }

  // === Index ===

  /** Full rebuild of all indices. */
  async rebuildIndex(): Promise<void> {
    this.fileIndex.clear();
    this.backlinkIndex.clear();
    this.tagIndex.clear();
    this.typeIndex.clear();

    const allFiles = this.walkDir(this.vaultPath);

    for (const absPath of allFiles) {
      const relPath = relative(this.vaultPath, absPath);
      try {
        const content = readFileSync(absPath, 'utf-8');
        this.indexFile(relPath, content);
      } catch {
        // Skip unreadable files
      }
    }

    log.info('Vault index rebuilt', {
      files: this.fileIndex.size,
      tags: this.tagIndex.size,
      types: this.typeIndex.size,
    });
  }

  /** Get current index state. */
  getIndex(): VaultIndex {
    return {
      files: new Map(this.fileIndex),
      backlinks: new Map([...this.backlinkIndex].map(([k, v]) => [k, new Set(v)])),
      tags: new Map([...this.tagIndex].map(([k, v]) => [k, new Set(v)])),
      types: new Map([...this.typeIndex].map(([k, v]) => [k, new Set(v)])),
    };
  }

  /** Get the absolute vault path. */
  get path(): string {
    return this.vaultPath;
  }

  // === Event handling ===

  onFileChanged(handler: FileChangeHandler): void {
    this.changeHandlers.add(handler);
  }

  offFileChanged(handler: FileChangeHandler): void {
    this.changeHandlers.delete(handler);
  }

  // === Internal ===

  private emitChange(path: string, changeType: 'create' | 'update' | 'delete'): void {
    for (const handler of this.changeHandlers) {
      try {
        handler(path, changeType);
      } catch (err) {
        log.warn('File change handler error', { path, error: (err as Error).message });
      }
    }
    this.emit('file-changed', path, changeType);
  }

  private handleExternalChange(filename: string): void {
    const relPath = filename;
    const absPath = join(this.vaultPath, relPath);

    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath, 'utf-8');
        this.indexFile(relPath, content);
        this.emitChange(relPath, 'update');
        this.git.markDirty(relPath);
        log.info('External file change detected', { path: relPath });
      } catch {
        // Ignore read errors
      }
    } else {
      this.unindexFile(relPath);
      this.emitChange(relPath, 'delete');
      log.info('External file deletion detected', { path: relPath });
    }
  }

  private indexFile(relPath: string, content: string): void {
    const filename = basename(relPath, '.md').toLowerCase();
    this.fileIndex.set(filename, relPath);

    const { frontmatter } = parseMarkdown(content);

    // Index links (backlinks)
    const links = extractLinkTargets(content);
    for (const target of links) {
      const targetLower = target.toLowerCase();
      if (!this.backlinkIndex.has(targetLower)) {
        this.backlinkIndex.set(targetLower, new Set());
      }
      this.backlinkIndex.get(targetLower)!.add(filename);
    }

    // Index tags (from frontmatter)
    const fmTags = frontmatter['tags'];
    if (Array.isArray(fmTags)) {
      for (const tag of fmTags) {
        const tagLower = String(tag).toLowerCase();
        if (!this.tagIndex.has(tagLower)) {
          this.tagIndex.set(tagLower, new Set());
        }
        this.tagIndex.get(tagLower)!.add(relPath);
      }
    }

    // Index type
    const type = frontmatter['type'];
    if (typeof type === 'string') {
      if (!this.typeIndex.has(type)) {
        this.typeIndex.set(type, new Set());
      }
      this.typeIndex.get(type)!.add(relPath);
    }
  }

  private unindexFile(relPath: string): void {
    const filename = basename(relPath, '.md').toLowerCase();
    this.fileIndex.delete(filename);

    // Remove from backlink index (as a source)
    for (const [, sources] of this.backlinkIndex) {
      sources.delete(filename);
    }

    // Remove from tag index
    for (const [, paths] of this.tagIndex) {
      paths.delete(relPath);
    }

    // Remove from type index
    for (const [, paths] of this.typeIndex) {
      paths.delete(relPath);
    }
  }

  private walkDir(dir: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue; // skip .git, .obsidian
        if (entry.name === 'templates') continue; // skip templates
        results.push(...this.walkDir(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private getFileStats(absPath: string): VaultFileStats {
    const stat = statSync(absPath);
    return {
      created: stat.birthtime,
      modified: stat.mtime,
      size: stat.size,
    };
  }
}
