/**
 * ved-memory — 4-tier memory hierarchy with Obsidian vault integration.
 *
 * Exports:
 * - MemoryManager: orchestrates T2 (episodic) and T3 (semantic) memory
 * - VaultManager: read/write/watch Obsidian vault files
 * - VaultGit: git integration for the vault
 * - TemplateEngine: template rendering for vault files
 * - Markdown utilities: parsing, serialization, wikilink extraction
 */

export { MemoryManager } from './manager.js';
export type { CompressResult, EntityUpsertInput, EntityQuery, MemoryOpResult } from './manager.js';

export { VaultManager } from './vault.js';
export type { VaultFileUpdate } from './vault.js';

export { VaultGit } from './vault-git.js';
export type { GitLogEntry } from './vault-git.js';

export { TemplateEngine, renderTemplate } from './template.js';

export {
  parseMarkdown, serializeMarkdown, mergeFrontmatter,
  extractWikilinks, extractLinkTargets, extractTags,
} from './markdown.js';
export type { ParsedMarkdown, WikiLink } from './markdown.js';
