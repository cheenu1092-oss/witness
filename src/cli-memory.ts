/**
 * `ved memory` — CLI for browsing, searching, and managing the Obsidian knowledge graph.
 *
 * Subcommands:
 *   list [--type <type>] [--tag <tag>] [--folder <folder>] [--limit N]
 *   show <path|filename>
 *   graph <path|filename> [--depth N]
 *   timeline [--days N] [--limit N]
 *   daily [--date YYYY-MM-DD]
 *   forget <path> [--reason <reason>]
 *   tags
 *   types
 */

import type { VedApp } from './app.js';
import type { VaultFile, VaultEntityType } from './types/index.js';

// === Helpers ===

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

function formatDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function renderFrontmatter(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(', ') : String(v);
      return `  ${k}: ${val}`;
    })
    .join('\n');
}

// === Subcommands ===

async function list(app: VedApp, args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const type = flags.type as VaultEntityType | undefined;
  const tag = flags.tag;
  const folder = flags.folder;
  const limit = flags.limit ? parseInt(flags.limit, 10) : 50;

  const files = app.memory.queryEntities({
    type,
    tags: tag ? [tag] : undefined,
    folder,
    limit,
  });

  if (files.length === 0) {
    console.log('\n  No entities found.\n');
    return;
  }

  console.log(`\n  Found ${files.length} entit${files.length === 1 ? 'y' : 'ies'}:\n`);

  // Table header
  const rows: string[][] = [['Path', 'Type', 'Name', 'Modified', 'Size']];

  for (const f of files) {
    const name = String(f.frontmatter.name || f.frontmatter.title || '—');
    const fType = String(f.frontmatter.type || '—');
    const modified = formatDate(f.stats.modified);
    const size = formatSize(f.stats.size);
    rows.push([f.path, fType, truncate(name, 30), modified, size]);
  }

  // Calculate column widths
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map(r => r[col].length)),
  );

  // Print
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].map((cell, col) => cell.padEnd(widths[col])).join('  ');
    if (i === 0) {
      console.log(`  ${line}`);
      console.log(`  ${widths.map(w => '─'.repeat(w)).join('──')}`);
    } else {
      console.log(`  ${line}`);
    }
  }

  console.log('');
}

async function show(app: VedApp, args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const target = positional[0];

  if (!target) {
    console.error('Usage: ved memory show <path|filename>');
    process.exit(1);
  }

  const file = app.memory.readEntity(target);
  if (!file) {
    console.error(`Entity not found: ${target}`);
    process.exit(1);
  }

  console.log(`\n  📄 ${file.path}`);
  console.log(`  Modified: ${formatDate(file.stats.modified)}  Size: ${formatSize(file.stats.size)}`);

  if (Object.keys(file.frontmatter).length > 0) {
    console.log(`\n  ─── Frontmatter ───`);
    console.log(renderFrontmatter(file.frontmatter));
  }

  if (file.links.length > 0) {
    console.log(`\n  ─── Links (${file.links.length}) ───`);
    console.log(`  ${file.links.map(l => `[[${l}]]`).join(' ')}`);
  }

  console.log(`\n  ─── Content ───`);
  console.log(file.body.trim());
  console.log('');
}

async function graph(app: VedApp, args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const target = positional[0];
  const maxDepth = flags.depth ? parseInt(flags.depth, 10) : 1;

  if (!target) {
    console.error('Usage: ved memory graph <path|filename> [--depth N]');
    process.exit(1);
  }

  // Resolve the target to a path
  const file = app.memory.readEntity(target);
  if (!file) {
    console.error(`Entity not found: ${target}`);
    process.exit(1);
  }

  // Walk the graph from this file
  const nodes = app.memory.vault.walkGraph({
    startFiles: [file.path],
    maxDepth,
    maxNodes: 50,
    maxTokens: 100_000,
  });

  if (nodes.length === 0) {
    console.log(`\n  No graph connections found for: ${file.path}\n`);
    return;
  }

  console.log(`\n  🕸️  Graph for ${file.path} (depth ${maxDepth}):\n`);

  // Group by depth
  const byDepth = new Map<number, typeof nodes>();
  for (const node of nodes) {
    const existing = byDepth.get(node.depth) || [];
    existing.push(node);
    byDepth.set(node.depth, existing);
  }

  for (const [depth, depthNodes] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const indent = '  '.repeat(depth + 1);
    const label = depth === 0 ? '📍 Origin' : `↳ Depth ${depth}`;
    console.log(`${indent}${label}:`);

    for (const node of depthNodes) {
      const name = node.frontmatter.name || node.frontmatter.title || node.path;
      const linkCount = node.links.length;
      const backlinkCount = node.backlinks.length;
      console.log(`${indent}  • ${name}  (${linkCount} out, ${backlinkCount} in)  ${node.path}`);
    }
  }

  console.log('');
}

async function timeline(app: VedApp, args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const days = flags.days ? parseInt(flags.days, 10) : 7;
  const limit = flags.limit ? parseInt(flags.limit, 10) : 30;

  // Get all files and sort by modification time
  const index = app.memory.vault.getIndex();
  const allPaths = [...index.files.values()];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const recentFiles: VaultFile[] = [];

  for (const path of allPaths) {
    try {
      const file = app.memory.vault.readFile(path);
      if (file.stats.modified >= cutoff) {
        recentFiles.push(file);
      }
    } catch {
      // skip unreadable files
    }
  }

  // Sort by modified desc
  recentFiles.sort((a, b) => b.stats.modified.getTime() - a.stats.modified.getTime());

  // Apply limit
  const displayed = recentFiles.slice(0, limit);

  if (displayed.length === 0) {
    console.log(`\n  No changes in the last ${days} day(s).\n`);
    return;
  }

  console.log(`\n  📅 Timeline — last ${days} day(s) (${displayed.length} of ${recentFiles.length} files):\n`);

  let lastDate = '';
  for (const f of displayed) {
    const dateStr = f.stats.modified.toISOString().split('T')[0];
    if (dateStr !== lastDate) {
      if (lastDate) console.log('');
      console.log(`  ── ${dateStr} ──`);
      lastDate = dateStr;
    }

    const time = f.stats.modified.toTimeString().split(' ')[0];
    const fType = String(f.frontmatter.type || '—');
    const name = String(f.frontmatter.name || f.frontmatter.title || f.path);
    console.log(`    ${time}  [${fType.padEnd(8)}]  ${truncate(name, 40)}  (${f.path})`);
  }

  console.log('');
}

async function daily(app: VedApp, args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const dateStr = flags.date || new Date().toISOString().split('T')[0];

  const path = `daily/${dateStr}.md`;

  if (!app.memory.vault.exists(path)) {
    if (!flags.date) {
      // Create today's note
      const note = app.memory.getTodayNote();
      console.log(`\n  📅 Daily note created: ${note.path}\n`);
      console.log(note.body.trim());
    } else {
      console.log(`\n  No daily note found for ${dateStr}.\n`);
    }
    return;
  }

  const file = app.memory.vault.readFile(path);
  console.log(`\n  📅 Daily Note: ${dateStr}\n`);

  if (Object.keys(file.frontmatter).length > 0) {
    console.log(`  ─── Frontmatter ───`);
    console.log(renderFrontmatter(file.frontmatter));
    console.log('');
  }

  console.log(file.body.trim());
  console.log('');
}

async function forget(app: VedApp, args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const target = positional[0];
  const reason = flags.reason || 'manual forget via CLI';

  if (!target) {
    console.error('Usage: ved memory forget <path> [--reason <reason>]');
    process.exit(1);
  }

  const file = app.memory.readEntity(target);
  if (!file) {
    console.error(`Entity not found: ${target}`);
    process.exit(1);
  }

  // Archive: move to _archive/ with timestamp prefix
  const archivePath = `_archive/${Date.now()}_${file.path.replace(/\//g, '_')}`;

  // Create archive copy
  app.memory.vault.createFile(archivePath, {
    ...file.frontmatter,
    archived: true,
    archivedAt: new Date().toISOString(),
    archivedFrom: file.path,
    archiveReason: reason,
  }, file.body);

  // Delete original
  app.memory.deleteEntity(file.path);

  console.log(`\n  🗑️  Forgotten: ${file.path}`);
  console.log(`  📦 Archived to: ${archivePath}`);
  console.log(`  📝 Reason: ${reason}`);
  console.log('');
}

async function tags(app: VedApp): Promise<void> {
  const index = app.memory.vault.getIndex();

  if (index.tags.size === 0) {
    console.log('\n  No tags found.\n');
    return;
  }

  console.log(`\n  🏷️  Tags (${index.tags.size}):\n`);

  const sorted = [...index.tags.entries()]
    .sort((a, b) => b[1].size - a[1].size);

  for (const [tag, files] of sorted) {
    console.log(`    #${tag.padEnd(25)} ${files.size} file${files.size === 1 ? '' : 's'}`);
  }

  console.log('');
}

async function types(app: VedApp): Promise<void> {
  const index = app.memory.vault.getIndex();

  if (index.types.size === 0) {
    console.log('\n  No entity types found.\n');
    return;
  }

  console.log(`\n  📂 Entity Types (${index.types.size}):\n`);

  const sorted = [...index.types.entries()]
    .sort((a, b) => b[1].size - a[1].size);

  for (const [type, files] of sorted) {
    console.log(`    ${type.padEnd(15)} ${files.size} file${files.size === 1 ? '' : 's'}`);
  }

  console.log('');
}

// === Main Entry ===

export async function memoryCommand(app: VedApp, args: string[]): Promise<void> {
  const sub = args[0] || 'help';
  const subArgs = args.slice(1);

  switch (sub) {
    case 'list':
    case 'ls':
      return list(app, subArgs);

    case 'show':
    case 'cat':
    case 'read':
      return show(app, subArgs);

    case 'graph':
    case 'links':
      return graph(app, subArgs);

    case 'timeline':
    case 'recent':
      return timeline(app, subArgs);

    case 'daily':
    case 'today':
      return daily(app, subArgs);

    case 'forget':
    case 'archive':
      return forget(app, subArgs);

    case 'tags':
      return tags(app);

    case 'types':
      return types(app);

    case 'help':
    default:
      console.log(`
  ved memory — Browse and manage the Obsidian knowledge graph

  Subcommands:
    list [--type <type>] [--tag <tag>] [--folder <folder>] [--limit N]
                              List entities (aliases: ls)
    show <path|filename>      Display entity details (aliases: cat, read)
    graph <path|filename> [--depth N]
                              Show wikilink connections (aliases: links)
    timeline [--days N] [--limit N]
                              Recent memory activity (aliases: recent)
    daily [--date YYYY-MM-DD] Show/create daily note (aliases: today)
    forget <path> [--reason <reason>]
                              Soft-delete to archive (aliases: archive)
    tags                      List all tags with counts
    types                     List all entity types with counts

  Entity types: person, org, place, project, concept, decision, topic, daily

  Examples:
    ved memory list --type person
    ved memory show entities/people/alice.md
    ved memory graph alice --depth 2
    ved memory timeline --days 14
    ved memory daily
    ved memory forget concepts/old-idea.md --reason "superseded"
    ved memory tags
`);
      if (sub !== 'help') {
        console.error(`Unknown subcommand: ${sub}`);
        process.exit(1);
      }
  }
}
