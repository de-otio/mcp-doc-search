# Configuration

All settings use the `docSearch.*` namespace and can be configured via VS Code Settings or the built-in settings panel (**Doc Search: Open Settings**).

## Settings Reference

### docSearch.docGlob

- **Type:** `string`
- **Default:** `doc/**/*.md`

Glob pattern for files to index. Supports standard glob syntax relative to the workspace root.

Examples:

```
doc/**/*.md           # Default — doc/ folder
docs/**/*.md          # Alternative docs/ folder
**/*.md               # All markdown in workspace
src/**/*.md,wiki/**   # Multiple patterns
```

### docSearch.indexDir

- **Type:** `string`
- **Default:** `.doc-search-index`

Directory where the vector index (LanceDB) and mtime cache are stored. Relative to the workspace root. This path is automatically added to `.gitignore` on first run.

### docSearch.headingDepth

- **Type:** `number`
- **Default:** `2`

Controls which heading levels trigger chunk splits:

- `1` — Split only on `#` (h1) headings
- `2` — Split on `#` (h1) and `##` (h2) headings

Lower depth means larger chunks with more context. Higher depth means smaller, more precise chunks.

### docSearch.maxChunkChars

- **Type:** `number`
- **Default:** `4000`

Maximum characters per chunk. Chunks exceeding this limit are truncated. Most embedding models work best with chunks under 512 tokens (~2000 characters), but the default is set higher to preserve context. The local model handles up to 512 tokens natively.

### docSearch.embedProvider

- **Type:** `enum`
- **Default:** `local`
- **Options:** `local`, `ollama`, `openai`

Which embedding provider to use:

| Provider | Model                  | Dimensions | Notes                                                          |
| -------- | ---------------------- | ---------- | -------------------------------------------------------------- |
| `local`  | all-MiniLM-L6-v2       | 384        | No setup required. ONNX model (~22MB) downloaded on first use. |
| `ollama` | Configurable           | 768        | Requires a running Ollama server.                              |
| `openai` | text-embedding-3-small | 1536       | Requires API key. Best quality.                                |

Changing the provider requires a full reindex since embedding dimensions differ.

### docSearch.ollamaUrl

- **Type:** `string`
- **Default:** `http://localhost:11434`

URL of the Ollama server. Only used when `embedProvider` is set to `ollama`.

### docSearch.ollamaModel

- **Type:** `string`
- **Default:** `nomic-embed-text`

Ollama model to use for embeddings. Only used when `embedProvider` is set to `ollama`.

### docSearch.openaiApiKey

- **Type:** `string`
- **Default:** (empty)

OpenAI API key. Only used when `embedProvider` is set to `openai`. Store securely — consider using VS Code's secret storage or environment variables.

### docSearch.autoReindex

- **Type:** `boolean`
- **Default:** `true`

When enabled, the extension automatically reindexes files when they are saved. Only changed files are re-embedded (incremental).

## Commands

| Command               | ID                          | Description                                        |
| --------------------- | --------------------------- | -------------------------------------------------- |
| Search Documentation  | `docSearch.search`          | Opens a quick-pick with type-ahead semantic search |
| Reindex Documentation | `docSearch.reindex`         | Reindex with choice of incremental or full         |
| Open Index Status     | `docSearch.openIndexStatus` | View index health and statistics                   |
| Open Settings         | `docSearch.openSettings`    | Visual settings editor                             |
| Open Walkthrough      | `docSearch.openWalkthrough` | Step-by-step onboarding guide                      |
| Generate .mcp.json    | `docSearch.generateMcpJson` | Create MCP server config (`.mcp.json`)             |

## MCP Server Environment Variables

When running the MCP server standalone, these environment variables configure behavior:

| Variable               | Default             | Description                                 |
| ---------------------- | ------------------- | ------------------------------------------- |
| `DOC_SEARCH_WORKSPACE` | (required)          | Workspace root path                         |
| `DOC_SEARCH_GLOB`      | `doc/**/*.md`       | File glob pattern                           |
| `DOC_SEARCH_INDEX_DIR` | `.doc-search-index` | Index directory                             |
| `USE_OPENAI`           | `0`                 | Set to `1` to use OpenAI embeddings         |
| `OPENAI_API_KEY`       | (empty)             | OpenAI API key                              |
| `OLLAMA_URL`           | (empty)             | Ollama server URL (enables Ollama provider) |
| `OLLAMA_MODEL`         | `nomic-embed-text`  | Ollama model name                           |
