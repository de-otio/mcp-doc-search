# MCP Doc Search

Semantic documentation search for any monorepo.

Large repos can have hundreds or thousands of markdown files of documentation. This extension helps developers manage them by enabling precise document retrieval—find and include only the relevant sections you need, dramatically reducing context bloat and token usage in AI assistant conversations.

- **VS Code extension**: type-ahead search in the command palette, auto-reindex on save, status bar indicator
- **MCP server**: `search_docs`, `list_docs`, `reindex_docs` tools so any MCP-compatible AI assistant can find the right document in a single call
- **Local embeddings**: auto-downloads `all-MiniLM-L6-v2` (ONNX, 22MB) on first use, then works fully offline — no API key required
- **Heading-aware chunking**: splits markdown on `#`/`##` boundaries, skips code fences, prepends document title as breadcrumb context
- **Hybrid search**: vector similarity + keyword re-ranking (+0.03 per matching term, camelCase-aware)

## Quick start

### Install the VS Code extension

Download the extension from the latest pipeline run.

```bash
code --install-extension mcp-doc-search-0.1.0.vsix
```

Or install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=skybber.mcp-doc-search) _(coming soon)_.

### Configure for your repo

Open VS Code settings and set:

| Setting                   | Default             | Description                                                  |
| ------------------------- | ------------------- | ------------------------------------------------------------ |
| `docSearch.docGlob`       | `doc/**/*.md`       | Glob pattern for docs to index                               |
| `docSearch.indexDir`      | `.doc-search-index` | Where to store the vector index (auto-added to `.gitignore`) |
| `docSearch.headingDepth`  | `2`                 | Split on `#` only (1) or `#` and `##` (2)                    |
| `docSearch.embedProvider` | `local`             | `local`, `ollama`, or `openai`                               |
| `docSearch.autoReindex`   | `true`              | Auto-reindex on file save                                    |

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
search_docs("map view feed design")     → finds relevant docs semantically
search_docs("map view feed", explain=true) → same, but with score breakdown
list_docs()                             → lists all indexed files
reindex_docs(force=true)               → full rebuild
```

## Embedding providers

| Provider          | Quality          | Setup                                                 | Cost            |
| ----------------- | ---------------- | ----------------------------------------------------- | --------------- |
| `local` (default) | Good (384-dim)   | None — ships with extension                           | Free            |
| `ollama`          | Better (768-dim) | `brew install ollama && ollama pull nomic-embed-text` | Free            |
| `openai`          | Best (1536-dim)  | Set `docSearch.openaiApiKey`                          | ~$0.02/M tokens |

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

# Per-file context notes (if supported by your indexer version)
mcp-doc-search context add doc/api.md "primary API reference"
mcp-doc-search context list
mcp-doc-search context remove doc/api.md
```

**Flags:** `--json` (machine-readable output), `--files` (paths only, for `search`/`multi-get`), `--explain` (score breakdown for `search`).

**Environment:** same as the MCP server — `DOC_SEARCH_WORKSPACE`, `DOC_SEARCH_GLOB`, `DOC_SEARCH_INDEX_DIR`, `USE_OPENAI=1`, `OLLAMA_URL`.

**Exit codes:** 0 = success, 1 = user error (bad args / missing file), 2 = engine error.

## Development

```bash
npm install
npm run build       # bundle extension.js + mcp-server.js
npm test            # 46 unit tests
npm run test:coverage  # coverage report (100% line coverage)
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
  mcp/           # Standalone MCP server (spawned by any MCP client)
```

Two build outputs:

- `dist/extension.js` — VS Code extension host
- `dist/mcp-server.js` — standalone Node.js MCP server

## License

MIT
