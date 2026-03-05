/**
 * Markdown parsing utilities for Obsidian vault files.
 *
 * Handles:
 * - YAML frontmatter extraction and serialization
 * - [[wikilink]] parsing (with aliases and headings)
 * - #tag extraction from body text
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// === Frontmatter ===

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\n)?---\r?\n?/;

/**
 * Parse a Markdown file into frontmatter + body.
 * Returns empty frontmatter if none found.
 */
export function parseMarkdown(raw: string): ParsedMarkdown {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: raw.trim(), raw };
  }

  let frontmatter: Record<string, unknown> = {};
  const yamlContent = match[1] ?? '';
  try {
    const parsed = parseYaml(yamlContent);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid YAML — treat as no frontmatter
    frontmatter = {};
  }

  const body = raw.slice(match[0].length).trim();
  return { frontmatter, body, raw };
}

/**
 * Serialize frontmatter + body back to Markdown.
 */
export function serializeMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlStr = stringifyYaml(frontmatter, { lineWidth: 0 }).trim();
  return `---\n${yamlStr}\n---\n\n${body}\n`;
}

/**
 * Merge new frontmatter into existing, preserving existing keys unless overridden.
 */
export function mergeFrontmatter(
  existing: Record<string, unknown>,
  updates: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    // Arrays: replace entirely (tags, aliases)
    // Objects: shallow merge
    if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
        typeof merged[key] === 'object' && merged[key] !== null && !Array.isArray(merged[key])) {
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// === Wikilinks ===

/**
 * A parsed [[wikilink]].
 */
export interface WikiLink {
  /** Raw text inside [[...]] */
  raw: string;
  /** Target filename (before | or #) */
  target: string;
  /** Display text (after |), or same as target */
  display: string;
  /** Heading reference (after #), or null */
  heading: string | null;
}

// Matches [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]]
const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;

/**
 * Extract all [[wikilinks]] from markdown text.
 * Handles aliases and heading references.
 */
export function extractWikilinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex
  WIKILINK_RE.lastIndex = 0;

  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const raw = match[1];
    let target = raw;
    let display = raw;
    let heading: string | null = null;

    // Split alias: [[target|display]]
    const pipeIdx = raw.indexOf('|');
    if (pipeIdx !== -1) {
      target = raw.slice(0, pipeIdx);
      display = raw.slice(pipeIdx + 1);
    }

    // Split heading: [[target#heading]]
    const hashIdx = target.indexOf('#');
    if (hashIdx !== -1) {
      heading = target.slice(hashIdx + 1);
      target = target.slice(0, hashIdx);
    }

    // Normalize target: trim, lowercase for matching
    target = target.trim();
    display = display.trim();

    if (target) {
      links.push({ raw, target, display, heading });
    }
  }

  return links;
}

/**
 * Extract unique wikilink targets from text.
 * Returns lowercase filenames for consistent matching.
 */
export function extractLinkTargets(text: string): string[] {
  const links = extractWikilinks(text);
  const unique = new Set(links.map(l => l.target.toLowerCase()));
  return [...unique];
}

// === Tags ===

const TAG_RE = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;

/**
 * Extract #tags from markdown body text.
 * Does NOT include tags from frontmatter (those are parsed separately).
 */
export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(text)) !== null) {
    tags.add(match[1].toLowerCase());
  }

  return [...tags];
}
