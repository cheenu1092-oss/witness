/**
 * Chunker — Heading-based Markdown chunking with frontmatter prefix.
 *
 * Strategy:
 * 1. Parse YAML frontmatter → compact one-liner prefix
 * 2. Split body by H2 (##), fallback to H3 (###), fallback whole body
 * 3. Each chunk = frontmatter prefix + heading section
 * 4. Chunks exceeding maxTokens split at paragraph boundaries
 * 5. Chunks below minTokens merged with next
 */

import type { VaultFile, ChunkConfig } from '../types/index.js';
import type { ChunkResult } from './types.js';

/**
 * Estimate token count from text (heuristic: ~3.5 chars per token for Markdown).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Create compact frontmatter prefix string.
 * e.g. "[person, colleague] Bob Friday"
 */
function makeFrontmatterPrefix(fm: Record<string, unknown>): string {
  const parts: string[] = [];

  // Tags
  const tags = fm['tags'];
  if (Array.isArray(tags) && tags.length > 0) {
    parts.push(`[${tags.join(', ')}]`);
  }

  // Title or name
  const title = fm['title'] ?? fm['name'];
  if (typeof title === 'string') {
    parts.push(title);
  }

  // Type
  const type = fm['type'];
  if (typeof type === 'string' && !parts.some(p => p.includes(type))) {
    parts.push(`(${type})`);
  }

  return parts.join(' ');
}

interface HeadingSection {
  heading: string | null;
  headingLevel: number;
  body: string;
}

/**
 * Split Markdown body by headings.
 * Tries H2 first, then H3, then whole body as one section.
 */
function splitByHeadings(body: string): HeadingSection[] {
  // Try H2 splits
  const h2Regex = /^(## .+)$/gm;
  let sections = splitAtPattern(body, h2Regex, 2);
  if (sections.length > 1) return sections;

  // Try H3 splits
  const h3Regex = /^(### .+)$/gm;
  sections = splitAtPattern(body, h3Regex, 3);
  if (sections.length > 1) return sections;

  // Whole body as one section
  return [{
    heading: null,
    headingLevel: 0,
    body: body.trim(),
  }];
}

function splitAtPattern(text: string, pattern: RegExp, level: number): HeadingSection[] {
  const sections: HeadingSection[] = [];
  const matches = [...text.matchAll(pattern)];

  if (matches.length === 0) {
    return [{ heading: null, headingLevel: 0, body: text.trim() }];
  }

  // Content before first heading (preamble)
  const firstIdx = matches[0].index!;
  if (firstIdx > 0) {
    const preamble = text.slice(0, firstIdx).trim();
    if (preamble) {
      sections.push({ heading: null, headingLevel: 0, body: preamble });
    }
  }

  // Each heading section
  for (let i = 0; i < matches.length; i++) {
    const matchStart = matches[i].index!;
    const matchEnd = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const heading = matches[i][1].replace(/^#+\s*/, '').trim();
    const body = text.slice(matchStart + matches[i][0].length, matchEnd).trim();

    sections.push({ heading, headingLevel: level, body });
  }

  return sections;
}

/**
 * Split a chunk by paragraph boundaries when it exceeds maxTokens.
 */
function splitByParagraphs(text: string, maxTokens: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const result: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const combined = current ? `${current}\n\n${para}` : para;
    if (estimateTokens(combined) > maxTokens && current) {
      result.push(current.trim());
      current = para;
    } else {
      current = combined;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/**
 * Chunk a vault file into embeddable pieces.
 */
export function chunkFile(file: VaultFile, config: ChunkConfig): ChunkResult[] {
  const prefix = config.frontmatterPrefix
    ? makeFrontmatterPrefix(file.frontmatter)
    : '';

  const sections = splitByHeadings(file.body);
  const raw: ChunkResult[] = [];

  for (const section of sections) {
    const headingLine = section.heading
      ? `${prefix ? prefix + ' | ' : ''}${section.heading}: `
      : prefix ? `${prefix}: ` : '';

    const content = headingLine + section.body;
    const tokens = estimateTokens(content);

    if (tokens > config.maxTokens) {
      // Split at paragraphs
      const subTexts = splitByParagraphs(section.body, config.maxTokens - estimateTokens(headingLine));
      for (const sub of subTexts) {
        const subContent = headingLine + sub;
        raw.push({
          heading: section.heading,
          headingLevel: section.headingLevel,
          content: subContent,
          tokenCount: estimateTokens(subContent),
          chunkIndex: 0, // assigned below
        });
      }
    } else {
      raw.push({
        heading: section.heading,
        headingLevel: section.headingLevel,
        content,
        tokenCount: tokens,
        chunkIndex: 0,
      });
    }
  }

  // Merge small chunks with next
  const merged: ChunkResult[] = [];
  let pending: ChunkResult | null = null;

  for (const chunk of raw) {
    if (pending) {
      const combined: string = `${pending.content}\n\n${chunk.content}`;
      const combinedTokens = estimateTokens(combined);

      if (pending.tokenCount < config.minTokens && combinedTokens <= config.maxTokens) {
        pending = {
          heading: pending.heading ?? chunk.heading,
          headingLevel: pending.headingLevel || chunk.headingLevel,
          content: combined,
          tokenCount: combinedTokens,
          chunkIndex: 0,
        };
        continue;
      } else {
        merged.push(pending);
        pending = chunk;
      }
    } else {
      pending = chunk;
    }
  }
  if (pending) merged.push(pending);

  // Assign chunk indices
  return merged.map((c, i) => ({ ...c, chunkIndex: i }));
}
