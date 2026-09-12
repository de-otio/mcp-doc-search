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

Additional directories **outside the workspace** to index alongside the workspace docs — for example a locally cloned vendor-documentation repo you want searchable from every project. Editable in the settings panel (**Doc Search: Open Settings** → "External folders") or directly in settings.json.

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

**Security note:** every configured root grants doc-search MCP/CLI clients read access to that directory subtree. The MCP server and CLI therefore take this setting from the `DOC_SEARCH_EXTRA_ROOTS` environment variable only — the workspace's `.vscode/settings.json` is not consulted unless you opt in (see [Trust model](#trust-model)). The **Generate .mcp.json** command writes your effective VS Code setting into the `env` block for you. Refs into a root are containment-checked against the root's real path; `..` traversal out of a root is rejected.

### docSearch.indexLocation

- **Type:** `enum`
- **Default:** `global`
- **Options:** `global`, `workspace` (deprecated)

Where to store the search index:

- `global` (default): Indexes are centralized under `~/.doc-search/indexes/<workspace-key>`, outside the workspace, shared across all instances of this workspace (VS Code extension, MCP server, CLI). Automatically migrates any existing `.doc-search-index` folder to the global location on first run. The global location is not added to version control.
- `workspace` (**deprecated**): Indexes are stored in-tree at the location specified by `docSearch.indexDir` (default: `.doc-search-index`). This is the legacy behavior, kept only for setups that cannot use the centralized location; it may be removed in a future release. The configured directory is automatically added to `.gitignore` on first run.

If `docSearch.indexDir` is set to a non-default value and `docSearch.indexLocation` is not explicitly set, workspace mode is automatically selected (preserving any existing custom index locations).

### docSearch.indexDir

- **Type:** `string`
- **Default:** `.doc-search-index`

**Deprecated — workspace mode only.** Directory where the vector index (LanceDB) and mtime cache are stored, relative to the workspace root. This path is automatically added to `.gitignore` on first run. Ignored in the default `global` mode, where indexes live centrally under `~/.doc-search/indexes/`. Note: setting this to a non-default value implicitly selects the deprecated workspace mode (see above), so remove the setting entirely unless you need the legacy in-tree layout.

### docSearch.headingDepth

- **Type:** `number`
- **Default:** `2`

Controls which heading levels trigger chunk splits:

- `1` — Split only on `#` (h1) headings
- `2` — Split on `#` (h1) and `##` (h2) headings

Lower depth means larger chunks with more context. Higher depth means smaller, more precise chunks.

### docSearch.maxChunkChars

- **Type:** `number`
- **Default:** `0` (automatic)

Maximum characters per chunk, breadcrumb included. `0` derives the budget from the embedding model's context window — `ctxTokens × 3`, clamped to 800–8000:

| Model                                     | Window (tokens) | Chunk budget (chars) |
| ----------------------------------------- | --------------- | -------------------- |
| `Xenova/all-MiniLM-L6-v2` (default)       | 256             | 800                  |
| `Xenova/multilingual-e5-small`            | 512             | 1536                 |
| `onnx-community/embeddinggemma-300m-ONNX` | 2048            | 6144                 |
| `nomic-ai/nomic-embed-text-v1.5`          | 8192            | 8000                 |
| Ollama / OpenAI                           | not known       | 4000                 |

An explicit value always wins (clamped to 100–50000). Why the model decides: the tokenizer truncates silently past the window, so with the old fixed default of 4000 the second half of every large chunk contributed nothing to its vector under the default model. Sections longer than the budget are split with a 15 % (max 200 characters) overlap between consecutive chunks; a split never lands inside a code fence or a table — the block starts the next chunk intact, and only a block longer than the whole budget is cut. Files without headings are split the same way instead of being truncated.

### docSearch.embedProvider

- **Type:** `enum`
- **Default:** `local`
- **Options:** `local`, `ollama`, `openai`

Which embedding provider to use:

| Provider | Model                                  | Dimensions | Notes                                                  |
| -------- | -------------------------------------- | ---------- | ------------------------------------------------------ |
| `local`  | Selectable, see `docSearch.localModel` | 384 / 768  | No setup required. ONNX model downloaded on first use. |
| `ollama` | Configurable                           | 768        | Requires a running Ollama server.                      |
| `openai` | text-embedding-3-small                 | 1536       | Requires API key. Best quality.                        |

Changing the provider — or the local model — requires a full reindex, since vectors from different models cannot be compared.

### docSearch.localModel

- **Type:** `enum`
- **Default:** `Xenova/all-MiniLM-L6-v2`

Which model the built-in (`local`) provider runs. All four run fully offline after a one-time download; each entry in the registry (`src/core/localModels.ts`) records the model's dimension, context window and the task prefixes it was trained with, which the embedder applies automatically.

| Model                                     | Languages                  | Dim | Window | Download | Prefixes (query / document)                                |
| ----------------------------------------- | -------------------------- | --- | ------ | -------- | ---------------------------------------------------------- |
| `Xenova/all-MiniLM-L6-v2` (default)       | English                    | 384 | 256    | ~90 MB   | none                                                       |
| `Xenova/multilingual-e5-small`            | ~95 languages incl. German | 384 | 512    | ~118 MB  | `query: ` / `passage: `                                    |
| `onnx-community/embeddinggemma-300m-ONNX` | 100+ languages             | 768 | 2048   | ~310 MB  | `task: search result \| query: ` / `title: none \| text: ` |
| `nomic-ai/nomic-embed-text-v1.5`          | English                    | 768 | 8192   | ~131 MB  | `search_query: ` / `search_document: `                     |

Pick `multilingual-e5-small` for German or mixed-language documentation: the default is English-only and embeds German text poorly. EmbeddingGemma is the strongest multilingual option and `nomic-embed-text-v1.5` the strongest for English (it is the same model Ollama's `nomic-embed-text` runs). Switching models downloads the new weights on first use and triggers a full re-embed of the index. The default is unchanged from earlier releases, so existing users are not forced into a download.

For the MCP server and CLI, set `DOC_SEARCH_LOCAL_MODEL` to one of the ids above.

### docSearch.ollamaUrl

- **Type:** `string`
- **Default:** `http://127.0.0.1:11434`

URL of the Ollama server. Only used when `embedProvider` is set to `ollama`.

The default is the IPv4 literal rather than `localhost` on purpose: Ollama binds
IPv4 only, while some systems resolve `localhost` to `::1` first.

### docSearch.ollamaModel

- **Type:** `string`
- **Default:** `nomic-embed-text`

Ollama model to use for embeddings. Only used when `embedProvider` is set to `ollama`.

### docSearch.ollamaAutoRestart

- **Type:** `string`
- **Options:** `never`, `prompt`, `auto`
- **Default:** `prompt`

What to do when Ollama is reachable but cannot load its model — most often a
daemon left running across an upgrade (see
[Ollama stops embedding after an upgrade](#ollama-stops-embedding-after-an-upgrade)).

| Value    | Behaviour                                                             |
| -------- | --------------------------------------------------------------------- |
| `never`  | Report the problem only.                                              |
| `prompt` | Offer a **Restart Ollama** button on the error notification.          |
| `auto`   | Restart Ollama, wait for it to come back, and retry the reindex once. |

Restarts go through your service manager — `brew services restart ollama` or
`systemctl --user restart ollama` — chosen from a fixed internal list. Nothing
runs as root, and no configured value is ever passed to a shell. Where the
service is managed in a way the extension will not drive itself (a system-wide
systemd unit, or `Ollama.app`), it reports the command for you to run instead.

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

## Trust model

The extension runs inside VS Code, which refuses to run it at all in a
Restricted Mode (untrusted) workspace. The standalone MCP server and CLI have
no such gate, and a cloned repository is attacker-controlled: anyone who can
commit to it can commit a `.vscode/settings.json`. Two of the settings above
can reach outside the workspace — `docSearch.extraRoots` grants read access to
arbitrary directories, and `docSearch.embedProvider` with `docSearch.ollamaUrl`
would send every chunk and every query to a host of the repo's choosing. So the
MCP server and CLI apply these rules:

- **Trust-sensitive keys come from the environment only.** `extraRoots`, the
  embedding provider, the Ollama URL and the Ollama model are read from
  `DOC_SEARCH_EXTRA_ROOTS`, `USE_OPENAI` / `OLLAMA_URL` and `OLLAMA_MODEL` —
  i.e. from your own `.mcp.json` or shell. The same keys in
  `.vscode/settings.json` are ignored, with a one-line stderr notice naming
  them, unless `DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1` is set. Set that only
  for workspaces whose settings you wrote yourself; the server then prints a
  notice that it is trusting the file.
- **The environment always wins.** For every key, an environment variable
  overrides the settings.json value, whether or not the opt-in is set. (Earlier
  versions checked settings.json first for the Ollama URL and model.)
- **The Ollama URL from settings.json must be loopback.** Even after the
  opt-in, a `docSearch.ollamaUrl` whose host is not `localhost`, `127.x.x.x`
  or `::1` is replaced by the default with a stderr warning. A remote Ollama
  host is supported by setting `OLLAMA_URL` in the environment.
- **Workspace-contained keys still come from settings.json.** `docGlob`,
  `headingDepth`, `maxChunkChars`, `indexLocation` and `indexDir` cannot escape
  the workspace (the glob and index directory are validated separately) and
  keep working from `.vscode/settings.json` as before. The OpenAI key was
  already never read from that file.

Because of the first rule, the **Generate .mcp.json** command writes your
effective VS Code configuration into the `env` block of `.mcp.json` — external
roots included — so federation keeps working without the opt-in. Regenerate
the file after changing `extraRoots` or the provider.

## MCP Server Environment Variables

When running the MCP server standalone, these environment variables configure behavior:

| Variable                              | Default                   | Description                                                                                                   |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DOC_SEARCH_WORKSPACE`                | (required)                | Workspace root path (`${CLAUDE_PROJECT_DIR}` in a generated `.mcp.json`; Claude Code expands it)              |
| `DOC_SEARCH_GLOB`                     | `doc/**/*.md`             | File glob pattern                                                                                             |
| `DOC_SEARCH_EXTRA_ROOTS`              | (empty)                   | JSON array of external roots (same shape as `docSearch.extraRoots`); the only source unless the opt-in is set |
| `DOC_SEARCH_TRUST_WORKSPACE_SETTINGS` | (unset)                   | Set to `1` to also read `extraRoots`, the provider, Ollama URL and model from `.vscode/settings.json`         |
| `DOC_SEARCH_HOME`                     | `~/.doc-search`           | Base directory for global index (requires absolute path)                                                      |
| `DOC_SEARCH_INDEX_LOCATION`           | `global`                  | Index location mode: `global` or `workspace` (deprecated)                                                     |
| `DOC_SEARCH_INDEX_DIR`                | `.doc-search-index`       | Deprecated: workspace-mode index directory (relative to workspace root)                                       |
| `USE_OPENAI`                          | `0`                       | Set to `1` to use OpenAI embeddings                                                                           |
| `OPENAI_API_KEY`                      | (empty)                   | OpenAI API key (a generated `.mcp.json` references it as `${OPENAI_API_KEY}`; export it in your shell)        |
| `OLLAMA_URL`                          | (empty)                   | Ollama server URL (enables Ollama provider; any host is accepted from the environment)                        |
| `OLLAMA_MODEL`                        | `nomic-embed-text`        | Ollama model name                                                                                             |
| `DOC_SEARCH_LOCAL_MODEL`              | `Xenova/all-MiniLM-L6-v2` | Built-in model for the `local` provider; one of the ids listed under `docSearch.localModel`                   |

## Troubleshooting

### Ollama stops embedding after an upgrade

Upgrading Ollama does not restart the running server. The old daemon keeps
answering `/api/version` — so it looks healthy — while it spawns the _new_
runner binary with arguments that binary no longer accepts, and every model
load fails. Indexing appears to hang.

Doc Search detects this before indexing and offers to restart Ollama (see
[`docSearch.ollamaAutoRestart`](#docsearchollamaautorestart)). To fix it by hand:

```bash
brew services restart ollama     # or: systemctl --user restart ollama
```

`ollama --version` printing two different versions (`ollama version is X`
followed by `Warning: client version is Y`) confirms the skew.
