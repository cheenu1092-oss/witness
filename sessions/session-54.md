# Session 54 — `ved export` + `ved import` CLI

**Date:** 2026-03-06
**Phase:** CYCLE (BUILD)

## What Happened

### 1. `ved export` CLI Command (NEW)
Exports the entire Obsidian vault to a portable JSON format:

```bash
ved export                              # JSON to stdout
ved export -o backup.json --pretty      # Pretty-printed to file
ved export --folder entities            # Export one folder only
ved export --include-audit --include-stats  # Include audit chain + system stats
```

**Features:**
- All vault files exported with frontmatter, body, and wikilinks
- `--folder <name>` — filter to a single folder (entities, concepts, daily, decisions)
- `--include-audit` — adds audit chain length, head hash, entry count
- `--include-stats` — adds RAG index, vault, session statistics
- `--pretty` / `-p` — human-readable JSON
- `-o <file>` / `--output <file>` — write to file (default: stdout)
- Pipe-friendly: `ved export | jq '.files | length'`

**Implementation:**
- `src/export-types.ts` — shared types (`VaultExport`, `VaultExportFile`, `ExportOptions`, `ImportResult`)
- `src/app.ts` — new `VedApp.exportVault(options?)` method
- `src/cli.ts` — new `export` command with full arg parser

### 2. `ved import` CLI Command (NEW)
Imports vault files from a JSON export:

```bash
ved import backup.json                  # Import (skip conflicts)
ved import backup.json --merge          # Skip existing files
ved import backup.json --overwrite      # Replace existing files
ved import backup.json --dry-run        # Preview without writing
cat backup.json | ved import -          # Import from stdin
```

**Features:**
- Three conflict modes: `fail` (default, skip conflicts), `merge` (skip existing), `overwrite` (replace existing)
- `--dry-run` — preview what would happen (NEW/SKIP/OVER/CONFLICT per file)
- Stdin support (`-` or `--stdin`)
- Format validation (checks vedVersion + files array)
- Path traversal protection: `assertPathSafe()` validates every import path BEFORE any I/O
- Graceful error handling: individual file failures don't abort the batch
- Summary output: created/overwritten/skipped/errors counts

**Implementation:**
- `src/app.ts` — new `VedApp.importVault(data, mode)` + `VedApp.vaultFileExists(path)` methods
- `src/memory/vault.ts` — new public `assertPathSafe()` method (exposes path containment check)
- `src/cli.ts` — new `import` command with full arg parser

### 3. Round-Trip Integrity
Export → Import → Re-export preserves all data exactly:
- Frontmatter (YAML), body (markdown), wikilinks all survive the round-trip
- Verified in tests with 5-file vault across all 4 folder types

### 4. Security: Path Traversal on Import
**Bug found during Docker testing:** `vault.exists()` didn't call `assertPathContained()`, allowing path traversal paths like `../../../etc/passwd` to bypass containment on import (they'd be detected by `exists()` as a real file and silently skipped instead of errored).

**Fix:** Import now calls `vault.assertPathSafe(path)` BEFORE any filesystem operations. Public `assertPathSafe()` added as wrapper around private `assertPathContained()`.

### 5. CLI Updated
```
Usage: ved [init|start|status|stats|search|reindex|config|export|import|version]
```
Ved CLI now has **10 commands**.

### 6. Tests
23 new tests covering:
- **Export (10):** structure, frontmatter+body+links, folder filter, audit, stats, both, empty vault, non-existent folder, JSON validity, uninitialized
- **Import (7):** new files into empty vault, merge mode, overwrite mode, fail mode, path traversal errors, uninitialized, empty export
- **Round-trip (1):** export→import→re-export data integrity
- **vaultFileExists (2):** existing + non-existing
- **Folder filtering (3):** entities, concepts, decisions

## Stats
- Tests: 1030/1030 pass (host + Docker parity)
- Type errors: 0
- New tests: 23
- Files changed: 5 (app.ts, cli.ts, export-types.ts, vault.ts, index.ts) + 2 test files
- Pushed to GitHub: 747e9b7
- Ved CLI now has 10 commands: init, start, status, stats, search, reindex, config, export, import, version
