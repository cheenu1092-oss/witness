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

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { getConfigDir } from './core/config.js';
import { createLogger } from './core/log.js';

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
    case 'start':
    case 'run':
      return start();
    default:
      console.error(`Unknown command: ${command}`);
      console.log('Usage: ved [init|start|status|version]');
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
