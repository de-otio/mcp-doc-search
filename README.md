# MCP Doc Search

Semantic documentation search for any monorepo.

- **VS Code extension**: type-ahead search in the command palette, auto-reindex on save, status bar indicator
- **Claude Code MCP server**: `search_docs`, `list_docs`, `reindex_docs` tools so Claude can find the right document in a single call
- **Local embeddings**: ships with `all-MiniLM-L6-v2` (ONNX, 22MB) — no API key, no internet, works offline
- **Heading-aware chunking**: splits markdown on `#`/`##` boundaries, skips code fences, prepends document title as breadcrumb context
- **Hybrid search**: vector similarity + keyword re-ranking (+0.03 per matching term, camelCase-aware)

## Quick start

### Install the VS Code extension

```bash
code --install-extension mcp-doc-search-0.1.0.vsix
```

Or install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=skybber.mcp-doc-search) _(coming soon)_.

### Configure for your repo

Open VS Code settings and set:

| Setting | Default | Description |
|---------|---------|-------------|
| `docSearch.docGlob` | `doc/**/*.md` | Glob pattern for docs to index |
| `docSearch.indexDir` | `.doc-search-index` | Where to store the vector index (auto-added to `.gitignore`) |
| `docSearch.headingDepth` | `2` | Split on `#` only (1) or `#` and `##` (2) |
| `docSearch.embedProvider` | `local` | `local`, `ollama`, or `openai` |
| `docSearch.autoReindex` | `true` | Auto-reindex on file save |

### Use it

- **Cmd+Shift+P → "Doc Search: Reindex Documentation"** — build the initial index (takes ~30s for large repos)
- **Cmd+Shift+P → "Doc Search: Search Documentation"** — type-ahead semantic search, click a result to open it
- **Cmd+Shift+P → "Doc Search: Generate .mcp.json for Claude Code"** — creates `.mcp.json` so Claude Code can use the same index

### Claude Code integration

After running "Generate .mcp.json", restart Claude Code. The MCP tools appear automatically:

```
search_docs("map view feed design")     → finds relevant docs semantically
list_docs()                             → lists all indexed files
reindex_docs(force=true)               → full rebuild
```

## Embedding providers

| Provider | Quality | Setup | Cost |
|----------|---------|-------|------|
| `local` (default) | Good (384-dim) | None — ships with extension | Free |
| `ollama` | Better (768-dim) | `brew install ollama && ollama pull nomic-embed-text` | Free |
| `openai` | Best (1536-dim) | Set `docSearch.openaiApiKey` | ~$0.02/M tokens |

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
  mcp/           # Standalone MCP server (Claude Code spawns this)
```

Two build outputs:
- `dist/extension.js` — VS Code extension host
- `dist/mcp-server.js` — standalone Node.js MCP server

## License

MIT
