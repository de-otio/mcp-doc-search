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
- **Operations:** `upsert`, `query`, `deleteByFile`, `dropTable`, `listFiles`, `count`
- **Schema:** `{id, text, file, fileHash, heading, lineStart, vector, docid}` —
  `fileHash` is the SHA-256 of `file`; `deleteByFile` filters on it so index
  keys of any shape (`ext://…`, spaces, non-ASCII) can be deleted without
  escaping. A failed delete is logged and rethrown, never swallowed.
- No server process — reads/writes directly to disk

### Indexer (`indexer.ts`)

Orchestrates the full indexing pipeline:

1. **Lock** — take `<indexDir>/reindex.lock` (`O_EXCL`, pid + start time); a
   live holder makes the run throw `ReindexInProgressError`, a dead one is
   replaced. Released in `finally`, after compaction.
2. **Crawl** — glob for matching files
3. **Metadata check** — compare `index-meta.json` (schema version, provider,
   model, vector dimension, `maxChunkChars`, `headingDepth`) with the live
   config; on any difference, or on a non-empty index with no metadata, drop
   the table and the mtime cache and re-embed everything (`rebuiltReason`)
4. **mtime check** — skip files unchanged since last index (reads `mtime_cache.json`)
5. **Chunk** — split each file via the chunker
6. **Embed** — batch embed chunk texts
7. **Delete + Upsert** — remove old chunks for the file, insert new ones
8. **Cache** — write updated mtimes (temp file + rename, like every JSON file
   in the index directory)

Progress callbacks report `(processed, total, file, phase)` where phase is `scanning`, `loading`, or `indexing`.

### Searcher (`searcher.ts`)

Hybrid search fusing vector similarity with a full-text index:

1. **Embed** every query (the primary `query` plus any `queries`, at most 5) with the `search_query:` prefix, in one batch
2. **Vector search** — per query, fetch the top 3n candidates from LanceDB (cosine distance, capped at 300)
3. **Full-text search** — per query, fetch the top 3n BM25 matches from LanceDB's inverted index on `text` (literal, lowercased tokens; no stemming)
4. **Fuse** — reciprocal rank fusion (`1 / (60 + rank)` summed over every list), deterministic tie-break on similarity
5. **Return** the top N; `score` is the chunk's cosine similarity, the order is the RRF order

A chunk the embedding misses but the exact terms hit is recovered through the full-text list. If the table has no full-text index yet (or it is stale mid-reindex) the full-text side is skipped with a warning and ranking is vector-only.

The full-text index is maintained by the indexer: it is rebuilt at the end of every `reindex()` that wrote or pruned rows (LanceDB 0.13 leaves stale postings behind after deletes, which can make a query fail), and the store rebuilds it again after compaction, which invalidates the inverted index's row mapping.

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

Standalone process that an MCP client spawns as a subprocess:

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
    ↓ write mtime_cache.json (+ index-meta.json on a fresh or rebuilt index)
Done
```

### Searching

```
User query (+ optional alternative phrasings)
    ↓ embedder.embed()
Query vectors
    ↓ store.query(vector, n*3)        ↓ store.fullTextQuery(text, n*3)
Vector candidates (per query)        Full-text candidates (per query)
    ↓ rrfFuse()  — 1 / (60 + rank) summed over every list
Fused candidates
    ↓ slice(0, n)
Top N results (score = cosine similarity, order = RRF)
```
