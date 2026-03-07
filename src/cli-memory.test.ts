/**
 * Tests for `ved memory` CLI module.
 *
 * Tests the memoryCommand function against a real VedApp with temp vault.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { memoryCommand } from './cli-memory.js';
import { VaultManager } from './memory/vault.js';
import { MemoryManager } from './memory/manager.js';
import type { VedApp } from './app.js';

// === Test Helpers ===

function createTestVault(): { vaultPath: string; vault: VaultManager; memory: MemoryManager; cleanup: () => void } {
  const vaultPath = mkdtempSync(join(tmpdir(), 'ved-memory-test-'));
  const vault = new VaultManager(vaultPath, false); // no git
  const memory = new MemoryManager(vault);
  const cleanup = () => rmSync(vaultPath, { recursive: true, force: true });
  return { vaultPath, vault, memory, cleanup };
}

function createMockApp(memory: MemoryManager): VedApp {
  return { memory } as unknown as VedApp;
}

function captureOutput(fn: () => Promise<void>): Promise<string> {
  return new Promise(async (resolve) => {
    const original = console.log;
    let output = '';
    console.log = (...args: unknown[]) => {
      output += args.map(String).join(' ') + '\n';
    };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    resolve(output);
  });
}

function createVaultFile(vaultPath: string, relPath: string, frontmatter: Record<string, unknown>, body: string): void {
  const dir = join(vaultPath, relPath.split('/').slice(0, -1).join('/'));
  mkdirSync(dir, { recursive: true });
  const fmYaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join('\n')}`;
      return `${k}: ${v}`;
    })
    .join('\n');
  const content = `---\n${fmYaml}\n---\n${body}`;
  writeFileSync(join(vaultPath, relPath), content, 'utf-8');
}

// === Tests ===

describe('ved memory', () => {
  let vaultPath: string;
  let vault: VaultManager;
  let memory: MemoryManager;
  let app: VedApp;
  let cleanup: () => void;

  beforeEach(async () => {
    const result = createTestVault();
    vaultPath = result.vaultPath;
    vault = result.vault;
    memory = result.memory;
    cleanup = result.cleanup;
    app = createMockApp(memory);

    // Create some test files
    createVaultFile(vaultPath, 'entities/people/alice.md', {
      type: 'person',
      name: 'Alice Smith',
      confidence: 'high',
      source: 'conversation',
      tags: ['engineer', 'team'],
    }, '# Alice Smith\n\nSenior engineer. Works on [[project-x]].\n');

    createVaultFile(vaultPath, 'entities/people/bob.md', {
      type: 'person',
      name: 'Bob Jones',
      confidence: 'medium',
      source: 'document',
      tags: ['manager'],
    }, '# Bob Jones\n\nProject manager. Leads [[project-x]]. Knows [[alice]].\n');

    createVaultFile(vaultPath, 'concepts/project-x.md', {
      type: 'project',
      name: 'Project X',
      confidence: 'high',
      source: 'conversation',
      tags: ['active', 'priority'],
    }, '# Project X\n\nMain project for Q1. Team: [[alice]], [[bob]].\n');

    createVaultFile(vaultPath, 'decisions/use-typescript.md', {
      type: 'decision',
      name: 'Use TypeScript',
      date: '2026-01-15',
      confidence: 'high',
      source: 'conversation',
      tags: ['tech-stack'],
    }, '# Use TypeScript\n\nDecision: use TypeScript for Ved core.\n\n## Context\n\nNeed type safety for audit system.\n');

    const today = new Date().toISOString().split('T')[0];
    createVaultFile(vaultPath, `daily/${today}.md`, {
      type: 'daily',
      date: today,
    }, `# ${today}\n\n- Worked on memory CLI\n- Fixed 3 bugs\n`);

    // Initialize vault index
    await vault.init();
  });

  afterEach(() => {
    vault.close();
    cleanup();
  });

  // === help ===

  it('should show help with no args', async () => {
    const output = await captureOutput(() => memoryCommand(app, []));
    expect(output).toContain('ved memory');
    expect(output).toContain('list');
    expect(output).toContain('show');
    expect(output).toContain('graph');
    expect(output).toContain('timeline');
    expect(output).toContain('daily');
    expect(output).toContain('forget');
    expect(output).toContain('tags');
    expect(output).toContain('types');
  });

  it('should show help with "help" arg', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['help']));
    expect(output).toContain('ved memory');
  });

  // === list ===

  it('should list all entities', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['list']));
    expect(output).toContain('alice');
    expect(output).toContain('bob');
    expect(output).toContain('project-x');
    expect(output).toContain('use-typescript');
  });

  it('should list entities by type', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['list', '--type', 'person']));
    expect(output).toContain('alice');
    expect(output).toContain('bob');
    expect(output).not.toContain('project-x');
    expect(output).not.toContain('use-typescript');
  });

  it('should list entities by tag', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['list', '--tag', 'active']));
    expect(output).toContain('project-x');
    expect(output).not.toContain('alice');
  });

  it('should list entities by folder', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['list', '--folder', 'decisions']));
    expect(output).toContain('use-typescript');
    expect(output).not.toContain('alice');
  });

  it('should respect limit', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['list', '--limit', '1']));
    expect(output).toContain('1 entit');
  });

  it('should handle empty results', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['list', '--tag', 'nonexistent']));
    expect(output).toContain('No entities found');
  });

  it('should accept ls alias', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['ls']));
    expect(output).toContain('alice');
  });

  // === show ===

  it('should show entity by path', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['show', 'entities/people/alice.md']));
    expect(output).toContain('Alice Smith');
    expect(output).toContain('entities/people/alice.md');
    expect(output).toContain('Frontmatter');
    expect(output).toContain('Content');
    expect(output).toContain('Senior engineer');
  });

  it('should show entity links', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['show', 'entities/people/alice.md']));
    expect(output).toContain('Links');
    expect(output).toContain('[[project-x]]');
  });

  it('should accept cat alias', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['cat', 'entities/people/alice.md']));
    expect(output).toContain('Alice Smith');
  });

  // === graph ===

  it('should show graph connections', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['graph', 'concepts/project-x.md']));
    expect(output).toContain('Graph for');
    expect(output).toContain('project-x');
  });

  it('should accept depth flag', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['graph', 'concepts/project-x.md', '--depth', '2']));
    expect(output).toContain('depth 2');
  });

  it('should handle no connections', async () => {
    // Create isolated file
    createVaultFile(vaultPath, 'concepts/isolated.md', {
      type: 'concept',
      name: 'Isolated',
    }, '# Isolated\n\nNo links here.\n');
    await vault.rebuildIndex();

    const output = await captureOutput(() => memoryCommand(app, ['graph', 'concepts/isolated.md']));
    // It should still show the origin node at minimum
    expect(output).toContain('isolated');
  });

  // === timeline ===

  it('should show recent activity', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['timeline']));
    expect(output).toContain('Timeline');
    // All our test files were just created, so they should appear
    expect(output).toContain('alice');
  });

  it('should accept days flag', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['timeline', '--days', '1']));
    expect(output).toContain('1 day');
  });

  it('should accept limit flag', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['timeline', '--limit', '2']));
    expect(output).toContain('2 of');
  });

  it('should accept recent alias', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['recent']));
    expect(output).toContain('Timeline');
  });

  // === daily ===

  it('should show today daily note', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['daily']));
    expect(output).toContain('Daily Note');
    expect(output).toContain('memory CLI');
  });

  it('should handle missing daily note for past date', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['daily', '--date', '2020-01-01']));
    expect(output).toContain('No daily note found');
  });

  it('should accept today alias', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['today']));
    expect(output).toContain('Daily Note');
  });

  // === forget ===

  it('should archive entity on forget', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['forget', 'decisions/use-typescript.md', '--reason', 'obsolete']));
    expect(output).toContain('Forgotten');
    expect(output).toContain('Archived to');
    expect(output).toContain('obsolete');

    // Original should be gone
    expect(vault.exists('decisions/use-typescript.md')).toBe(false);

    // Archive should exist
    const archiveFiles = vault.listFiles('_archive');
    expect(archiveFiles.length).toBeGreaterThan(0);
    const archiveFile = vault.readFile(archiveFiles[0]);
    expect(archiveFile.frontmatter.archived).toBe(true);
    expect(archiveFile.frontmatter.archiveReason).toBe('obsolete');
  });

  it('should use default reason when none provided', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['forget', 'decisions/use-typescript.md']));
    expect(output).toContain('manual forget via CLI');
  });

  it('should accept archive alias', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['archive', 'concepts/project-x.md']));
    expect(output).toContain('Forgotten');
  });

  // === tags ===

  it('should list all tags with counts', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['tags']));
    expect(output).toContain('Tags');
    expect(output).toContain('#engineer');
    expect(output).toContain('#manager');
    expect(output).toContain('#active');
  });

  // === types ===

  it('should list all entity types with counts', async () => {
    const output = await captureOutput(() => memoryCommand(app, ['types']));
    expect(output).toContain('Entity Types');
    expect(output).toContain('person');
    expect(output).toContain('project');
    expect(output).toContain('decision');
  });

  // === error cases ===

  it('should error on show without target', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    try {
      await memoryCommand(app, ['show']);
    } catch {
      // expected
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('should error on show with nonexistent entity', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    try {
      await memoryCommand(app, ['show', 'nonexistent.md']);
    } catch {
      // expected
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('should error on graph without target', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    try {
      await memoryCommand(app, ['graph']);
    } catch {
      // expected
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('should error on forget without target', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    try {
      await memoryCommand(app, ['forget']);
    } catch {
      // expected
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('should error on forget with nonexistent entity', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    try {
      await memoryCommand(app, ['forget', 'nonexistent.md']);
    } catch {
      // expected
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  // === edge cases ===

  it('should handle entity with no frontmatter gracefully', async () => {
    const bareFile = join(vaultPath, 'concepts', 'bare.md');
    mkdirSync(join(vaultPath, 'concepts'), { recursive: true });
    writeFileSync(bareFile, '# Bare File\n\nJust markdown, no frontmatter.\n', 'utf-8');
    await vault.rebuildIndex();

    const output = await captureOutput(() => memoryCommand(app, ['show', 'concepts/bare.md']));
    expect(output).toContain('bare.md');
    expect(output).toContain('Just markdown');
  });

  it('should handle entity with empty body', async () => {
    createVaultFile(vaultPath, 'concepts/empty-body.md', {
      type: 'concept',
      name: 'Empty',
    }, '');
    await vault.rebuildIndex();

    const output = await captureOutput(() => memoryCommand(app, ['show', 'concepts/empty-body.md']));
    expect(output).toContain('Empty');
    expect(output).toContain('Content');
  });

  it('should handle timeline with zero results', async () => {
    // Create a vault with old files only
    const oldVault = mkdtempSync(join(tmpdir(), 'ved-old-'));
    const v3 = new VaultManager(oldVault, false);
    const m3 = new MemoryManager(v3);
    const a3 = createMockApp(m3);
    await v3.init();

    // Empty vault → no recent changes
    const output = await captureOutput(() => memoryCommand(a3, ['timeline', '--days', '7']));
    expect(output).toContain('No changes');

    v3.close();
    rmSync(oldVault, { recursive: true, force: true });
  });

  it('should handle tags with empty vault', async () => {
    // Create fresh empty vault
    const emptyVault = mkdtempSync(join(tmpdir(), 'ved-empty-'));
    const v2 = new VaultManager(emptyVault, false);
    const m2 = new MemoryManager(v2);
    const a2 = createMockApp(m2);
    await v2.init();

    const output = await captureOutput(() => memoryCommand(a2, ['tags']));
    expect(output).toContain('No tags');

    v2.close();
    rmSync(emptyVault, { recursive: true, force: true });
  });

  it('should handle types with empty vault', async () => {
    const emptyVault = mkdtempSync(join(tmpdir(), 'ved-empty-'));
    const v2 = new VaultManager(emptyVault, false);
    const m2 = new MemoryManager(v2);
    const a2 = createMockApp(m2);
    await v2.init();

    const output = await captureOutput(() => memoryCommand(a2, ['types']));
    expect(output).toContain('No entity types');

    v2.close();
    rmSync(emptyVault, { recursive: true, force: true });
  });
});
