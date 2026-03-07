#!/usr/bin/env node
/**
 * Ved CLI — entry point.
 *
 * Commands:
 *   ved            — Start interactive CLI session (default)
 *   ved init       — Create ~/.ved/ with default config
 *   ved status     — Show health check
 *   ved migrate    — Run database migrations
 *   ved version    — Show version
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, VedApp } from './app.js';
import { getConfigDir, loadConfig, validateConfig } from './core/config.js';
import { createLogger } from './core/log.js';
import type { MergedResult } from './rag/types.js';
import type { VaultExport } from './export-types.js';
import { memoryCommand } from './cli-memory.js';
import { VedHttpServer } from './http.js';

const log = createLogger('cli');
const VERSION = '0.1.0';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'start';

  switch (command) {
    case 'init':
      return init();
    case 'version':
    case '--version':
    case '-v':
      console.log(`Ved v${VERSION}`);
      return;
    case 'status':
      return status();
    case 'stats':
      return stats();
    case 'reindex':
      return reindex();
    case 'search':
      return search(args.slice(1));
    case 'config':
      return config(args.slice(1));
    case 'export':
      return exportVault(args.slice(1));
    case 'import':
      return importVault(args.slice(1));
    case 'history':
      return history(args.slice(1));
    case 'doctor':
      return doctor();
    case 'backup':
      return backup(args.slice(1));
    case 'cron':
      return cron(args.slice(1));
    case 'upgrade':
      return upgrade(args.slice(1));
    case 'watch':
      return watch();
    case 'plugin':
      return plugin(args.slice(1));
    case 'gc':
      return gc(args.slice(1));
    case 'webhook':
      return webhook(args.slice(1));
    case 'memory':
    case 'mem': {
      const app = createApp();
      await app.init();
      try {
        await memoryCommand(app, args.slice(1));
      } finally {
        await app.stop();
      }
      return;
    }
    case 'serve':
    case 'api':
      return serve(args.slice(1));
    case 'completions':
      return completions(args.slice(1));
    case 'start':
    case 'run':
      return start();
    default:
      console.error(`Unknown command: ${command}`);
      console.log('Usage: ved [init|start|serve|status|stats|search|memory|reindex|config|export|import|history|doctor|backup|cron|upgrade|watch|webhook|plugin|gc|completions|version]');
      process.exit(1);
  }
}

/**
 * Initialize ~/.ved/ directory with default config.
 */
function init(): void {
  const configDir = getConfigDir();

  if (existsSync(join(configDir, 'config.yaml'))) {
    console.log(`Config already exists at ${configDir}/config.yaml`);
    return;
  }

  mkdirSync(configDir, { recursive: true });

  const defaultConfig = `# Ved Configuration
# See docs for full options: https://github.com/cheenu1092-oss/ved

# LLM provider settings
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  # apiKey: set in config.local.yaml or VED_LLM_API_KEY env var

# Memory / Obsidian vault
memory:
  vaultPath: ~/ved-vault
  gitEnabled: true

# Trust tiers
trust:
  ownerIds:
    - "your-discord-id-here"  # REQUIRED: set your ID

# Channels (at least one must be enabled)
channels:
  - type: cli
    enabled: true
    config: {}

# MCP tool servers
mcp:
  servers: []
`;

  writeFileSync(join(configDir, 'config.yaml'), defaultConfig);

  // Create config.local.yaml template (gitignored, for secrets)
  const localConfigPath = join(configDir, 'config.local.yaml');
  if (!existsSync(localConfigPath)) {
    const localConfig = `# Ved Local Config — SECRETS GO HERE (gitignored)
# This file overrides config.yaml for sensitive values.

llm:
  # apiKey: sk-your-anthropic-key-here
  # Or set env: VED_LLM_API_KEY

# channels:
#   - type: discord
#     enabled: true
#     config:
#       token: your-discord-bot-token
`;
    writeFileSync(localConfigPath, localConfig);
  }

  // Create default vault directory
  const vaultPath = join(process.env.HOME ?? '~', 'ved-vault');
  if (!existsSync(vaultPath)) {
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(join(vaultPath, 'daily'), { recursive: true });
    mkdirSync(join(vaultPath, 'entities'), { recursive: true });
    mkdirSync(join(vaultPath, 'concepts'), { recursive: true });
    mkdirSync(join(vaultPath, 'decisions'), { recursive: true });

    // Vault README for Obsidian users
    writeFileSync(join(vaultPath, 'README.md'),
      `# Ved Vault\n\nThis is Ved's knowledge graph. Open this folder in Obsidian to visualize connections.\n\n` +
      `## Structure\n- \`daily/\` — Episodic memory (session summaries)\n- \`entities/\` — People, orgs, projects\n` +
      `- \`concepts/\` — Ideas, technologies\n- \`decisions/\` — Dated decision records\n`
    );
  }

  console.log(`✅ Created ${configDir}/config.yaml`);
  console.log(`✅ Created ${configDir}/config.local.yaml (add your API keys here)`);
  if (existsSync(vaultPath)) {
    console.log(`✅ Created vault at ${vaultPath}`);
  }
  console.log(`\nNext steps:`);
  console.log(`  1. Edit ${configDir}/config.yaml — set your owner ID`);
  console.log(`  2. Edit ${configDir}/config.local.yaml — add API keys`);
  console.log(`  3. Run: ved`);
}

/**
 * Show health status.
 */
async function status(): Promise<void> {
  try {
    const app = createApp();
    await app.init();
    const health = await app.healthCheck();

    console.log(`\nVed v${VERSION} — Health Check\n`);
    console.log(`Overall: ${health.healthy ? '✅ Healthy' : '❌ Unhealthy'}\n`);

    for (const mod of health.modules) {
      const icon = mod.healthy ? '✅' : '❌';
      console.log(`  ${icon} ${mod.module}: ${mod.details ?? 'ok'}`);
    }
    console.log('');

    await app.stop();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Show comprehensive system stats.
 */
async function stats(): Promise<void> {
  try {
    const app = createApp();
    await app.init();
    const s = app.getStats();

    console.log(`\nVed v${VERSION} — Stats\n`);

    console.log('  📚 Vault');
    console.log(`     Files:       ${s.vault.fileCount}`);
    console.log(`     Tags:        ${s.vault.tagCount}`);
    console.log(`     Types:       ${s.vault.typeCount}`);
    console.log(`     Git:         ${s.vault.gitClean ? '✅ clean' : `⚠️  ${s.vault.gitDirtyCount} dirty`}`);

    console.log('  🔍 RAG Index');
    console.log(`     Files:       ${s.rag.filesIndexed}`);
    console.log(`     Chunks:      ${s.rag.chunksStored}`);
    console.log(`     FTS entries: ${s.rag.ftsEntries}`);
    console.log(`     Graph edges: ${s.rag.graphEdges}`);
    console.log(`     Queue:       ${s.rag.queueDepth}`);

    console.log('  🔗 Audit');
    console.log(`     Chain:       ${s.audit.chainLength} entries`);
    console.log(`     Head:        ${s.audit.chainHead}…`);

    console.log('  💬 Sessions');
    console.log(`     Active:      ${s.sessions.active}`);
    console.log(`     Total:       ${s.sessions.total}`);

    console.log('');

    await app.stop();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Force full RAG re-index of all vault files.
 */
async function reindex(): Promise<void> {
  console.log(`\nVed v${VERSION} — Full Re-index\n`);

  try {
    const app = createApp();
    await app.init();

    const startTime = Date.now();
    const stats = await app.reindexVault();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`✅ Re-index complete in ${elapsed}s\n`);
    console.log(`  Files indexed:  ${stats.filesIndexed}`);
    console.log(`  Chunks stored:  ${stats.chunksStored}`);
    console.log(`  FTS entries:    ${stats.ftsEntries}`);
    console.log(`  Graph edges:    ${stats.graphEdges}`);
    console.log('');

    await app.stop();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Start Ved in interactive mode.
 */
async function start(): Promise<void> {
  const app = createApp();

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = async () => {
    console.log('\nShutting down...');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await app.start();
  } catch (err) {
    log.error('Ved failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`\nFailed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Search the vault via RAG pipeline (vector + FTS + graph fusion).
 *
 * Usage: ved search <query> [-n <limit>] [--fts-only] [--verbose]
 */
async function search(args: string[]): Promise<void> {
  // Parse flags
  let topK = 5;
  let verbose = false;
  let ftsOnly = false;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--limit') && args[i + 1]) {
      topK = parseInt(args[i + 1], 10);
      if (isNaN(topK) || topK <= 0) {
        console.error('Error: -n must be a positive integer');
        process.exit(1);
      }
      i++; // skip next
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    } else if (args[i] === '--fts-only' || args[i] === '--fts') {
      ftsOnly = true;
    } else {
      queryParts.push(args[i]);
    }
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error('Usage: ved search <query> [-n <limit>] [--fts-only] [--verbose]');
    process.exit(1);
  }

  try {
    const app = createApp();
    await app.init();

    const startTime = Date.now();
    const context = await app.search(query, {
      vectorTopK: topK,
      ftsTopK: topK,
      sources: ftsOnly ? ['fts'] : undefined,
    });
    const elapsed = Date.now() - startTime;

    console.log(`\nVed v${VERSION} — Search\n`);
    console.log(`  Query:   "${query}"`);
    console.log(`  Results: ${context.results.length} (${elapsed}ms)`);

    if (verbose) {
      const m = context.metrics;
      console.log(`  Sources: vector=${m.vectorResultCount} fts=${m.ftsResultCount} graph=${m.graphResultCount}`);
      console.log(`  Timing:  vector=${m.vectorSearchMs}ms fts=${m.ftsSearchMs}ms graph=${m.graphWalkMs}ms fusion=${m.fusionMs}ms`);
      console.log(`  Tokens:  ${context.tokenCount}`);
    }

    if (context.results.length === 0) {
      console.log('\n  No results found.\n');
      await app.stop();
      return;
    }

    console.log('');

    for (let i = 0; i < context.results.length; i++) {
      const r: MergedResult = context.results[i];
      const heading = r.heading ? ` § ${r.heading}` : '';
      const sources = r.sources.join('+');
      const score = r.rrfScore.toFixed(4);

      console.log(`  ${i + 1}. ${r.filePath}${heading}`);
      console.log(`     Score: ${score} [${sources}]`);

      // Show content preview (first 200 chars)
      const preview = r.content.replace(/\n/g, ' ').slice(0, 200);
      console.log(`     ${preview}${r.content.length > 200 ? '…' : ''}`);
      console.log('');
    }

    await app.stop();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Config subcommands: validate, show, path.
 *
 * Usage:
 *   ved config validate  — Check config for errors/warnings
 *   ved config show      — Print resolved config (redacted secrets)
 *   ved config path      — Print config directory path
 */
async function config(args: string[]): Promise<void> {
  const sub = args[0] ?? 'validate';

  switch (sub) {
    case 'validate': {
      try {
        const cfg = loadConfig();
        const errors = validateConfig(cfg);

        console.log(`\nVed v${VERSION} — Config Validation\n`);

        if (errors.length === 0) {
          console.log('  ✅ Configuration is valid.\n');
          return;
        }

        for (const e of errors) {
          const icon = e.code === 'REQUIRED' ? '❌' : '⚠️';
          console.log(`  ${icon} ${e.path}: ${e.message} (${e.code})`);
        }
        console.log(`\n  ${errors.length} issue(s) found.\n`);
        process.exit(1);
      } catch (err) {
        console.error(`Config load failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'show': {
      try {
        const cfg = loadConfig();
        // Redact secrets
        const redacted = JSON.parse(JSON.stringify(cfg));
        if (redacted.llm?.apiKey) redacted.llm.apiKey = '***REDACTED***';
        if (redacted.channels) {
          for (const ch of redacted.channels) {
            if (ch.token) ch.token = '***REDACTED***';
          }
        }
        console.log(`\nVed v${VERSION} — Resolved Config\n`);
        console.log(JSON.stringify(redacted, null, 2));
        console.log('');
      } catch (err) {
        console.error(`Config load failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'path':
      console.log(getConfigDir());
      break;

    default:
      console.error(`Unknown config subcommand: ${sub}`);
      console.log('Usage: ved config [validate|show|path]');
      process.exit(1);
  }
}

/**
 * Export vault to portable JSON.
 *
 * Usage:
 *   ved export                       — Print JSON to stdout
 *   ved export -o vault-export.json  — Write to file
 *   ved export --pretty              — Pretty-print JSON
 *   ved export --include-audit       — Include audit chain entries
 *   ved export --include-stats       — Include RAG/vault/session stats
 *   ved export --folder entities     — Export only one folder
 */
async function exportVault(args: string[]): Promise<void> {
  let outputPath: string | null = null;
  let pretty = false;
  let includeAudit = false;
  let includeStats = false;
  let folder: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === '--pretty' || args[i] === '-p') {
      pretty = true;
    } else if (args[i] === '--include-audit' || args[i] === '--audit') {
      includeAudit = true;
    } else if (args[i] === '--include-stats' || args[i] === '--stats') {
      includeStats = true;
    } else if ((args[i] === '--folder' || args[i] === '-f') && args[i + 1]) {
      folder = args[i + 1];
      i++;
    } else {
      console.error(`Unknown export flag: ${args[i]}`);
      console.log('Usage: ved export [-o <file>] [--pretty] [--include-audit] [--include-stats] [--folder <name>]');
      process.exit(1);
    }
  }

  try {
    const app = createApp();
    await app.init();

    const startTime = Date.now();
    const result = await app.exportVault({ folder, includeAudit, includeStats });
    const elapsed = Date.now() - startTime;

    const json = pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);

    if (outputPath) {
      writeFileSync(outputPath, json);
      console.log(`✅ Exported ${result.files.length} files to ${outputPath} (${elapsed}ms)`);
      if (includeAudit) console.log(`   Audit entries: ${result.audit?.entries ?? 0}`);
      if (includeStats) console.log(`   Stats included`);
    } else {
      process.stdout.write(json + '\n');
    }

    await app.stop();
  } catch (err) {
    console.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Import vault from JSON export.
 *
 * Usage:
 *   ved import vault-export.json            — Import from file
 *   cat export.json | ved import -           — Import from stdin
 *   ved import vault-export.json --dry-run   — Preview without writing
 *   ved import vault-export.json --merge     — Merge (skip existing files)
 *   ved import vault-export.json --overwrite — Overwrite existing files
 */
async function importVault(args: string[]): Promise<void> {
  let inputPath: string | null = null;
  let dryRun = false;
  let mode: 'merge' | 'overwrite' | 'fail' = 'fail';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run' || args[i] === '-n') {
      dryRun = true;
    } else if (args[i] === '--merge') {
      mode = 'merge';
    } else if (args[i] === '--overwrite') {
      mode = 'overwrite';
    } else if (!args[i].startsWith('-')) {
      inputPath = args[i];
    } else {
      console.error(`Unknown import flag: ${args[i]}`);
      console.log('Usage: ved import <file|-|--stdin> [--dry-run] [--merge|--overwrite]');
      process.exit(1);
    }
  }

  if (!inputPath) {
    console.error('Usage: ved import <file|-|--stdin> [--dry-run] [--merge|--overwrite]');
    process.exit(1);
  }

  try {
    // Read input
    let raw: string;
    if (inputPath === '-' || inputPath === '--stdin') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      raw = Buffer.concat(chunks).toString('utf-8');
    } else {
      if (!existsSync(inputPath)) {
        console.error(`File not found: ${inputPath}`);
        process.exit(1);
      }
      raw = readFileSync(inputPath, 'utf-8');
    }

    // Parse and validate
    let data: VaultExport;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error('Invalid JSON input');
      process.exit(1);
    }

    if (!data.vedVersion || !Array.isArray(data.files)) {
      console.error('Invalid Ved export format (missing vedVersion or files array)');
      process.exit(1);
    }

    console.log(`\nVed v${VERSION} — Import\n`);
    console.log(`  Source:    ${inputPath}`);
    console.log(`  Version:   ${data.vedVersion}`);
    console.log(`  Exported:  ${data.exportedAt}`);
    console.log(`  Files:     ${data.files.length}`);
    console.log(`  Mode:      ${dryRun ? 'DRY RUN' : mode}`);
    console.log('');

    if (dryRun) {
      // Preview only
      let created = 0;
      let skipped = 0;
      let overwritten = 0;

      const app = createApp();
      await app.init();

      for (const f of data.files) {
        const exists = app.vaultFileExists(f.path);
        if (exists) {
          if (mode === 'merge') {
            skipped++;
            console.log(`  SKIP  ${f.path}`);
          } else if (mode === 'overwrite') {
            overwritten++;
            console.log(`  OVER  ${f.path}`);
          } else {
            console.log(`  CONFLICT  ${f.path} (use --merge or --overwrite)`);
            skipped++;
          }
        } else {
          created++;
          console.log(`  NEW   ${f.path}`);
        }
      }

      console.log(`\n  Would create: ${created}, overwrite: ${overwritten}, skip: ${skipped}\n`);
      await app.stop();
      return;
    }

    // Actual import
    const app = createApp();
    await app.init();

    const startTime = Date.now();
    const result = await app.importVault(data, mode);
    const elapsed = Date.now() - startTime;

    console.log(`✅ Import complete in ${elapsed}ms\n`);
    console.log(`  Created:     ${result.created}`);
    console.log(`  Overwritten: ${result.overwritten}`);
    console.log(`  Skipped:     ${result.skipped}`);
    console.log(`  Errors:      ${result.errors}`);

    if (result.errorPaths.length > 0) {
      console.log('\n  Failed files:');
      for (const p of result.errorPaths) {
        console.log(`    ❌ ${p}`);
      }
    }
    console.log('');

    await app.stop();
  } catch (err) {
    console.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * View audit history.
 *
 * Usage:
 *   ved history                          — Show last 20 entries
 *   ved history -n 50                    — Show last 50 entries
 *   ved history --type tool_executed     — Filter by event type
 *   ved history --from 2026-03-01        — Filter from date
 *   ved history --to 2026-03-06          — Filter to date
 *   ved history --verify                 — Verify hash chain integrity
 *   ved history --types                  — List all event types in log
 *   ved history --json                   — Output as JSON
 */
async function history(args: string[]): Promise<void> {
  let limit = 20;
  let type: string | undefined;
  let fromDate: string | undefined;
  let toDate: string | undefined;
  let verify = false;
  let listTypes = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--limit') && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      if (isNaN(limit) || limit <= 0) {
        console.error('Error: -n must be a positive integer');
        process.exit(1);
      }
      i++;
    } else if ((args[i] === '--type' || args[i] === '-t') && args[i + 1]) {
      type = args[i + 1];
      i++;
    } else if (args[i] === '--from' && args[i + 1]) {
      fromDate = args[i + 1];
      i++;
    } else if (args[i] === '--to' && args[i + 1]) {
      toDate = args[i + 1];
      i++;
    } else if (args[i] === '--verify') {
      verify = true;
    } else if (args[i] === '--types') {
      listTypes = true;
    } else if (args[i] === '--json') {
      json = true;
    } else {
      console.error(`Unknown history flag: ${args[i]}`);
      console.log('Usage: ved history [-n <limit>] [--type <event_type>] [--from <date>] [--to <date>] [--verify] [--types] [--json]');
      process.exit(1);
    }
  }

  try {
    const app = createApp();
    await app.init();

    // --types: list all event types
    if (listTypes) {
      const types = app.getAuditEventTypes();
      console.log(`\nVed v${VERSION} — Audit Event Types\n`);
      if (types.length === 0) {
        console.log('  No entries in audit log.\n');
      } else {
        for (const t of types) {
          console.log(`  • ${t}`);
        }
        console.log(`\n  ${types.length} type(s) found.\n`);
      }
      await app.stop();
      return;
    }

    // --verify: check hash chain
    if (verify) {
      console.log(`\nVed v${VERSION} — Audit Chain Verification\n`);
      const result = app.verifyAuditChain();
      if (result.total === 0) {
        console.log('  ℹ️  Audit log is empty.\n');
      } else if (result.intact) {
        console.log(`  ✅ Chain intact — ${result.total} entries verified.\n`);
      } else {
        console.log(`  ❌ Chain BROKEN at entry ${result.brokenAt} of ${result.total}.`);
        console.log('     This indicates tampering or data corruption.\n');
      }
      await app.stop();
      return;
    }

    // Parse date filters
    const from = fromDate ? new Date(fromDate).getTime() : undefined;
    const to = toDate ? (new Date(toDate).getTime() + 86400000 - 1) : undefined; // end of day

    if (fromDate && (from === undefined || isNaN(from))) {
      console.error(`Invalid --from date: ${fromDate}`);
      process.exit(1);
    }
    if (toDate && (to === undefined || isNaN(to))) {
      console.error(`Invalid --to date: ${toDate}`);
      process.exit(1);
    }

    const entries = app.getHistory({ type, from, to, limit });

    if (json) {
      console.log(JSON.stringify(entries, null, 2));
      await app.stop();
      return;
    }

    console.log(`\nVed v${VERSION} — Audit History\n`);

    if (type) console.log(`  Filter: type=${type}`);
    if (fromDate) console.log(`  Filter: from=${fromDate}`);
    if (toDate) console.log(`  Filter: to=${toDate}`);
    if (type || fromDate || toDate) console.log('');

    if (entries.length === 0) {
      console.log('  No entries found.\n');
      await app.stop();
      return;
    }

    for (const entry of entries) {
      const ts = new Date(entry.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      const session = entry.sessionId ? ` [${entry.sessionId.slice(0, 8)}…]` : '';

      // Parse detail and show a compact preview
      let detailPreview = '';
      try {
        const detail = JSON.parse(entry.detail);
        // Show first 2 keys or a meaningful field
        const keys = Object.keys(detail);
        if (detail.tool) {
          detailPreview = `tool=${detail.tool}`;
        } else if (detail.content) {
          detailPreview = detail.content.slice(0, 80) + (detail.content.length > 80 ? '…' : '');
        } else if (keys.length > 0) {
          detailPreview = keys.slice(0, 3).map(k => {
            const v = detail[k];
            const str = typeof v === 'string' ? v : JSON.stringify(v);
            return `${k}=${str.slice(0, 40)}`;
          }).join(', ');
        }
      } catch {
        detailPreview = entry.detail.slice(0, 80);
      }

      console.log(`  ${ts}  ${entry.eventType.padEnd(22)} ${entry.actor.padEnd(8)}${session}`);
      if (detailPreview) {
        console.log(`    ${detailPreview}`);
      }
    }

    console.log(`\n  Showing ${entries.length} entries (newest first). Use -n to see more.\n`);

    await app.stop();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Run self-diagnostics.
 *
 * Usage: ved doctor
 */
async function doctor(): Promise<void> {
  console.log(`\nVed v${VERSION} — Doctor\n`);

  try {
    const app = createApp();
    await app.init();

    const result = await app.doctor();

    for (const check of result.checks) {
      const icon = check.status === 'ok' ? '✅'
        : check.status === 'warn' ? '⚠️'
        : check.status === 'fail' ? '❌'
        : 'ℹ️';
      const fixHint = check.fixable ? ' (fixable)' : '';
      console.log(`  ${icon} ${check.name}: ${check.message}${fixHint}`);
    }

    console.log('');
    console.log(`  Summary: ${result.passed} passed, ${result.warned} warnings, ${result.failed} failed, ${result.infos} info`);

    if (result.failed > 0) {
      console.log('\n  ❌ Some checks failed. Address the issues above.\n');
    } else if (result.warned > 0) {
      console.log('\n  ⚠️  Some warnings. Ved will work but may not be fully operational.\n');
    } else {
      console.log('\n  🎉 All checks passed! Ved is healthy.\n');
    }

    await app.stop();

    // Exit with non-zero if any checks failed
    if (result.failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Doctor failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Vault + database backup management.
 *
 * Usage:
 *   ved backup              — Create a new backup (default)
 *   ved backup create       — Create a new backup
 *   ved backup list         — List existing backups
 *   ved backup restore <file> — Restore from a backup
 *   ved backup create -d <dir> — Custom backup directory
 *   ved backup create -n 5  — Keep max 5 backups
 */
async function backup(args: string[]): Promise<void> {
  const sub = args[0] ?? 'create';

  switch (sub) {
    case 'create': {
      let backupDir: string | undefined;
      let maxBackups: number | undefined;

      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '-d' || args[i] === '--dir') && args[i + 1]) {
          backupDir = args[i + 1];
          i++;
        } else if ((args[i] === '-n' || args[i] === '--max') && args[i + 1]) {
          maxBackups = parseInt(args[i + 1], 10);
          if (isNaN(maxBackups) || maxBackups <= 0) {
            console.error('Error: -n must be a positive integer');
            process.exit(1);
          }
          i++;
        } else {
          console.error(`Unknown backup create flag: ${args[i]}`);
          process.exit(1);
        }
      }

      try {
        const app = createApp();
        await app.init();

        console.log(`\nVed v${VERSION} — Backup\n`);
        console.log('  Creating backup...');

        const startTime = Date.now();
        const result = app.createBackup({ backupDir, maxBackups });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const sizeMB = (result.sizeBytes / (1024 * 1024)).toFixed(2);

        console.log(`\n  ✅ Backup created in ${elapsed}s\n`);
        console.log(`  File:        ${result.filename}`);
        console.log(`  Path:        ${result.path}`);
        console.log(`  Vault files: ${result.vaultFiles}`);
        console.log(`  Size:        ${sizeMB} MB`);
        console.log('');

        await app.stop();
      } catch (err) {
        console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'list': {
      try {
        const app = createApp();
        await app.init();

        const backups = app.listBackups();

        console.log(`\nVed v${VERSION} — Backups\n`);

        if (backups.length === 0) {
          console.log('  No backups found. Run `ved backup` to create one.\n');
          await app.stop();
          return;
        }

        for (let i = 0; i < backups.length; i++) {
          const b = backups[i];
          const sizeMB = (b.sizeBytes / (1024 * 1024)).toFixed(2);
          const date = b.createdAt.toISOString().replace('T', ' ').slice(0, 19);
          const label = i === 0 ? ' (latest)' : '';
          console.log(`  ${i + 1}. ${b.filename}${label}`);
          console.log(`     ${date}  ${sizeMB} MB`);
        }

        console.log(`\n  ${backups.length} backup(s) found.\n`);

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'restore': {
      let backupPath: string | undefined;
      let dryRun = false;

      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--dry-run' || args[i] === '-n') {
          dryRun = true;
        } else if (!args[i].startsWith('-')) {
          backupPath = args[i];
        } else {
          console.error(`Unknown restore flag: ${args[i]}`);
          process.exit(1);
        }
      }

      if (!backupPath) {
        console.error('Usage: ved backup restore <backup-file> [--dry-run]');
        process.exit(1);
      }

      try {
        const app = createApp();
        await app.init();

        console.log(`\nVed v${VERSION} — Restore\n`);
        console.log(`  Source: ${backupPath}`);
        console.log(`  Mode:   ${dryRun ? 'DRY RUN (no changes)' : '⚠️  LIVE RESTORE'}`);
        console.log('');

        const result = app.restoreBackup(backupPath, { dryRun });

        if (dryRun) {
          console.log(`  Would restore:`);
          console.log(`    Vault files:  ${result.vaultFiles}`);
          console.log(`    Database:     ${result.dbRestored ? 'yes' : 'no'}`);
          console.log('\n  Run without --dry-run to apply.\n');
        } else {
          console.log(`  ✅ Restore complete\n`);
          console.log(`  Vault files: ${result.vaultFiles}`);
          console.log(`  Database:    ${result.dbRestored ? 'restored' : 'not included'}`);
          console.log('\n  ⚠️  Restart Ved to pick up restored data.\n');
        }

        await app.stop();
      } catch (err) {
        console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown backup subcommand: ${sub}`);
      console.log('Usage: ved backup [create|list|restore]');
      process.exit(1);
  }
}

/**
 * Cron job management.
 *
 * Usage:
 *   ved cron                               — List all jobs (default)
 *   ved cron list                          — List all jobs
 *   ved cron add <name> <schedule> <type>  — Add a scheduled job
 *   ved cron remove <name>                 — Remove a job
 *   ved cron enable <name>                 — Enable a disabled job
 *   ved cron disable <name>                — Disable a job
 *   ved cron run <name>                    — Manually trigger a job
 *   ved cron history [name] [-n <limit>]   — Show execution history
 *
 * Job types: backup, reindex, doctor
 *
 * Examples:
 *   ved cron add nightly-backup "0 2 * * *" backup
 *   ved cron add weekly-reindex "0 3 * * 0" reindex
 *   ved cron add daily-doctor "@daily" doctor
 *   ved cron add hourly-backup "0 * * * *" backup --max-backups 24
 */
async function cron(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list': {
      try {
        const app = createApp();
        await app.init();

        const jobs = app.cronList();

        console.log(`\nVed v${VERSION} — Cron Jobs\n`);

        if (jobs.length === 0) {
          console.log('  No cron jobs configured.\n');
          console.log('  Add one with: ved cron add <name> "<schedule>" <type>');
          console.log('  Types: backup, reindex, doctor\n');
          console.log('  Examples:');
          console.log('    ved cron add nightly-backup "0 2 * * *" backup');
          console.log('    ved cron add weekly-reindex "0 3 * * 0" reindex\n');
          await app.stop();
          return;
        }

        for (const job of jobs) {
          const status = job.enabled ? '✅' : '⏸️';
          const lastRun = job.lastRun
            ? new Date(job.lastRun).toISOString().replace('T', ' ').slice(0, 19)
            : 'never';
          const nextRun = job.nextRun
            ? new Date(job.nextRun).toISOString().replace('T', ' ').slice(0, 19)
            : 'n/a';
          const lastResult = job.lastResult
            ? (job.lastResult === 'success' ? '✅' : '❌')
            : '—';

          console.log(`  ${status} ${job.name} (${job.jobType})`);
          console.log(`     Schedule:    ${job.schedule}`);
          console.log(`     Last run:    ${lastRun} ${lastResult}`);
          console.log(`     Next run:    ${nextRun}`);
          console.log(`     Runs:        ${job.runCount}`);
          if (job.lastError) {
            console.log(`     Last error:  ${job.lastError}`);
          }
          console.log('');
        }

        console.log(`  ${jobs.length} job(s) configured.\n`);

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'add': {
      // Parse: ved cron add <name> "<schedule>" <type> [--config-key value]
      const name = args[1];
      const schedule = args[2];
      const jobType = args[3];

      if (!name || !schedule || !jobType) {
        console.error('Usage: ved cron add <name> "<schedule>" <type> [--max-backups <n>] [--backup-dir <dir>]');
        console.error('\nTypes: backup, reindex, doctor');
        console.error('\nExamples:');
        console.error('  ved cron add nightly-backup "0 2 * * *" backup');
        console.error('  ved cron add weekly-reindex "@weekly" reindex');
        process.exit(1);
      }

      if (!['backup', 'reindex', 'doctor'].includes(jobType)) {
        console.error(`Unknown job type: ${jobType}`);
        console.error('Valid types: backup, reindex, doctor');
        process.exit(1);
      }

      // Parse optional config flags
      const jobConfig: Record<string, unknown> = {};
      for (let i = 4; i < args.length; i++) {
        if (args[i] === '--max-backups' && args[i + 1]) {
          jobConfig.maxBackups = parseInt(args[i + 1], 10);
          i++;
        } else if (args[i] === '--backup-dir' && args[i + 1]) {
          jobConfig.backupDir = args[i + 1];
          i++;
        } else {
          console.error(`Unknown flag: ${args[i]}`);
          process.exit(1);
        }
      }

      try {
        const app = createApp();
        await app.init();

        const job = app.cronAdd({ name, schedule, jobType, jobConfig });

        console.log(`\nVed v${VERSION} — Cron Job Added\n`);
        console.log(`  ✅ ${job.name}`);
        console.log(`     Type:      ${job.jobType}`);
        console.log(`     Schedule:  ${job.schedule}`);
        if (job.nextRun) {
          console.log(`     Next run:  ${new Date(job.nextRun).toISOString().replace('T', ' ').slice(0, 19)}`);
        }
        console.log('');

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Usage: ved cron remove <name>');
        process.exit(1);
      }

      try {
        const app = createApp();
        await app.init();

        const removed = app.cronRemove(name);
        if (removed) {
          console.log(`\n  ✅ Removed cron job: ${name}\n`);
        } else {
          console.error(`  ❌ Cron job not found: ${name}`);
          process.exit(1);
        }

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'enable':
    case 'disable': {
      const name = args[1];
      if (!name) {
        console.error(`Usage: ved cron ${sub} <name>`);
        process.exit(1);
      }

      try {
        const app = createApp();
        await app.init();

        const enabled = sub === 'enable';
        const job = app.cronToggle(name, enabled);

        if (job) {
          const icon = enabled ? '✅' : '⏸️';
          console.log(`\n  ${icon} ${job.name} — ${enabled ? 'enabled' : 'disabled'}`);
          if (job.nextRun) {
            console.log(`     Next run: ${new Date(job.nextRun).toISOString().replace('T', ' ').slice(0, 19)}`);
          }
          console.log('');
        } else {
          console.error(`  ❌ Cron job not found: ${name}`);
          process.exit(1);
        }

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'run': {
      const name = args[1];
      if (!name) {
        console.error('Usage: ved cron run <name>');
        process.exit(1);
      }

      try {
        const app = createApp();
        await app.init();

        console.log(`\nVed v${VERSION} — Manual Cron Run\n`);
        console.log(`  Running: ${name}...`);

        const result = await app.cronRun(name);
        const icon = result.success ? '✅' : '❌';

        console.log(`\n  ${icon} ${result.jobName} (${result.jobType})`);
        console.log(`     Duration: ${result.durationMs}ms`);
        console.log(`     Message:  ${result.message}`);
        if (result.error) {
          console.log(`     Error:    ${result.error}`);
        }
        console.log('');

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'history': {
      let jobName: string | undefined;
      let limit = 20;

      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '-n' || args[i] === '--limit') && args[i + 1]) {
          limit = parseInt(args[i + 1], 10);
          if (isNaN(limit) || limit <= 0) {
            console.error('Error: -n must be a positive integer');
            process.exit(1);
          }
          i++;
        } else if (!args[i].startsWith('-')) {
          jobName = args[i];
        } else {
          console.error(`Unknown history flag: ${args[i]}`);
          process.exit(1);
        }
      }

      try {
        const app = createApp();
        await app.init();

        const entries = app.cronHistory(jobName, limit);

        console.log(`\nVed v${VERSION} — Cron History\n`);
        if (jobName) console.log(`  Filter: ${jobName}\n`);

        if (entries.length === 0) {
          console.log('  No execution history found.\n');
          await app.stop();
          return;
        }

        for (const entry of entries) {
          const ts = new Date(entry.startedAt).toISOString().replace('T', ' ').slice(0, 19);
          const icon = entry.success ? '✅' : '❌';
          const dur = entry.durationMs < 1000
            ? `${entry.durationMs}ms`
            : `${(entry.durationMs / 1000).toFixed(1)}s`;

          console.log(`  ${ts}  ${icon} ${entry.jobName} (${entry.jobType})  ${dur}`);
          if (entry.message) {
            console.log(`    ${entry.message}`);
          }
          if (entry.error) {
            console.log(`    ❌ ${entry.error}`);
          }
        }

        console.log(`\n  ${entries.length} entries shown.\n`);

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown cron subcommand: ${sub}`);
      console.log('Usage: ved cron [list|add|remove|enable|disable|run|history]');
      process.exit(1);
  }
}

/**
 * Database migration management.
 *
 * Usage:
 *   ved upgrade              — Show migration status (default)
 *   ved upgrade status       — Show current version, pending migrations
 *   ved upgrade run          — Auto-backup + apply pending migrations
 *   ved upgrade verify       — Check migration file integrity (checksums)
 *   ved upgrade history      — Show all applied migrations
 */
async function upgrade(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';

  switch (sub) {
    case 'status': {
      try {
        const app = createApp();
        const info = app.getUpgradeStatus();

        console.log(`\nVed v${VERSION} — Migration Status\n`);
        console.log(`  Schema version:  v${String(info.currentVersion).padStart(3, '0')}`);
        console.log(`  Available:       ${info.availableVersions} migration(s)`);
        console.log(`  Pending:         ${info.pendingCount}`);
        console.log(`  Database:        ${info.dbPath}`);

        if (info.pendingCount > 0) {
          console.log(`\n  ⚠️  ${info.pendingCount} migration(s) pending. Run \`ved upgrade run\` to apply.\n`);
        } else {
          console.log(`\n  ✅ Database is up to date.\n`);
        }

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'run': {
      try {
        const app = createApp();
        const before = app.getUpgradeStatus();

        if (before.pendingCount === 0) {
          console.log(`\nVed v${VERSION} — Upgrade\n`);
          console.log(`  ✅ Already at latest version (v${String(before.currentVersion).padStart(3, '0')}). Nothing to do.\n`);
          await app.stop();
          return;
        }

        console.log(`\nVed v${VERSION} — Upgrade\n`);
        console.log(`  Current version: v${String(before.currentVersion).padStart(3, '0')}`);
        console.log(`  Pending:         ${before.pendingCount} migration(s)`);
        console.log('');

        // Auto-backup before migration
        console.log('  📦 Creating pre-upgrade backup...');
        try {
          const backup = app.createBackup({});
          console.log(`  ✅ Backup saved: ${backup.filename}`);
        } catch (backupErr) {
          console.log(`  ⚠️  Backup failed: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`);
          console.log('     Proceeding with migration anyway...');
        }

        console.log('');
        console.log('  🔄 Applying migrations...');

        // Migrations were already applied during VedApp construction,
        // but call runMigrations() explicitly in case new files were added after construction
        const applied = app.runMigrations();

        const after = app.getUpgradeStatus();

        console.log(`\n  ✅ Upgrade complete\n`);
        console.log(`  Applied:  ${applied} migration(s)`);
        console.log(`  Version:  v${String(after.currentVersion).padStart(3, '0')}`);
        console.log('');

        await app.stop();
      } catch (err) {
        console.error(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error('\nIf the database is corrupted, restore from backup:');
        console.error('  ved backup list');
        console.error('  ved backup restore <backup-file>');
        process.exit(1);
      }
      break;
    }

    case 'verify': {
      try {
        const app = createApp();
        const issues = app.verifyMigrations();

        console.log(`\nVed v${VERSION} — Migration Integrity\n`);

        if (issues.length === 0) {
          console.log('  ✅ All applied migrations match on-disk files. No tampering detected.\n');
        } else {
          for (const issue of issues) {
            console.log(`  ❌ ${issue}`);
          }
          console.log(`\n  ${issues.length} issue(s) found. Migration files may have been modified.\n`);
          process.exit(1);
        }

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'history': {
      try {
        const app = createApp();
        const migrations = app.getAppliedMigrations();

        console.log(`\nVed v${VERSION} — Migration History\n`);

        if (migrations.length === 0) {
          console.log('  No migrations applied yet.\n');
          await app.stop();
          return;
        }

        for (const m of migrations) {
          const date = new Date(m.appliedAt).toISOString().replace('T', ' ').slice(0, 19);
          const checksum = m.checksum ? m.checksum.slice(0, 12) + '…' : '(none)';
          console.log(`  v${String(m.version).padStart(3, '0')}  ${m.filename}`);
          console.log(`        Applied: ${date}  Checksum: ${checksum}`);
        }

        console.log(`\n  ${migrations.length} migration(s) applied.\n`);

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown upgrade subcommand: ${sub}`);
      console.log('Usage: ved upgrade [status|run|verify|history]');
      process.exit(1);
  }
}

/**
 * Standalone vault file watcher — watches for changes and triggers RAG re-indexing.
 * Does NOT start the event loop or channel adapters.
 *
 * Usage: ved watch
 */
async function watch(): Promise<void> {
  console.log(`\nVed v${VERSION} — Vault Watcher\n`);

  try {
    const app = createApp();

    console.log('  Initializing...');
    await app.init();

    const stats = app.getStats();
    console.log(`  Vault:     ${stats.vault.fileCount} files`);
    console.log(`  RAG index: ${stats.rag.filesIndexed} indexed`);
    console.log('');
    console.log('  👁️  Watching vault for changes (Ctrl+C to stop)');
    console.log('  File changes will trigger automatic RAG re-indexing.\n');

    // Graceful shutdown on signal
    const shutdown = async () => {
      console.log('\n  Stopping watcher...');
      await app.stop();
      console.log('  Done.\n');
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Run watcher (blocks until signal)
    await app.runWatch();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Generate shell completions.
 *
 * Usage:
 *   ved completions bash    — Print bash completions
 *   ved completions zsh     — Print zsh completions
 *   ved completions fish    — Print fish completions
 */
function completions(args: string[]): void {
  const shell = args[0];

  if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
    console.error('Usage: ved completions <bash|zsh|fish>');
    console.log('\nInstall:');
    console.log('  bash:  ved completions bash >> ~/.bashrc');
    console.log('  zsh:   ved completions zsh > ~/.zfunc/_ved');
    console.log('  fish:  ved completions fish > ~/.config/fish/completions/ved.fish');
    process.exit(1);
  }

  console.log(VedApp.generateCompletions(shell as 'bash' | 'zsh' | 'fish'));
}

/**
 * MCP server manager.
 *
 * Usage:
 *   ved plugin                          — List configured MCP servers (default)
 *   ved plugin list                     — List configured MCP servers
 *   ved plugin tools [server-name]      — List discovered tools
 *   ved plugin test <server-name>       — Connect and verify server
 *   ved plugin add <name> --transport <stdio|http> [--command <cmd>] [--args <a> ...] [--url <url>] [--enabled]
 *   ved plugin remove <name>            — Remove a server
 */
async function plugin(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list': {
      try {
        const app = createApp();
        await app.init();

        const servers = app.pluginList();

        console.log(`\nVed v${VERSION} — MCP Plugins\n`);

        if (servers.length === 0) {
          console.log('  No MCP servers configured.\n');
          console.log('  Add one with: ved plugin add <name> --transport stdio --command <cmd>');
          console.log('  Or configure in ~/.ved/config.yaml under mcp.servers\n');
          await app.stop();
          return;
        }

        for (const s of servers) {
          const stateIcon = s.state === 'ready' ? '✅'
            : s.state === 'failed' ? '❌'
            : s.state === 'connecting' ? '🔄'
            : '⏸️';
          const lastConn = s.lastConnected
            ? new Date(s.lastConnected).toISOString().replace('T', ' ').slice(0, 19)
            : 'never';

          console.log(`  ${stateIcon} ${s.name} (${s.transport})`);
          console.log(`     State:        ${s.state}`);
          console.log(`     Tools:        ${s.toolCount}`);
          console.log(`     Last connected: ${lastConn}`);
          if (s.lastError) {
            console.log(`     Last error:   ${s.lastError}`);
          }
          console.log('');
        }

        console.log(`  ${servers.length} server(s) configured.\n`);

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'tools': {
      const serverName = args[1] && !args[1].startsWith('-') ? args[1] : undefined;

      try {
        const app = createApp();
        await app.init();

        const tools = app.pluginTools(serverName);

        console.log(`\nVed v${VERSION} — MCP Tools${serverName ? ` (${serverName})` : ''}\n`);

        if (tools.length === 0) {
          if (serverName) {
            console.log(`  No tools found for server "${serverName}".\n`);
            console.log('  Run `ved plugin test <server-name>` to verify connectivity.');
          } else {
            console.log('  No tools discovered. Run `ved init` to start.\n');
          }
          await app.stop();
          return;
        }

        for (const t of tools) {
          const desc = t.description.length > 60
            ? t.description.slice(0, 57) + '…'
            : t.description;
          const riskIcon = t.riskLevel === 'low' ? '🟢'
            : t.riskLevel === 'medium' ? '🟡'
            : t.riskLevel === 'high' ? '🟠'
            : '🔴';

          console.log(`  ${riskIcon} ${t.name}`);
          if (desc) console.log(`     ${desc}`);
        }

        console.log(`\n  ${tools.length} tool(s) found.\n`);

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'test': {
      const serverName = args[1];
      if (!serverName) {
        console.error('Usage: ved plugin test <server-name>');
        process.exit(1);
      }

      try {
        const app = createApp();
        await app.init();

        console.log(`\nVed v${VERSION} — Plugin Test\n`);
        console.log(`  Testing: ${serverName}...`);

        const result = await app.pluginTest(serverName);
        const icon = result.success ? '✅' : '❌';

        console.log(`\n  ${icon} ${result.serverName}`);
        console.log(`     Duration: ${result.durationMs}ms`);
        console.log(`     Tools:    ${result.toolCount}`);
        if (result.tools.length > 0) {
          console.log(`     Names:    ${result.tools.slice(0, 5).join(', ')}${result.tools.length > 5 ? '…' : ''}`);
        }
        if (result.error) {
          console.log(`     Error:    ${result.error}`);
        }
        console.log('');

        await app.stop();

        if (!result.success) process.exit(1);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'add': {
      const name = args[1];
      if (!name || name.startsWith('-')) {
        console.error('Usage: ved plugin add <name> --transport <stdio|http> [--command <cmd>] [--args <a> ...] [--url <url>] [--enabled]');
        process.exit(1);
      }

      let transport: 'stdio' | 'http' | undefined;
      let command: string | undefined;
      const cmdArgs: string[] = [];
      let url: string | undefined;
      let enabled = true;

      for (let i = 2; i < args.length; i++) {
        if ((args[i] === '--transport' || args[i] === '-t') && args[i + 1]) {
          const t = args[i + 1];
          if (t !== 'stdio' && t !== 'http') {
            console.error(`Invalid transport: ${t}. Must be stdio or http`);
            process.exit(1);
          }
          transport = t;
          i++;
        } else if ((args[i] === '--command' || args[i] === '-c') && args[i + 1]) {
          command = args[i + 1];
          i++;
        } else if (args[i] === '--args') {
          // Collect all remaining non-flag args as command args
          i++;
          while (i < args.length && !args[i].startsWith('--')) {
            cmdArgs.push(args[i]);
            i++;
          }
          i--; // back up since loop will increment
        } else if (args[i] === '--url' && args[i + 1]) {
          url = args[i + 1];
          i++;
        } else if (args[i] === '--enabled') {
          enabled = true;
        } else if (args[i] === '--disabled') {
          enabled = false;
        } else {
          console.error(`Unknown plugin add flag: ${args[i]}`);
          process.exit(1);
        }
      }

      if (!transport) {
        console.error('--transport is required (stdio or http)');
        process.exit(1);
      }
      if (transport === 'stdio' && !command) {
        console.error('--command is required for stdio transport');
        process.exit(1);
      }
      if (transport === 'http' && !url) {
        console.error('--url is required for http transport');
        process.exit(1);
      }

      try {
        const app = createApp();
        await app.init();

        await app.pluginAdd({
          name,
          transport,
          command,
          args: cmdArgs.length > 0 ? cmdArgs : undefined,
          url,
          timeout: 30_000,
          riskLevel: 'medium',
          enabled,
        });

        console.log(`\n  ✅ Plugin "${name}" added (${transport})`);
        console.log(`\n  ⚠️  Note: this is a runtime-only registration. It will not persist after restart.`);
        console.log(`     To persist, add it to ~/.ved/config.yaml under mcp.servers\n`);

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Usage: ved plugin remove <name>');
        process.exit(1);
      }

      try {
        const app = createApp();
        await app.init();

        const removed = await app.pluginRemove(name);
        if (removed) {
          console.log(`\n  ✅ Removed plugin: ${name}\n`);
        } else {
          console.error(`  ❌ Plugin not found: ${name}`);
          process.exit(1);
        }

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown plugin subcommand: ${sub}`);
      console.log('Usage: ved plugin [list|tools|test|add|remove]');
      process.exit(1);
  }
}

/**
 * Garbage collection — clean up stale sessions, compact database.
 *
 * Usage:
 *   ved gc                               — Run all GC tasks (default)
 *   ved gc run                           — Run all GC tasks
 *   ved gc run [--dry-run] [--sessions-days <N>] [--audit-days <N>] [--force]
 *   ved gc status                        — Show what would be cleaned
 */
async function gc(args: string[]): Promise<void> {
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'run';
  const restArgs = (sub === 'run' || sub === 'status') ? args.slice(1) : args;

  switch (sub) {
    case 'status': {
      try {
        const app = createApp();
        await app.init();

        const sessionsDays = 30;
        const auditDays = 90;
        const status = app.gcStatus({ sessionsDays, auditDays });

        console.log(`\nVed v${VERSION} — GC Status (what would be cleaned)\n`);
        console.log(`  Sessions cutoff:   ${sessionsDays} days idle`);
        console.log(`  Stale sessions:    ${status.staleSessions}`);
        console.log('');
        console.log(`  Audit cutoff:      ${auditDays} days`);
        console.log(`  Old audit entries: ${status.oldAuditEntries}`);
        if (status.auditWarning) {
          console.log(`\n  ⚠️  ${status.auditWarning}`);
        }
        console.log('');
        console.log('  Run `ved gc run` to clean up stale sessions and compact the database.');
        console.log('');

        await app.stop();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'run': {
      let dryRun = false;
      let sessionsDays = 30;
      let auditDays = 90;
      let force = false;

      for (let i = 0; i < restArgs.length; i++) {
        if (restArgs[i] === '--dry-run' || restArgs[i] === '-n') {
          dryRun = true;
        } else if (restArgs[i] === '--force' || restArgs[i] === '-f') {
          force = true;
        } else if (restArgs[i] === '--sessions-days' && restArgs[i + 1]) {
          sessionsDays = parseInt(restArgs[i + 1], 10);
          if (isNaN(sessionsDays) || sessionsDays <= 0) {
            console.error('Error: --sessions-days must be a positive integer');
            process.exit(1);
          }
          i++;
        } else if (restArgs[i] === '--audit-days' && restArgs[i + 1]) {
          auditDays = parseInt(restArgs[i + 1], 10);
          if (isNaN(auditDays) || auditDays <= 0) {
            console.error('Error: --audit-days must be a positive integer');
            process.exit(1);
          }
          i++;
        } else {
          console.error(`Unknown gc flag: ${restArgs[i]}`);
          console.log('Usage: ved gc run [--dry-run] [--sessions-days <N>] [--audit-days <N>] [--force]');
          process.exit(1);
        }
      }

      // Warn if --audit-days used without --force
      if (auditDays !== 90 && !force && !dryRun) {
        console.log('\n  ⚠️  Warning: --audit-days changes the audit retention period.');
        console.log('     Deleting audit entries breaks the hash chain.');
        console.log('     Add --force to proceed with audit entry deletion.\n');
      }

      try {
        const app = createApp();
        await app.init();

        console.log(`\nVed v${VERSION} — GC ${dryRun ? '(Dry Run)' : ''}\n`);

        if (dryRun) {
          const status = app.gcStatus({ sessionsDays, auditDays });
          console.log(`  Stale sessions:    ${status.staleSessions} (>${sessionsDays} days idle)`);
          console.log(`  Old audit entries: ${status.oldAuditEntries} (>${auditDays} days)`);
          if (status.auditWarning) {
            console.log(`\n  ⚠️  ${status.auditWarning}`);
          }
          console.log('\n  Run without --dry-run to apply.\n');
          await app.stop();
          return;
        }

        const startTime = Date.now();
        const result = app.gcRun({
          sessionsDays,
          auditDays,
          auditForce: force,
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`  ✅ GC complete in ${elapsed}s\n`);
        console.log(`  Sessions closed:       ${result.sessionsClosed}`);
        console.log(`  Audit entries deleted: ${result.auditEntriesDeleted}${!force ? ' (use --force to enable)' : ''}`);
        console.log(`  Database vacuumed:     ${result.vacuumed ? 'yes' : 'no'}`);
        console.log('');

        await app.stop();
      } catch (err) {
        console.error(`GC failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown gc subcommand: ${sub}`);
      console.log('Usage: ved gc [run|status]');
      process.exit(1);
  }
}

/**
 * Manage webhooks.
 *
 * Usage:
 *   ved webhook list                           — List all webhooks
 *   ved webhook add <name> <url> [--secret s] [--events e1,e2] — Register a webhook
 *   ved webhook remove <name>                  — Remove a webhook
 *   ved webhook enable <name>                  — Enable a webhook
 *   ved webhook disable <name>                 — Disable a webhook
 *   ved webhook deliveries [name] [--limit n]  — View delivery history
 *   ved webhook stats                          — Delivery statistics
 *   ved webhook test <name>                    — Send a test event
 */
async function webhook(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
ved webhook — Manage webhook event delivery

Subcommands:
  list                                    List all registered webhooks
  add <name> <url> [--secret s] [--events e1,e2]  Register a new webhook
  remove <name|id>                        Remove a webhook
  enable <name|id>                        Enable a disabled webhook
  disable <name|id>                       Disable a webhook
  deliveries [name|id] [--limit n]        View delivery history
  stats                                   Show delivery statistics
  test <name|id>                          Send a test event to verify delivery
`.trim());
    return;
  }

  const app = createApp();
  await app.init();

  try {
    switch (sub) {
      case 'list': {
        const webhooks = app.webhookList();
        if (webhooks.length === 0) {
          console.log('No webhooks registered. Use "ved webhook add" to create one.');
          return;
        }
        console.log(`\n  Webhooks (${webhooks.length}):\n`);
        for (const wh of webhooks) {
          const status = wh.enabled ? '✓' : '✗';
          const types = wh.eventTypes.join(',');
          const secret = wh.secret ? '🔑' : '';
          console.log(`  ${status} ${wh.name} ${secret}`);
          console.log(`    URL: ${wh.url}`);
          console.log(`    Events: ${types}`);
          console.log(`    ID: ${wh.id}`);
          console.log();
        }
        break;
      }

      case 'add': {
        const name = args[1];
        const url = args[2];
        if (!name || !url) {
          console.error('Usage: ved webhook add <name> <url> [--secret <s>] [--events <e1,e2>]');
          process.exit(1);
        }

        let secret: string | undefined;
        let eventTypes: string[] | undefined;

        for (let i = 3; i < args.length; i++) {
          if ((args[i] === '--secret' || args[i] === '-s') && args[i + 1]) {
            secret = args[++i];
          } else if ((args[i] === '--events' || args[i] === '-e') && args[i + 1]) {
            eventTypes = args[++i].split(',').map(s => s.trim()).filter(Boolean);
          }
        }

        const wh = app.webhookAdd({ name, url, secret, eventTypes });
        console.log(`✓ Webhook registered: ${wh.name}`);
        console.log(`  ID: ${wh.id}`);
        console.log(`  URL: ${wh.url}`);
        console.log(`  Events: ${wh.eventTypes.join(',')}`);
        if (wh.secret) console.log('  Signing: HMAC-SHA256 ✓');
        break;
      }

      case 'remove': {
        const target = args[1];
        if (!target) {
          console.error('Usage: ved webhook remove <name|id>');
          process.exit(1);
        }
        const removed = app.webhookRemove(target);
        if (removed) {
          console.log(`✓ Webhook removed: ${target}`);
        } else {
          console.error(`Webhook not found: ${target}`);
          process.exit(1);
        }
        break;
      }

      case 'enable': {
        const target = args[1];
        if (!target) { console.error('Usage: ved webhook enable <name|id>'); process.exit(1); }
        const result = app.webhookToggle(target, true);
        if (result) {
          console.log(`✓ Webhook enabled: ${result.name}`);
        } else {
          console.error(`Webhook not found: ${target}`);
          process.exit(1);
        }
        break;
      }

      case 'disable': {
        const target = args[1];
        if (!target) { console.error('Usage: ved webhook disable <name|id>'); process.exit(1); }
        const result = app.webhookToggle(target, false);
        if (result) {
          console.log(`✓ Webhook disabled: ${result.name}`);
        } else {
          console.error(`Webhook not found: ${target}`);
          process.exit(1);
        }
        break;
      }

      case 'deliveries': {
        const target = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
        let limit = 20;
        for (let i = target ? 2 : 1; i < args.length; i++) {
          if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
            limit = parseInt(args[++i], 10);
          }
        }

        const deliveries = app.webhookDeliveries(target, limit);
        if (deliveries.length === 0) {
          console.log('No deliveries found.');
          return;
        }

        console.log(`\n  Deliveries (${deliveries.length}):\n`);
        for (const d of deliveries) {
          const statusIcon = d.status === 'success' ? '✓' : d.status === 'dead' ? '✗' : '…';
          const time = new Date(d.startedAt).toISOString().slice(0, 19);
          const dur = d.durationMs ? `${d.durationMs}ms` : '—';
          const code = d.statusCode ? `HTTP ${d.statusCode}` : '';
          console.log(`  ${statusIcon} [${time}] ${d.eventType} → ${d.status} ${code} (${dur}) attempt ${d.attempt}`);
          if (d.error) console.log(`    Error: ${d.error}`);
        }
        break;
      }

      case 'stats': {
        const stats = app.webhookStats();
        console.log('\n  Webhook Stats:\n');
        console.log(`  Webhooks:       ${stats.enabledWebhooks}/${stats.totalWebhooks} enabled`);
        console.log(`  Pending:        ${stats.pendingDeliveries}`);
        console.log(`  Failed:         ${stats.failedDeliveries}`);
        console.log(`  Dead:           ${stats.deadDeliveries}`);
        console.log(`  Success (24h):  ${stats.successfulLast24h}`);
        break;
      }

      case 'test': {
        const target = args[1];
        if (!target) {
          console.error('Usage: ved webhook test <name|id>');
          process.exit(1);
        }

        const wh = app.webhookGet(target);
        if (!wh) {
          console.error(`Webhook not found: ${target}`);
          process.exit(1);
          return; // unreachable but helps TS
        }

        console.log(`Sending test event to ${wh.name} (${wh.url})...`);

        // Emit a synthetic test event through the bus
        app.eventBus.emit({
          id: `test_${Date.now()}`,
          timestamp: Date.now(),
          type: 'startup' as any,
          actor: 'ved-cli',
          detail: { test: true, message: 'Webhook test delivery from ved CLI' },
          hash: 'test',
        });

        // Wait a moment for async delivery
        await new Promise(resolve => setTimeout(resolve, 3000));

        const deliveries = app.webhookDeliveries(target, 1);
        if (deliveries.length > 0) {
          const d = deliveries[0];
          if (d.status === 'success') {
            console.log(`✓ Test delivered! HTTP ${d.statusCode} (${d.durationMs}ms)`);
          } else {
            console.log(`✗ Delivery ${d.status}: ${d.error ?? `HTTP ${d.statusCode}`}`);
          }
        } else {
          console.log('⚠ No delivery recorded (webhook may not match event type filter)');
        }
        break;
      }

      default:
        console.error(`Unknown webhook subcommand: ${sub}`);
        console.log('Subcommands: list, add, remove, enable, disable, deliveries, stats, test');
        process.exit(1);
    }
  } finally {
    await app.stop();
  }
}

/**
 * Start the HTTP API server.
 *
 * Usage:
 *   ved serve                    — Start on default port (3141)
 *   ved serve --port 8080        — Custom port
 *   ved serve --host 0.0.0.0     — Bind to all interfaces
 *   ved serve --token <secret>   — Require Bearer token auth
 *   ved serve --cors '*'         — Set CORS origin
 */
async function serve(args: string[]): Promise<void> {
  let port = 3141;
  let host = '127.0.0.1';
  let apiToken = process.env.VED_API_TOKEN ?? '';
  let corsOrigin = '*';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port) || port <= 0 || port > 65535) {
        console.error('Error: --port must be between 1 and 65535');
        process.exit(1);
      }
      i++;
    } else if ((args[i] === '--host' || args[i] === '-h') && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if ((args[i] === '--token' || args[i] === '-t') && args[i + 1]) {
      apiToken = args[i + 1];
      i++;
    } else if (args[i] === '--cors' && args[i + 1]) {
      corsOrigin = args[i + 1];
      i++;
    } else {
      console.error(`Unknown serve flag: ${args[i]}`);
      console.log('Usage: ved serve [--port <N>] [--host <addr>] [--token <secret>] [--cors <origin>]');
      process.exit(1);
    }
  }

  console.log(`\nVed v${VERSION} — HTTP API Server\n`);

  try {
    const app = createApp();
    await app.init();

    const httpServer = new VedHttpServer(app, { port, host, apiToken, corsOrigin });
    const actualPort = await httpServer.start();

    console.log(`  🌐 Listening on http://${host}:${actualPort}`);
    console.log(`  Auth: ${apiToken ? '🔒 Bearer token required' : '🔓 No auth (use --token to enable)'}`);
    console.log(`  CORS: ${corsOrigin}`);
    console.log('');
    console.log('  Endpoints:');
    console.log('    GET  /api/health          Health check');
    console.log('    GET  /api/stats           System stats');
    console.log('    GET  /api/search?q=       RAG search');
    console.log('    GET  /api/history         Audit history');
    console.log('    GET  /api/vault/files     List vault files');
    console.log('    GET  /api/vault/file?path= Read vault file');
    console.log('    GET  /api/doctor          Run diagnostics');
    console.log('    POST /api/approve/:id     Approve work order');
    console.log('    POST /api/deny/:id        Deny work order');
    console.log('');
    console.log('  Press Ctrl+C to stop.\n');

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\n  Stopping...');
      await httpServer.stop();
      await app.stop();
      console.log('  Done.\n');
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise<void>(() => {});
  } catch (err) {
    console.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
