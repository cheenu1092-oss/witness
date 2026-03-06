# Changelog

All notable changes to Ved are documented here.

## [0.1.0] — 2026-03-06

### Architecture
- Single-threaded event loop with 7-step message pipeline
- 4-tier hierarchical memory: Working (RAM) → Episodic (Obsidian daily notes) → Semantic (Obsidian knowledge graph) → Archival (SQLite + RAG)
- Hash-chain audit log with HMAC external anchoring
- 4-tier trust engine with human-in-the-loop approval queues
- MCP-native tool integration
- Multi-provider LLM client (OpenAI, Anthropic, Ollama)

### Modules
- **ved-core** — Event loop, session manager, compressor, idle timer
- **ved-audit** — Hash-chain store, HMAC anchoring
- **ved-trust** — Risk assessment, work orders, trust ledger
- **ved-memory** — Vault manager (Obsidian), working memory, T1→T2 compression
- **ved-rag** — RAG pipeline: embed (nomic-embed-text), FTS5, vector search, fusion ranking
- **ved-llm** — Multi-provider LLM client with streaming
- **ved-mcp** — MCP client for tool discovery and execution
- **ved-channel** — Discord adapter + CLI

### Security
- 17 vulnerabilities found and fixed across 5 red-team phases
- 927+ tests including adversarial red-team suites
- Content filter: 11 sensitive data patterns + NFKC normalization + zero-width char stripping
- Path traversal protection on all vault I/O methods
- SQL injection protection (parameterized queries throughout)
- ReDoS resistance verified (100K input <100ms)
- Trust escalation prevention (immutable config floor, owner-only grants)

### CLI
- Interactive REPL with `/help`, `/status`, `/clear`
- `ved init` — scaffold Obsidian vault structure + config template
- Approval commands: `approve <id>`, `deny <id> [reason]`, `pending`

### Open Source
- MIT License
- CONTRIBUTING.md with development guide
- Docker-based testing (host + Docker parity verified)
- README with architecture overview and quickstart

### Fixed
- GAP-4: U+2061-U+2064 invisible math operators now stripped by content filter
- All 17 CVEs documented in session logs with fix references
