# Session 29 — BUILD: ved-llm + Bug Fix

**Date:** 2026-03-05  
**Phase:** BUILD (1 of ~6)  
**Duration:** ~15 min  

## What Happened

### 1. Assessment: Foundation Already Built
Discovered that the foundation modules from STATE.md's Session 29 plan (types, db, audit, trust) were already fully implemented with 282 passing tests from earlier sessions. The core, memory, and vault modules were also complete. Advanced directly to the next logical build target: **ved-llm**.

### 2. Bug Fix: Empty Frontmatter Parsing
- **Bug:** `parseMarkdown` regex `FRONTMATTER_RE` didn't match `---\n---` (empty frontmatter)
- **Root cause:** Regex required `\n` between content and closing `---`, but empty frontmatter has no content
- **Fix:** Made the capture group optional: `([\s\S]*?\n)?` instead of `([\s\S]*?)\r?\n`
- **Result:** 22/22 markdown tests pass

### 3. Built: ved-llm Module (~1K LoC)

**Files created:**
- `src/llm/types.ts` (110 lines) — LLM-specific interfaces
- `src/llm/anthropic.ts` (236 lines) — Claude API adapter
- `src/llm/openai.ts` (255 lines) — OpenAI + OpenRouter adapter
- `src/llm/ollama.ts` (204 lines) — Ollama local inference adapter
- `src/llm/client.ts` (197 lines) — Multi-provider LLMClient
- `src/llm/index.ts` (26 lines) — Module exports
- `src/llm/llm.test.ts` (615 lines) — 37 tests

**Key features:**
- **Multi-provider:** Anthropic, OpenAI, OpenRouter, Ollama — all with tool use support
- **Provider adapters:** Each adapter handles format conversion (Anthropic's separate system prompt, OpenAI's function calling, Ollama's /api/chat)
- **Session usage tracking:** Accumulates token counts across calls
- **Budget enforcement:** Throws `LLM_BUDGET_EXCEEDED` when session token limit hit
- **compress():** T1→T2 memory compression via LLM
- **extract():** Entity/fact extraction from conversations for T3

### 4. Added .gitignore
Excluded node_modules/, dist/, .swarm/, *.db files from git tracking.

## Test Results
```
Test Files  12 passed (12)
     Tests  319 passed (319)
  Duration  2.57s
```

## What's Next (Session 30)
Build `ved-mcp` (MCP tool client) and `ved-rag` (RAG pipeline). These are the last two modules before channels, which will make Ved functional end-to-end.

## Code Stats
- Source: ~6,004 LoC (across 25 files)
- Tests: ~3,477 LoC (across 12 test files)
- 319 tests, 0 failures
- 3 external deps (better-sqlite3, ulid, yaml)
