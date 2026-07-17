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

### docSearch.extraRoots

- **Type:** `array` of `{ name, path, glob? }` objects
- **Default:** `[]`

Additional directories **outside the workspace** to index alongside the workspace docs — for example a locally cloned vendor-documentation repo you want searchable from every project.

```jsonc
"docSearch.extraRoots": [
  {
    "name": "vendor-docs", // unique id, used in ext://vendor-docs/... refs
    "path": "~/repos/vendor/docs", // absolute; leading ~ is expanded
    "glob": "pages/**/*.mdx" // optional; default **/*.{md,mdx}
  }
]
```

- Files under an external root appear everywhere (search results, `list_docs`, the mtime cache) under the key `ext://<name>/<relative-path>`, and can be fetched with `get`/`multi_get` using that ref or their docid.
- The default glob includes `.mdx` — vendor docs corpora are commonly MDX. The chunker treats MDX as markdown.
- External roots are scanned during reindex (command or `reindex_docs` tool); the save-time file watcher only covers the workspace, so refresh an external root by reindexing after you `git pull` it.
- A root whose directory is missing (unmounted disk, not yet cloned) is skipped without pruning its existing index entries; removing the root from the setting prunes them on the next reindex.

**Security note:** every configured root grants doc-search MCP/CLI clients read access to that directory subtree. The MCP server reads this setting from `.vscode/settings.json`, which is workspace-controlled — review it when opening untrusted workspaces. Refs into a root are containment-checked against the root's real path; `..` traversal out of a root is rejected.

### docSearch.indexLocation

- **Type:** `enum`
- **Default:** `global`
- **Options:** `global`, `workspace`

Where to store the search index:

- `global` (default): Indexes are stored under `~/.doc-search/indexes/<workspace-key>`, shared across all instances of this workspace. Automatically migrates any existing `.doc-search-index` folder to the global location on first run. The global location is not added to version control.
- `workspace`: Indexes are stored in-tree at the location specified by `docSearch.indexDir` (default: `.doc-search-index`). This is the legacy behavior. The configured directory is automatically added to `.gitignore` on first run.

If `docSearch.indexDir` is set to a non-default value and `docSearch.indexLocation` is not explicitly set, workspace mode is automatically selected (preserving any existing custom index locations).

### docSearch.indexDir

- **Type:** `string`
- **Default:** `.doc-search-index`

**Workspace mode only.** Directory where the vector index (LanceDB) and mtime cache are stored, relative to the workspace root. This path is automatically added to `.gitignore` on first run. Ignored when `docSearch.indexLocation` is set to `global`.

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

| Variable                    | Default             | Description                                                                                            |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `DOC_SEARCH_WORKSPACE`      | (required)          | Workspace root path                                                                                    |
| `DOC_SEARCH_GLOB`           | `doc/**/*.md`       | File glob pattern                                                                                      |
| `DOC_SEARCH_EXTRA_ROOTS`    | (empty)             | JSON array of external roots (same shape as `docSearch.extraRoots`); overrides the settings.json value |
| `DOC_SEARCH_HOME`           | `~/.doc-search`     | Base directory for global index (requires absolute path)                                               |
| `DOC_SEARCH_INDEX_LOCATION` | `global`            | Index location mode: `global` or `workspace`                                                           |
| `DOC_SEARCH_INDEX_DIR`      | `.doc-search-index` | Workspace-mode index directory (relative to workspace root)                                            |
| `USE_OPENAI`                | `0`                 | Set to `1` to use OpenAI embeddings                                                                    |
| `OPENAI_API_KEY`            | (empty)             | OpenAI API key                                                                                         |
| `OLLAMA_URL`                | (empty)             | Ollama server URL (enables Ollama provider)                                                            |
| `OLLAMA_MODEL`              | `nomic-embed-text`  | Ollama model name                                                                                      |
