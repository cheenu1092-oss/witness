import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VaultManager } from './vault.js';

describe('VaultManager', () => {
  let vaultPath: string;
  let vault: VaultManager;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'ved-vault-test-'));
    vault = new VaultManager(vaultPath, false); // git disabled for tests
    await vault.init();
  });

  afterEach(() => {
    vault.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  // === init ===

  it('creates vault directory structure', async () => {
    expect(existsSync(join(vaultPath, 'daily'))).toBe(true);
    expect(existsSync(join(vaultPath, 'entities/people'))).toBe(true);
    expect(existsSync(join(vaultPath, 'entities/orgs'))).toBe(true);
    expect(existsSync(join(vaultPath, 'projects'))).toBe(true);
    expect(existsSync(join(vaultPath, 'concepts'))).toBe(true);
    expect(existsSync(join(vaultPath, 'decisions'))).toBe(true);
    expect(existsSync(join(vaultPath, 'topics'))).toBe(true);
    expect(existsSync(join(vaultPath, 'templates'))).toBe(true);
  });

  // === createFile / readFile ===

  it('creates and reads a file', () => {
    vault.createFile('entities/people/bob.md', { type: 'person', tags: ['person'] }, '# Bob\n\nA person.');
    const file = vault.readFile('entities/people/bob.md');
    expect(file.frontmatter.type).toBe('person');
    expect(file.body).toContain('# Bob');
    expect(file.path).toBe('entities/people/bob.md');
  });

  it('throws for nonexistent file', () => {
    expect(() => vault.readFile('nonexistent.md')).toThrow('not found');
  });

  it('exists returns true for existing file', () => {
    vault.createFile('test.md', {}, 'test');
    expect(vault.exists('test.md')).toBe(true);
  });

  it('exists returns false for missing file', () => {
    expect(vault.exists('nope.md')).toBe(false);
  });

  // === updateFile ===

  it('updates file body', () => {
    vault.createFile('test.md', { type: 'concept' }, '# Old');
    vault.updateFile('test.md', { body: '# New' });
    const file = vault.readFile('test.md');
    expect(file.body).toContain('# New');
  });

  it('merges frontmatter by default', () => {
    vault.createFile('test.md', { type: 'concept', confidence: 'low' }, 'body');
    vault.updateFile('test.md', { frontmatter: { confidence: 'high', source: 'manual' } });
    const file = vault.readFile('test.md');
    expect(file.frontmatter.type).toBe('concept');
    expect(file.frontmatter.confidence).toBe('high');
    expect(file.frontmatter.source).toBe('manual');
  });

  it('appends to body', () => {
    vault.createFile('test.md', {}, '# Title');
    vault.updateFile('test.md', { appendBody: '## New Section\nContent.' });
    const file = vault.readFile('test.md');
    expect(file.body).toContain('# Title');
    expect(file.body).toContain('## New Section');
  });

  // === appendToFile ===

  it('appends to existing file', () => {
    vault.createFile('daily/2026-03-05.md', { type: 'daily' }, '# 2026-03-05');
    vault.appendToFile('daily/2026-03-05.md', '## Session 1\nDid things.');
    const file = vault.readFile('daily/2026-03-05.md');
    expect(file.body).toContain('# 2026-03-05');
    expect(file.body).toContain('## Session 1');
  });

  it('creates file if not exists when appending', () => {
    vault.appendToFile('daily/2026-03-06.md', '## First session');
    expect(vault.exists('daily/2026-03-06.md')).toBe(true);
    const file = vault.readFile('daily/2026-03-06.md');
    expect(file.body).toContain('## First session');
  });

  // === deleteFile ===

  it('deletes a file', () => {
    vault.createFile('test.md', {}, 'temp');
    vault.deleteFile('test.md');
    expect(vault.exists('test.md')).toBe(false);
  });

  it('does not throw for missing file on delete', () => {
    expect(() => vault.deleteFile('nonexistent.md')).not.toThrow();
  });

  // === renameFile ===

  it('renames a file', () => {
    vault.createFile('entities/people/old-name.md', { type: 'person' }, '# Old');
    vault.renameFile('entities/people/old-name.md', 'entities/people/new-name.md');
    expect(vault.exists('entities/people/old-name.md')).toBe(false);
    expect(vault.exists('entities/people/new-name.md')).toBe(true);
  });

  // === listFiles ===

  it('lists files in a folder', () => {
    vault.createFile('entities/people/alice.md', {}, '# Alice');
    vault.createFile('entities/people/bob.md', {}, '# Bob');
    const files = vault.listFiles('entities/people');
    expect(files).toHaveLength(2);
    expect(files).toContain('entities/people/alice.md');
    expect(files).toContain('entities/people/bob.md');
  });

  it('returns empty for missing folder', () => {
    expect(vault.listFiles('nonexistent')).toEqual([]);
  });

  // === Index: resolveLink ===

  it('resolves wikilink to file path', () => {
    vault.createFile('entities/people/bob-friday.md', { type: 'person' }, '# Bob');
    const resolved = vault.resolveLink('bob-friday');
    expect(resolved).toBe('entities/people/bob-friday.md');
  });

  it('returns null for unresolvable link', () => {
    expect(vault.resolveLink('nonexistent')).toBeNull();
  });

  // === Index: backlinks ===

  it('tracks backlinks from wikilinks', () => {
    vault.createFile('entities/people/bob.md', { type: 'person' }, '# Bob\nWorks at [[acme]].');
    vault.createFile('entities/orgs/acme.md', { type: 'org' }, '# Acme');
    const backlinks = vault.getBacklinks('acme');
    expect(backlinks).toContain('bob');
  });

  it('returns empty array for no backlinks', () => {
    vault.createFile('test.md', {}, 'No links here');
    expect(vault.getBacklinks('test')).toEqual([]);
  });

  // === Index: findByTag ===

  it('finds files by tag', () => {
    vault.createFile('a.md', { tags: ['person'] }, 'A');
    vault.createFile('b.md', { tags: ['person', 'tribe'] }, 'B');
    vault.createFile('c.md', { tags: ['project'] }, 'C');
    const results = vault.findByTag('person');
    expect(results).toHaveLength(2);
  });

  // === Index: findByType ===

  it('finds files by type', () => {
    vault.createFile('entities/people/x.md', { type: 'person' }, 'X');
    vault.createFile('projects/y.md', { type: 'project' }, 'Y');
    const people = vault.findByType('person');
    expect(people).toHaveLength(1);
    expect(people[0]).toContain('x.md');
  });

  // === Index: findByFrontmatter ===

  it('finds files by frontmatter key/value', () => {
    vault.createFile('a.md', { type: 'project', status: 'active' }, 'A');
    vault.createFile('b.md', { type: 'project', status: 'completed' }, 'B');
    const active = vault.findByFrontmatter('status', 'active');
    expect(active).toHaveLength(1);
  });

  // === Graph: walkGraph ===

  it('walks single-depth graph', () => {
    vault.createFile('entities/people/alice.md', { type: 'person' },
      '# Alice\nWorks at [[acme]].');
    vault.createFile('entities/orgs/acme.md', { type: 'org' },
      '# Acme\nEmployees include [[alice]].');

    const nodes = vault.walkGraph({
      startFiles: ['alice'],
      maxDepth: 1,
      maxNodes: 10,
      maxTokens: 10000,
    });

    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].path).toContain('alice.md');
  });

  it('respects maxDepth', () => {
    vault.createFile('entities/people/a.md', {}, '[[b]]');
    vault.createFile('entities/people/b.md', {}, '[[c]]');
    vault.createFile('entities/people/c.md', {}, '[[d]]');
    vault.createFile('entities/people/d.md', {}, 'end');

    const nodes = vault.walkGraph({
      startFiles: ['a'],
      maxDepth: 1,
      maxNodes: 10,
      maxTokens: 10000,
    });

    // Should get a (depth 0) and b (depth 1), but not c or d
    const paths = nodes.map(n => n.path);
    expect(paths).toContain('entities/people/a.md');
    expect(paths).toContain('entities/people/b.md');
    expect(paths).not.toContain('entities/people/c.md');
  });

  it('respects maxNodes', () => {
    for (let i = 0; i < 10; i++) {
      vault.createFile(`concepts/c${i}.md`, {}, `Content ${i} [[c${i + 1}]]`);
    }

    const nodes = vault.walkGraph({
      startFiles: ['c0'],
      maxDepth: 10,
      maxNodes: 3,
      maxTokens: 100000,
    });

    expect(nodes.length).toBeLessThanOrEqual(3);
  });

  // === getIndex ===

  it('returns complete index', () => {
    vault.createFile('entities/people/test.md', { type: 'person', tags: ['person'] }, '[[project]]');
    const index = vault.getIndex();
    expect(index.files.has('test')).toBe(true);
    expect(index.types.has('person')).toBe(true);
    expect(index.tags.has('person')).toBe(true);
  });

  // === rebuildIndex ===

  it('rebuilds index from scratch', async () => {
    vault.createFile('test1.md', { type: 'concept' }, 'Test 1');
    vault.createFile('test2.md', { type: 'concept' }, 'Test 2');

    await vault.rebuildIndex();
    const index = vault.getIndex();
    expect(index.files.size).toBeGreaterThanOrEqual(2);
  });

  // === file-changed events ===

  it('emits file-changed on create', () => {
    const changes: Array<{ path: string; type: string }> = [];
    vault.onFileChanged((path, type) => changes.push({ path, type }));
    vault.createFile('test.md', {}, 'content');
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('create');
  });

  it('emits file-changed on update', () => {
    vault.createFile('test.md', {}, 'old');
    const changes: Array<{ path: string; type: string }> = [];
    vault.onFileChanged((path, type) => changes.push({ path, type }));
    vault.updateFile('test.md', { body: 'new' });
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('update');
  });

  it('emits file-changed on delete', () => {
    vault.createFile('test.md', {}, 'content');
    const changes: Array<{ path: string; type: string }> = [];
    vault.onFileChanged((path, type) => changes.push({ path, type }));
    vault.deleteFile('test.md');
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('delete');
  });
});
