/**
 * VaultGit — Git integration for the Obsidian vault.
 *
 * Batched auto-commits at natural boundaries (session compression,
 * entity extraction, shutdown, periodic timer). Not on every file write.
 *
 * Commit messages follow: "ved: <action> — <summary>"
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: Date;
}

/**
 * Git operations for the vault directory.
 * All operations are synchronous (simple-sqlite3 pattern — single-threaded).
 */
export class VaultGit {
  private vaultPath: string;
  private dirty: Set<string> = new Set();
  private enabled: boolean;

  constructor(vaultPath: string, enabled = true) {
    this.vaultPath = vaultPath;
    this.enabled = enabled;
  }

  /** Initialize git repo if not already one. */
  init(): void {
    if (!this.enabled) return;
    const gitDir = join(this.vaultPath, '.git');
    if (existsSync(gitDir)) return;

    this.git(['init']);
    // Create .gitignore for Obsidian workspace files
    const gitignore = join(this.vaultPath, '.gitignore');
    if (!existsSync(gitignore)) {
      const ignoreContent = [
        '.obsidian/workspace.json',
        '.obsidian/workspace-mobile.json',
        '.obsidian/cache',
        '.trash/',
        '',
      ].join('\n');
      writeFileSync(gitignore, ignoreContent, 'utf-8');
      this.git(['add', '.gitignore']);
      this.git(['commit', '-m', 'ved: init — vault created']);
    }
  }

  /** Stage specific files. */
  stage(paths: string[]): void {
    if (!this.enabled || paths.length === 0) return;
    // Stage relative to vault root
    this.git(['add', ...paths]);
  }

  /** Commit staged changes with a message. */
  commit(message: string): void {
    if (!this.enabled) return;
    // Check if there's anything staged
    try {
      const status = this.git(['diff', '--cached', '--name-only']);
      if (!status.trim()) return; // nothing staged
    } catch {
      return;
    }
    this.git(['commit', '-m', message, '--allow-empty-message']);
  }

  /** Check if working tree is clean (no modified/untracked files). */
  isClean(): boolean {
    if (!this.enabled) return true;
    try {
      const status = this.git(['status', '--porcelain']);
      return status.trim() === '';
    } catch {
      return true;
    }
  }

  /** Get recent commit log. */
  log(limit = 10): GitLogEntry[] {
    if (!this.enabled) return [];
    try {
      const raw = this.git([
        'log',
        `--max-count=${limit}`,
        '--format=%H|%s|%an|%aI',
      ]);
      return raw
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          const [hash, message, author, dateStr] = line.split('|');
          return { hash, message, author, date: new Date(dateStr) };
        });
    } catch {
      return [];
    }
  }

  /** Get diff for a specific file. */
  diff(path: string): string {
    if (!this.enabled) return '';
    try {
      return this.git(['diff', '--', path]);
    } catch {
      return '';
    }
  }

  /** Mark a file as dirty (to be committed in next flush). */
  markDirty(path: string): void {
    this.dirty.add(path);
  }

  /** Flush all dirty files: stage + commit. */
  flush(message?: string): void {
    if (!this.enabled || this.dirty.size === 0) return;
    const paths = [...this.dirty];
    this.stage(paths);
    this.commit(message ?? `ved: auto-commit — ${paths.length} file(s) updated`);
    this.dirty.clear();
  }

  /** Get count of dirty (uncommitted) files. */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** Check if this directory has a git repo. */
  get isRepo(): boolean {
    return existsSync(join(this.vaultPath, '.git'));
  }

  // === Internal ===

  private git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.vaultPath,
      encoding: 'utf-8',
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Ved',
        GIT_AUTHOR_EMAIL: 'ved@local',
        GIT_COMMITTER_NAME: 'Ved',
        GIT_COMMITTER_EMAIL: 'ved@local',
      },
    });
  }
}
