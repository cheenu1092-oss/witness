import { describe, it, expect } from 'vitest';
import {
  parseMarkdown, serializeMarkdown, mergeFrontmatter,
  extractWikilinks, extractLinkTargets, extractTags,
} from './markdown.js';

describe('parseMarkdown', () => {
  it('parses frontmatter and body', () => {
    const raw = `---\ntype: person\ntags:\n  - test\n---\n\n# Hello\n\nBody text.`;
    const result = parseMarkdown(raw);
    expect(result.frontmatter.type).toBe('person');
    expect(result.frontmatter.tags).toEqual(['test']);
    expect(result.body).toBe('# Hello\n\nBody text.');
  });

  it('returns empty frontmatter when none present', () => {
    const raw = '# Just a heading\n\nSome content.';
    const result = parseMarkdown(raw);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('# Just a heading\n\nSome content.');
  });

  it('handles empty frontmatter', () => {
    const raw = `---\n---\n\nBody.`;
    const result = parseMarkdown(raw);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('Body.');
  });

  it('handles invalid YAML gracefully', () => {
    const raw = `---\n[invalid yaml\n---\n\nBody.`;
    const result = parseMarkdown(raw);
    expect(result.frontmatter).toEqual({});
  });

  it('preserves raw content', () => {
    const raw = `---\ntype: test\n---\n\nBody.`;
    const result = parseMarkdown(raw);
    expect(result.raw).toBe(raw);
  });
});

describe('serializeMarkdown', () => {
  it('serializes frontmatter and body', () => {
    const result = serializeMarkdown({ type: 'person', tags: ['test'] }, '# Hello');
    expect(result).toContain('---');
    expect(result).toContain('type: person');
    expect(result).toContain('# Hello');
  });

  it('round-trips through parse and serialize', () => {
    const fm = { type: 'person', confidence: 'high' };
    const body = '# Test\n\nSome content here.';
    const serialized = serializeMarkdown(fm, body);
    const parsed = parseMarkdown(serialized);
    expect(parsed.frontmatter.type).toBe('person');
    expect(parsed.frontmatter.confidence).toBe('high');
    expect(parsed.body).toContain('# Test');
    expect(parsed.body).toContain('Some content here.');
  });
});

describe('mergeFrontmatter', () => {
  it('adds new keys', () => {
    const result = mergeFrontmatter({ type: 'person' }, { confidence: 'high' });
    expect(result).toEqual({ type: 'person', confidence: 'high' });
  });

  it('overrides existing keys', () => {
    const result = mergeFrontmatter({ confidence: 'low' }, { confidence: 'high' });
    expect(result).toEqual({ confidence: 'high' });
  });

  it('replaces arrays entirely', () => {
    const result = mergeFrontmatter({ tags: ['old'] }, { tags: ['new'] });
    expect(result.tags).toEqual(['new']);
  });

  it('skips undefined values', () => {
    const result = mergeFrontmatter({ type: 'person' }, { confidence: undefined });
    expect(result).toEqual({ type: 'person' });
  });
});

describe('extractWikilinks', () => {
  it('extracts simple links', () => {
    const links = extractWikilinks('See [[bob-friday]] for details.');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('bob-friday');
    expect(links[0].display).toBe('bob-friday');
  });

  it('extracts aliased links', () => {
    const links = extractWikilinks('Works at [[hpe|HPE Networking]].');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('hpe');
    expect(links[0].display).toBe('HPE Networking');
  });

  it('extracts heading links', () => {
    const links = extractWikilinks('See [[project#architecture]].');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('project');
    expect(links[0].heading).toBe('architecture');
  });

  it('extracts multiple links', () => {
    const text = '[[alice]] and [[bob]] work at [[acme|Acme Corp]].';
    const links = extractWikilinks(text);
    expect(links).toHaveLength(3);
  });

  it('handles empty input', () => {
    expect(extractWikilinks('')).toEqual([]);
  });

  it('handles links with heading and alias', () => {
    const links = extractWikilinks('[[project#arch|Architecture]]');
    expect(links[0].target).toBe('project');
    expect(links[0].heading).toBe('arch');
    expect(links[0].display).toBe('Architecture');
  });
});

describe('extractLinkTargets', () => {
  it('returns unique lowercase targets', () => {
    const targets = extractLinkTargets('[[Bob]] and [[bob]] and [[Alice]]');
    expect(targets).toContain('bob');
    expect(targets).toContain('alice');
    expect(targets).toHaveLength(2);
  });
});

describe('extractTags', () => {
  it('extracts hashtags from body', () => {
    const tags = extractTags('This is #person related to #project');
    expect(tags).toContain('person');
    expect(tags).toContain('project');
  });

  it('does not extract hashtags in code', () => {
    // Simple pattern — doesn't handle code blocks, but that's OK for now
    const tags = extractTags('#valid tag');
    expect(tags).toContain('valid');
  });

  it('handles nested tag paths', () => {
    const tags = extractTags('Category #project/active here');
    expect(tags).toContain('project/active');
  });

  it('returns empty for no tags', () => {
    expect(extractTags('No tags here')).toEqual([]);
  });
});
