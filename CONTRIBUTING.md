# Contributing to Ved

Thanks for your interest in contributing! Ved is open source under the MIT license.

## Getting Started

```bash
git clone https://github.com/cheenu1092-oss/ved.git
cd ved
npm install
npm run build
npm test
```

## Development

### Prerequisites

- Node.js 20+
- Docker (for integration tests)
- Ollama with `nomic-embed-text` (for RAG features)

### Project Structure

```
src/
├── audit/        # Hash-chain audit log
├── channel/      # Discord + CLI adapters
├── core/         # Event loop, session, compressor
├── db/           # SQLite + migrations
├── llm/          # Multi-provider LLM client
├── mcp/          # MCP tool router
├── memory/       # 4-tier memory (vault, working, RAG)
├── rag/          # RAG pipeline (embed, index, search)
├── trust/        # Trust engine + HITL approval
└── types/        # TypeScript types
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm test` | Run tests (watch mode) |
| `npm run test:run` | Run tests once |
| `npm run docker:build` | Build Docker image |
| `npm run docker:test` | Run tests in Docker |

### Testing

We aim for high test coverage. The test suite includes:

- **Unit tests** — per-module (927+ tests)
- **Integration tests** — full pipeline e2e
- **Red-team tests** — adversarial security testing

When adding a feature, include tests. When fixing a bug, add a regression test.

```bash
# Run specific test file
npx vitest run src/session-s47.test.ts

# Run tests matching a pattern
npx vitest run -t "content filter"
```

### Docker Testing

All builds and tests should pass in Docker to ensure environment consistency:

```bash
npm run docker:build
npm run docker:test
```

## Pull Request Process

1. Fork the repo and create a feature branch
2. Write code + tests
3. Ensure all tests pass (`npm run test:run`)
4. Ensure TypeScript compiles (`npm run build`)
5. Submit a PR with a clear description of what and why

### Commit Messages

Use clear, descriptive commit messages:

```
fix: strip U+2061-U+2064 invisible math chars in content filter (GAP-4)
feat: add Discord typing indicators
test: add regression tests for VULN-17 fix
```

## Security

If you discover a security vulnerability, please **do not** open a public issue. Instead, email cheenu1092@gmail.com with details. We take security seriously — Ved's audit-first design means we hold ourselves to a high bar.

## Code Style

- TypeScript strict mode
- No `any` types (use `unknown` + type guards)
- Prefer pure functions where possible
- Every state mutation must be auditable

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
