# MCP Doc Search

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/de-otio.mcp-doc-search?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=de-otio.mcp-doc-search)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/de-otio.mcp-doc-search)](https://marketplace.visualstudio.com/items?itemName=de-otio.mcp-doc-search)
[![CI](https://github.com/de-otio/mcp-doc-search/actions/workflows/ci.yml/badge.svg)](https://github.com/de-otio/mcp-doc-search/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Semantic documentation search for any monorepo.

Large repos can have hundreds or thousands of markdown files of documentation. This extension helps developers manage them by enabling precise document retrieval—find and include only the relevant sections you need, dramatically reducing context bloat and token usage in AI assistant conversations.

- **VS Code extension**: type-ahead search in the command palette, auto-reindex on save, status bar indicator
- **MCP server**: `search_docs`, `list_docs`, `reindex_docs`, `get`, `multi_get`, plus per-file `set_context` / `list_contexts` / `remove_context` tools so any MCP-compatible AI assistant can find and read the right document in a single call
- **Local embeddings**: auto-downloads `all-MiniLM-L6-v2` (ONNX, 22MB) on first use, then works fully offline — no API key required
- **Heading-aware chunking**: splits markdown on `#`/`##` boundaries, skips code fences, prepends document title as breadcrumb context
- **Hybrid search**: vector similarity + keyword re-ranking (+0.03 per matching term, camelCase-aware)

## Quick start

### Install the VS Code extension

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=de-otio.mcp-doc-search):

```bash
code --install-extension de-otio.mcp-doc-search
```

Or grab a per-platform VSIX from the [latest GitHub Release](https://github.com/de-otio/mcp-doc-search/releases/latest):

```bash
code --install-extension mcp-doc-search-<target>-<version>.vsix
```

### Configure for your repo

Open VS Code settings and set:

| Setting                   | Default             | Description                                                                                  |
| ------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `docSearch.indexLocation` | `global`            | Where to store the index: `global` (default, under `~/.doc-search`) or `workspace` (in-tree) |
| `docSearch.docGlob`       | `doc/**/*.md`       | Glob pattern for docs to index                                                               |
| `docSearch.indexDir`      | `.doc-search-index` | Workspace mode only: where to store the vector index                                         |
| `docSearch.headingDepth`  | `2`                 | Split on `#` only (1) or `#` and `##` (2)                                                    |
| `docSearch.embedProvider` | `local`             | `local`, `ollama`, or `openai`                                                               |
| `docSearch.autoReindex`   | `true`              | Auto-reindex on file save                                                                    |

**Index location:** By default, the search index is stored under `~/.doc-search/indexes/` (outside your project tree) and automatically migrates any existing `.doc-search-index` folder on first run. To use the legacy in-tree location, set `docSearch.indexLocation` to `workspace`.

### Use it

- **Cmd+Shift+P → "Doc Search: Reindex Documentation"** — build the initial index (takes ~30s for large repos)
- **Cmd+Shift+P → "Doc Search: Search Documentation"** — type-ahead semantic search, click a result to open it
- **Cmd+Shift+P → "Doc Search: Generate .mcp.json"** — creates `.mcp.json` so any MCP client can use the same index

### Understanding scores

Each result includes a `score` (0–1) computed from vector similarity plus keyword re-ranking:

| Score   | Meaning             |
| ------- | ------------------- |
| 0.8–1.0 | Highly relevant     |
| 0.5–0.8 | Moderately relevant |
| 0.2–0.5 | Somewhat relevant   |
| 0.0–0.2 | Low relevance       |

Pass `explain: true` to `search_docs` to get a detailed breakdown:

- `vectorScore` — raw cosine similarity from embeddings
- `keywordTermsMatched` — query terms found in the chunk
- `keywordBonus` — boost applied (+0.03 per matching term)
- `finalScore` — combined score (same as `score`)
- `rank` — position in result list (1-indexed)

### MCP integration

After running "Generate .mcp.json", connect any MCP-compatible client (Claude Code, Cursor, etc.). The MCP tools appear automatically:

```
search_docs("authentication flow")               → semantic search
search_docs("authentication", explain=true)      → same, with per-result score breakdown
list_docs()                                       → list every indexed file
get("doc/api.md")                                → read one file (full text)
multi_get("doc/**/auth*.md")                     → read many files in one call
reindex_docs(force=true)                         → full rebuild

# Per-file context notes the indexer carries alongside chunks
set_context("doc/api.md", "primary API reference")
list_contexts()
remove_context("doc/api.md")
```

## Embedding providers

| Provider          | Quality          | Setup                                                 | Cost            |
| ----------------- | ---------------- | ----------------------------------------------------- | --------------- |
| `local` (default) | Good (384-dim)   | None — ships with extension                           | Free            |
| `ollama`          | Better (768-dim) | `brew install ollama && ollama pull nomic-embed-text` | Free            |
| `openai`          | Best (1536-dim)  | Enter the key in the Doc Search Settings panel        | ~$0.02/M tokens |

The OpenAI API key is stored in VS Code's SecretStorage (the OS keychain) — never in `settings.json`. For the standalone MCP server and CLI, set the `OPENAI_API_KEY` environment variable in your `.mcp.json` `env` block or shell; the generated `.mcp.json` (via **Doc Search: Generate .mcp.json**) copies the key from SecretStorage into that block for you.

## CLI

A standalone CLI is included — no MCP client required.

```bash
# Semantic search
mcp-doc-search search "authentication flow" --n 5
mcp-doc-search search "map view feed" --files          # one path per line
mcp-doc-search search "query" --min-score 0.7 --json   # JSON output

# Browse the index
mcp-doc-search list
mcp-doc-search list --json

# Rebuild the index
mcp-doc-search reindex
mcp-doc-search reindex --force   # re-embed every file

# Read files from the workspace
mcp-doc-search get doc/api.md
mcp-doc-search get doc/api.md --from-line 20 --max-lines 50

# Read multiple files (glob or comma list)
mcp-doc-search multi-get "doc/**/*.md" --files         # list matched paths
mcp-doc-search multi-get "doc/a.md,doc/b.md" --json

# Index health
mcp-doc-search status
mcp-doc-search status --json

# Per-file context notes carried alongside the index
mcp-doc-search context add doc/api.md "primary API reference"
mcp-doc-search context list
mcp-doc-search context remove doc/api.md
```

**Flags:** `--json` (machine-readable output), `--files` (paths only, for `search`/`multi-get`), `--explain` (score breakdown for `search`).

**Environment:** same as the MCP server — `DOC_SEARCH_WORKSPACE`, `DOC_SEARCH_GLOB`, `DOC_SEARCH_INDEX_DIR`, `USE_OPENAI=1`, `OLLAMA_URL`.

**Exit codes:** 0 = success, 1 = user error (bad args / missing file), 2 = engine error.

## HTTP daemon mode

By default, each MCP client spawns the server as a short-lived stdio subprocess. The embed model takes ~1–2 s to load on cold start. Running a long-lived HTTP daemon amortises that cost across all clients.

### Start the daemon

```bash
# One-shot foreground (useful for smoke-testing)
node dist/mcp-server.js --http --port 8181

# Detached daemon (parent exits, child runs in background)
node dist/mcp-server.js --http --port 8181 --daemon
# → MCP daemon started (PID: 12345, port: 8181)

# Verify it's up
curl http://localhost:8181/health
# → {"status":"ok","uptime":3.1}
```

### Stop the daemon

```bash
node dist/mcp-server.js --stop
# → stopped (PID: 12345)
```

### Point Claude Code at the HTTP endpoint

Edit your `.mcp.json` (or `~/.claude.json`) to use the `http` transport:

```json
{
  "mcpServers": {
    "doc-search": {
      "type": "http",
      "url": "http://localhost:8181/mcp"
    }
  }
}
```

**vs stdio transport** (the default, spawns a new process per client):

```json
{
  "mcpServers": {
    "doc-search": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js"],
      "env": { "DOC_SEARCH_WORKSPACE": "/path/to/your/repo" }
    }
  }
}
```

### Idle model disposal

After 5 minutes of inactivity, the daemon automatically releases the embed pipeline from memory. The next request transparently reloads it (~1 s penalty), then stays fast again.

## Development

```bash
npm install
npm run build       # bundle extension.js + mcp-server.js
npm test            # unit tests
npm run test:coverage  # coverage report
npm run package     # build .vsix for current platform
```

### Platform-specific builds

LanceDB ships native binaries. Build for each platform:

```bash
npm run package:darwin-arm  # macOS Apple Silicon
npm run package:darwin-x64  # macOS Intel
npm run package:linux-x64   # Linux
npm run package:win-x64     # Windows
```

## Architecture

```
src/
  core/          # Shared engine (no VS Code or MCP deps)
    types.ts     # DocChunk, SearchResult, EmbedProvider interfaces
    chunker.ts   # Markdown heading-aware chunking with fence detection
    embedder.ts  # LocalEmbedder, OllamaEmbedder, OpenAIEmbedder
    vectorstore.ts  # LanceDB wrapper (file-backed, cosine metric)
    searcher.ts  # Hybrid search: vector + keyword re-ranking
    indexer.ts   # Crawl, chunk, embed, upsert with mtime cache
  extension/     # VS Code extension shell
  mcp/           # MCP server: stdio + HTTP daemon transports
bin/             # Standalone CLI entry point
```

Three build outputs:

- `dist/extension.js` — VS Code extension host
- `dist/mcp-server.js` — standalone Node.js MCP server (stdio / HTTP daemon)
- `dist/mcp-doc-search.js` — standalone CLI binary

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
test, and PR conventions. By participating you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

If you believe you've found a security issue, please follow the disclosure
process in [SECURITY.md](SECURITY.md). Do not open a public GitHub issue for
suspected vulnerabilities.

## License

MIT — see [LICENSE](LICENSE).
