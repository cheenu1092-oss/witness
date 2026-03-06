# Session 50 — CI Workflow Upload + Vault Watcher Integration

**Date:** 2026-03-06
**Phase:** CYCLE (BUILD)

## What Happened

### 1. CI Workflow Uploaded via GitHub Web UI
- `gh` CLI and GitHub API both blocked by missing `workflow` scope on OAuth token
- Used OpenClaw browser to upload `.github/workflows/ci.yml` directly via GitHub web editor
- Committed to main, CI triggered automatically
- **All 4 jobs passed on first run:** Test (Node 20), Test (Node 22), Docker Build + Test, Lint + Type Check

### 2. Vault Watcher → RAG Re-index Integration (NEW FEATURE)
Built the missing wiring between VaultManager filesystem watching and RAG pipeline re-indexing:

**Changes to `src/app.ts`:**
- `startVaultWatcher()`: Registers `onFileChanged` handler on VaultManager that:
  - Calls `rag.enqueueReindex(path)` on create/update
  - Calls `rag.removeFile(path)` on delete
- Starts `vault.startWatch()` for filesystem monitoring
- Runs a 10-second `setInterval` drain loop that processes the re-index queue
- Timer is `.unref()`'d so it doesn't prevent graceful shutdown
- `stopVaultWatcher()`: Clears interval + stops vault watch on shutdown

**Why this matters:**
Before this, vault file changes (from human Obsidian edits) were never picked up by RAG. Now:
1. User edits a note in Obsidian → filesystem watcher detects it
2. VaultManager debounces (500ms) and emits change event
3. Change handler enqueues file for RAG re-index
4. Every 10s, drain loop re-chunks + re-embeds + updates FTS + graph edges
5. Next query uses updated knowledge

### 3. Tests
- 10 new vault watcher integration tests
- Handler routing (create/update → enqueue, delete → remove)
- Rapid change handling + Set deduplication
- Mixed change sequences
- Drain loop mechanics (success, failure, idempotent empty)
- unref() pattern verification

## Stats
- Tests: 961/961 pass (host + Docker parity)
- Type errors: 0
- New tests: 10
- CI: ✅ All 4 jobs green

## Next Session (51)
- Push session 50 changes to GitHub
- Feature work: `ved reindex` CLI command (force full re-index), or initial full-index on startup
- Consider: vault initial indexing during `ved start` (index all existing vault files before entering event loop)
