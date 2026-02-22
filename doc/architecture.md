# Architecture

## Overview

MCP Doc Search follows a layered architecture with a framework-agnostic core and two thin integration layers:

```
┌─────────────────────┐   ┌─────────────────────┐
│   VS Code Extension │   │     MCP Server       │
│  (src/extension/)   │   │    (src/mcp/)        │
└────────┬────────────┘   └────────┬──────────────┘
         │                         │
         └──────────┬──────────────┘
                    │
         ┌──────────▼──────────────┐
         │      Core Engine        │
         │     (src/core/)         │
         │                         │
         │  chunker → embedder     │
         │      ↓         ↓        │
         │  indexer → vectorstore  │
         │      ↓                  │
         │   searcher              │
         └─────────────────────────┘
                    │
         ┌──────────▼──────────────┐
         │   LanceDB (file-backed) │
         └─────────────────────────┘
```

## Core Engine (`src/core/`)

The core has zero dependencies on VS Code or MCP APIs. All components communicate through interfaces defined in `types.ts`.

### Types (`types.ts`)

Key interfaces:

- **`DocChunk`** — a single indexed chunk with `id`, `text`, `file`, `heading`, `lineStart`
- **`SearchResult`** — extends `DocChunk` with `score`
- **`IndexStatus`** — index health: file count, chunk count, last indexed time
- **`EmbedProvider`** — interface for embedding providers: `embed(texts[]) → number[][]`
- **`IndexerConfig`** — configuration for the indexer

### Chunker (`chunker.ts`)

Splits markdown files into chunks at heading boundaries:

1. **Fence detection** — `findFenceRanges()` identifies code fence line ranges to avoid splitting inside code blocks
2. **Heading scan** — walks lines, identifies `#`/`##` headings (respecting `headingDepth`), skips headings inside fences
3. **Chunk extraction** — extracts text between consecutive headings, prepends document title for context
4. **ID generation** — creates stable IDs via `MD5(file:lineNumber).slice(0, 12)`, enabling safe re-indexing

### Embedder (`embedder.ts`)

Three embedding providers behind a common `EmbedProvider` interface:

- **`LocalEmbedder`** — `@huggingface/transformers` with `all-MiniLM-L6-v2` (384-dim ONNX). Adds `search_document:` / `search_query:` prefixes.
- **`OllamaEmbedder`** — HTTP calls to a local Ollama server (768-dim default).
- **`OpenAIEmbedder`** — OpenAI API with `text-embedding-3-small` (1536-dim).

Factory function `createEmbedProvider(config)` instantiates the correct provider.

### Vector Store (`vectorstore.ts`)

Wraps `@lancedb/lancedb` with a file-backed database:

- **Cosine distance** metric for similarity
- **Operations:** `upsert`, `query`, `deleteByFile`, `listFiles`, `count`
- **Schema:** `{id, text, file, heading, lineStart, vector}`
- No server process — reads/writes directly to disk

### Indexer (`indexer.ts`)

Orchestrates the full indexing pipeline:

1. **Crawl** — glob for matching files
2. **mtime check** — skip files unchanged since last index (reads `mtime_cache.json`)
3. **Chunk** — split each file via the chunker
4. **Embed** — batch embed chunk texts
5. **Delete + Upsert** — remove old chunks for the file, insert new ones
6. **Cache** — write updated mtimes

Progress callbacks report `(processed, total, file, phase)` where phase is `scanning`, `loading`, or `indexing`.

### Searcher (`searcher.ts`)

Hybrid search combining vector similarity with keyword re-ranking:

1. **Embed** the query with `search_query:` prefix
2. **Vector search** — fetch 3x candidates from LanceDB (cosine distance)
3. **Keyword boost** — tokenize query (with camelCase expansion), count term matches in each chunk, add `hits * 0.03` to the score
4. **Re-rank** — sort by final score, return top N

The keyword boost prevents purely semantic matches from dominating when exact terms appear in the documentation.

## VS Code Extension (`src/extension/`)

Thin integration layer providing UI and lifecycle management:

- **`extension.ts`** — entry point. Creates core components on activation, registers commands, starts file watcher.
- **`config.ts`** — reads `docSearch.*` settings from VS Code configuration.
- **`commands.ts`** — registers 6 commands (search, reindex, status, settings, walkthrough, generate MCP config).
- **`searchPanel.ts`** — quick-pick UI with 300ms debounced input. Shows up to 10 results with file, heading, and text excerpt.
- **`settingsPanel.ts`** — webview panel for visual settings editing.
- **`indexStatusPanel.ts`** — webview showing index health (file count, chunk count, last indexed, needs reindex flag).
- **`statusBar.ts`** — status bar item showing ready/indexing/error state.
- **`fileWatcher.ts`** — watches `docGlob` files, triggers incremental reindex on save.

## MCP Server (`src/mcp/`)

Standalone process that Claude Code spawns as a subprocess:

- **`server.ts`** — creates MCP server with `StdioServerTransport`, initializes engine from environment
- **`tools.ts`** — registers 3 MCP tools:
  - `search_docs(query, n?)` — semantic search
  - `list_docs()` — list all indexed files
  - `reindex_docs(force?)` — trigger reindex
- **`config.ts`** — reads environment variables, creates embedder/store/indexer

The MCP server shares the same LanceDB index directory as the extension, so both stay in sync.

## Build Pipeline

Two separate esbuild configurations produce CommonJS bundles:

```
src/extension/extension.ts  →  esbuild  →  dist/extension.js   (VS Code)
src/mcp/server.ts           →  esbuild  →  dist/mcp-server.js  (MCP)
```

External dependencies (not bundled):
- `vscode` — provided by the VS Code runtime
- `@lancedb/lancedb` — native bindings, must ship as-is
- `@huggingface/transformers` — large dependency, loaded at runtime

Both outputs are CommonJS (`format: "cjs"`) because VS Code requires it.

## Data Flow

### Indexing

```
Markdown files
    ↓ glob
File list
    ↓ mtime filter
Changed files
    ↓ chunkMarkdown()
DocChunk[]
    ↓ embedder.embed()
DocChunk[] + vectors
    ↓ store.deleteByFile() + store.upsert()
LanceDB table
    ↓ write mtime_cache.json
Done
```

### Searching

```
User query
    ↓ embedder.embed()
Query vector
    ↓ store.query(vector, n*3)
Candidate chunks (over-fetched)
    ↓ keywordBoost()
Scored candidates
    ↓ sort + slice(0, n)
Top N results
```
