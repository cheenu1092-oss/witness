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
import { createApp } from './app.js';
import { getConfigDir, loadConfig, validateConfig } from './core/config.js';
import { createLogger } from './core/log.js';
import type { MergedResult } from './rag/types.js';
import type { VaultExport } from './export-types.js';

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
    case 'start':
    case 'run':
      return start();
    default:
      console.error(`Unknown command: ${command}`);
      console.log('Usage: ved [init|start|status|stats|search|reindex|config|export|import|history|doctor|version]');
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
