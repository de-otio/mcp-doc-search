# Changelog

All notable changes to **mcp-doc-search** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Stale reindex locks are detected and cleaned up, not just tripped over.**
  A reindex killed mid-run (VS Code reload or quit, SIGKILL) left
  `reindex.lock` behind; it was only ever reclaimed when the next reindex
  happened to collide with it, and nothing reported it. A running reindex now
  touches its lock every 30 s as a heartbeat, so a lock is stale when its
  holder is dead **or** silent for 10 min (covers a recycled pid) **or**
  unreadable. The extension sweeps a stale lock on activation, `getStatus`
  (extension panel, CLI `status`, MCP) removes and reports one, and the CLI
  prints the live lock's holder and heartbeat. New `Indexer` API:
  `inspectReindexLock()` / `clearStaleReindexLock()`; `IndexStatus` gains
  `reindexLock` and `clearedStaleLock`.
- **A rebuild killed part-way no longer leaves an index that claims to be
  complete.** The rebuild dropped the table but only cleared the mtime cache
  in memory, and wrote `index-meta.json` at the first embed — so after a kill
  the next reindex took the incremental path, trusted the old cache, and left
  a table holding a fraction of the corpus (observed: 3,180 of 5,114 files)
  with nothing flagging it. The rebuild now writes an empty cache to disk the
  moment it drops the table, and every run checkpoints the cache after each 25
  indexed files, so a killed run is resumed from its last checkpoint by the
  next plain reindex instead of mistaken for finished.
- **The file watcher no longer turns the status bar red when a reindex is
  already running.** Saving a doc while the start-up catch-up reindex (or a
  CLI / MCP `reindex_docs`, or the watcher's own previous run) held the lock
  made the watcher's attempt throw `ReindexInProgressError`, which it reported
  as "Reindex failed" — a full reindex on a large corpus can take tens of
  minutes, so the badge sat red for the whole run even though nothing had
  failed. The watcher now keeps showing "Indexing…", retries every 10 s until
  the lock is free, and then runs its incremental pass; a new change during
  the wait collapses into the pending retry.

## [0.8.0] - 2026-09-12

### Security

- **HTTP daemon: DNS-rebinding and cross-origin protection.** The loopback
  daemon now refuses any request whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>`, and any request carrying an
  `Origin` header at all, with 403 before a transport is built; the MCP
  transport is additionally constructed with the SDK's
  `enableDnsRebindingProtection` and the same host allow-list. CLI and IDE
  MCP clients send neither header, so nothing changes for them.
- **Symlinks can no longer lead reads outside the workspace.** `get` and
  `multi_get` re-check the real path of every file against the real path of
  its workspace or external root, and the crawl drops any glob match that is
  a symlink or whose real path leaves the root (glob no longer follows
  symlinked directories). A committed `doc/link -> ~/.ssh` is skipped by
  `reindex_docs` and refused by `get`.
- **`set_context` is bounded.** Text is capped at 200 characters after
  sanitizing (line breaks and tabs become spaces, control and format
  characters are dropped, `[`/`]` become `(`/`)`), an index holds at most
  100 entries, prefixes are length-limited, and each entry records
  `updatedAt`. Violations return a typed error instead of being stored.
  Existing `context.json` files are read as before; over-long or unclean
  legacy entries are sanitized and capped on load.
- **Response caps on `get` / `multi_get`.** `max_bytes` is clamped to 1 MiB,
  `max_lines` to 5000 (and now defaults to 5000 rather than "all lines"), a
  glob batch returns at most 500 files and reports `globTruncated: { matched,
limit }` when it was cut, and a file larger than 16 MiB is refused before
  it is read.
- `SECURITY.md` now states the threat model the code implements: a hostile
  workspace is in scope; a hostile local user on the same machine is not.
- **Hardened the release pipeline.** Every GitHub Action is pinned to a
  commit SHA; the workflow token is read-only except on the job that creates
  the GitHub Release; the Marketplace publish and the release now run in a
  `marketplace` environment that can require a maintainer's approval; manual
  (non-dry-run) publishes wait for CI like tag pushes do; and each VSIX ships
  with a SLSA build-provenance attestation, verifiable with
  `gh attestation verify <file>.vsix --repo de-otio/mcp-doc-search`. The
  pre-publish VSIX check also refuses any credential-shaped file (`.env*`,
  `*.pem`, `*.key`, `.npmrc`, `id_*`, `*token*`, `*secret*`) at any depth in
  the archive.
- **The MCP server and CLI no longer trust the workspace's
  `.vscode/settings.json` for keys that reach outside the workspace.**
  `docSearch.extraRoots`, `docSearch.embedProvider`, `docSearch.ollamaUrl` and
  `docSearch.ollamaModel` are read from the environment only
  (`DOC_SEARCH_EXTRA_ROOTS`, `USE_OPENAI` / `OLLAMA_URL`, `OLLAMA_MODEL`). A
  cloned repository could previously grant itself read access to any directory
  (`extraRoots` pointing at `~`) or redirect every chunk and query to a remote
  host (`ollamaUrl`). Settings.json is consulted for those keys only with
  `DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1`, with a stderr notice either way;
  even then an Ollama URL from settings.json must be loopback. The environment
  now wins over settings.json for every key (the Ollama URL and model were
  checked in the wrong order). Workspace-contained keys (`docGlob`,
  `headingDepth`, `maxChunkChars`, `indexLocation`, `indexDir`) still work
  from settings.json.
- **Generated `.mcp.json` is portable and carries the settings the server
  needs.** `Doc Search: Generate .mcp.json` now writes
  `${HOME}/.doc-search/bin/mcp-server.js` and
  `DOC_SEARCH_WORKSPACE: "${CLAUDE_PROJECT_DIR}"` (Claude Code expands both),
  plus `DOC_SEARCH_GLOB`, `DOC_SEARCH_EXTRA_ROOTS` and the provider variables
  built from your effective VS Code configuration — so federation keeps
  working under the new trust model. The OpenAI key is written as the
  reference `${OPENAI_API_KEY}`, never as the literal; the file is created
  with mode 0600 (existing files are tightened); and the command warns when
  `.mcp.json` is already tracked by git. The setup panel's CLI snippet
  single-quotes env values so a shell cannot splice the key in. The
  activation-time repair recognises the `${HOME}` launcher form as current.
  The setup panel shows absolute-path variants for clients that do not expand
  `${VAR}` references. Regenerate `.mcp.json` once after upgrading if you use
  external roots or a non-local provider through MCP.

### Fixed

- **External-root and unusual-name chunks were never deleted.** `deleteByFile`
  filtered on the raw path through a character allow-list that rejected `:`,
  spaces, `@`, `%` and non-ASCII — so every `ext://<root>/…` key (and any file
  with such a name) threw, and the throw was swallowed. Reindexing a changed
  external file appended a second copy of its chunks; deleting the file left it
  searchable forever. Rows are now deleted by the SHA-256 of their key (hex
  only, nothing to escape), a failed delete is logged and counted as a failed
  file instead of ignored, and a real-LanceDB test covers `ext://` keys with
  spaces and umlauts.
- **Switching the embedding provider or model no longer silently loses
  unchanged files.** The index records what produced it (provider, model,
  vector dimension, `maxChunkChars`, `headingDepth`); when any of these differ
  from the live configuration, `reindex` drops the table, discards the mtime
  cache and re-embeds everything, instead of re-embedding only changed files
  into a freshly emptied table. Two different models of the same dimension are
  now caught too.
- **Concurrent reindexes are refused instead of interleaving.** `reindex` takes
  `<indexDir>/reindex.lock` for the whole run (compaction included); a second
  run from another process — extension watcher, CLI, MCP `reindex_docs` —
  fails with "Another reindex is already running (pid …)". A lock left by a
  crashed process is detected by its dead pid and replaced.
- `mtime_cache.json`, `context.json` and `index-meta.json` are written
  atomically (temp file + rename), so a reader never sees a half-written file.
- CLI `context list` printed "No context notes." even when notes existed (it
  treated the map as an array).
- CLI `search` now prefixes excerpts with `[Context: …]` like `search_docs`
  does; it never passed the indexer to the searcher.
- The MCP server and CLI defaulted `maxChunkChars` to a literal 4000 while the
  extension defaults to `0` (model-derived), so an index touched from both
  sides was rebuilt on every alternation. All entry points now resolve the
  same model-derived budget and `index-meta.json` records the resolved value.
- A context prefix written with a trailing slash (`doc/`) never matched: the
  prefix walk generates `doc`. Prefixes are now stored without trailing
  slashes (`doc/`, `doc\` and `doc` are one key) and existing `context.json`
  keys are normalised on load.

### Changed

- **Existing indexes are rebuilt once on the next reindex.** The vector table
  gained a `fileHash` column and the index directory an `index-meta.json`
  (schema version 2). An index without metadata is treated as schema 1 and
  re-embedded in full; `reindex` reports why as `rebuiltReason` (CLI: "Rebuilt
  the whole index: …"), and `status` prints the recorded provider, model,
  dimension and chunking settings.
- **Node.js 22 or newer is required** (`engines.node >=22`, bundles target
  `node22`). The stable launchers under `~/.doc-search/bin` exit 1 with a
  one-line message on an older runtime instead of failing inside a native
  module. Minimum VS Code is now 1.101.
- **Scores.** `score` is the chunk's cosine similarity (still 0–1); results
  are ordered by the fused rank, so `score` is no longer monotonic in rank.
  The substring bonus (+0.03 per term) is gone. `explain` reports
  `vectorRank`, `ftsRank` and `rrfScore` instead of `keywordBonus`.
- **Chunk size follows the model.** `docSearch.maxChunkChars` now defaults to
  `0` = automatic: the model's context window × 3 characters, clamped to
  800–8000 (800 for all-MiniLM-L6-v2, 1536 for multilingual-e5-small; Ollama
  and OpenAI keep 4000). The old fixed 4000 exceeded MiniLM's 256-token window,
  so the tail of every large chunk was silently dropped from its vector. An
  explicit value still wins.
- **Breadcrumbs name the file and headings.** Chunks are prefixed with
  `[path › H1 › H2]` instead of `[DocTitle]`; a section that must be split is
  never cut inside a code fence or a table; and files without headings are
  split too instead of being truncated at the budget. Chunk ids are unchanged.

### Added

- **Native VS Code MCP registration.** The extension registers its MCP server
  through `vscode.lm.registerMcpServerDefinitionProvider` (VS Code 1.101+), so
  Copilot Chat and other in-editor MCP clients discover `Doc Search` without a
  `.vscode/mcp.json` entry. The definition runs the stable launcher with the
  same environment the generated `.mcp.json` carries. The setup panel's
  Copilot tab now says so instead of asking for a hand-edited file.
- **Tool annotations and structured output.** Every MCP tool declares
  `annotations` (`readOnlyHint` on the readers; non-destructive, idempotent
  on `reindex_docs`/`set_context`/`remove_context`) and an `outputSchema`,
  and returns `structuredContent` alongside the JSON text block. `get` and
  `multi_get` carry an `anthropic/maxResultSizeChars` hint. Clients that
  auto-approve read-only tools or validate structured results can use them.
- **Server identity and instructions.** `initialize` now reports the real
  package name and version (built in from `package.json`; it was a hard-coded
  `0.1.0`) and ships server `instructions` with the three agent-guide rules
  (search before reading, scoped `get` by `#docid`, delegate broad sweeps).
- **Full-text side for hybrid search.** Every query now also runs against a
  BM25 inverted index over chunk text (LanceDB `Index.fts()`), and the vector
  and full-text candidate lists are fused with reciprocal rank fusion
  (k = 60). A chunk the embedding misses but the exact terms hit — an
  identifier, a setting key, a German compound — is recovered instead of
  being unreachable. The index is built by `reindex` and rebuilt after every
  run that writes rows; an index created before this release ranks by
  vector similarity only until its next reindex.
- **Multi-query.** `search_docs` accepts `queries: string[]` (at most 5
  distinct queries including `query`); each phrasing contributes its own
  ranked lists to the same fusion.
- The `search_docs` description now says how to phrase a query: one concept
  per call, exact identifiers included, German is fine.
- **Selectable built-in embedding model.** `docSearch.localModel` (env
  `DOC_SEARCH_LOCAL_MODEL` for the MCP server and CLI) chooses which model the
  `local` provider runs: `Xenova/multilingual-e5-small` (German and ~90 other
  languages), `onnx-community/embeddinggemma-300m-ONNX` and
  `nomic-ai/nomic-embed-text-v1.5` join the default `all-MiniLM-L6-v2`. A
  registry records each model's dimension, context window and task prefixes,
  so the local provider now applies the prefixes its model was trained with
  and embeds in batches of 32 instead of one text per call. The default model
  is unchanged; switching downloads the new weights on first use and rebuilds
  the index.
- Every provider reports its identity (`provider`, `model`, `dim`) so the
  index can record which model built it.
- `status` (CLI and `IndexStatus.ftsIndex`) reports whether the full-text
  index is present.

## [0.7.1] - 2026-09-12

### Fixed

- **Index directories no longer grow without bound.** LanceDB keeps a table
  version for every write and never prunes them on its own, so a corpus
  reindexed file-by-file on save accumulated thousands of stale versions —
  one index had reached 6.4 GB for 250 MB of live data. `reindex` now compacts
  the store and drops old versions once 20 or more have piled up
  (sub-second in steady state). The CLI reports what was reclaimed, and the
  MCP `reindex_docs` result carries it as `compacted`. Existing bloated
  indexes are cleaned up on their next reindex.

### Security

- Bumped the bundled `sharp` to 0.35.4 (GHSA-rgj7-g3m4-5g8c, libheif). The
  extension never processes images, but `sharp` ships inside the VSIX as a
  transitive dependency of the local embedder.

## [0.7.0] - 2026-08-28

### Added

- **Embedding providers are probed before a large reindex.** Every provider now
  implements a health check, and the indexer runs it once up front instead of
  discovering a broken provider one file at a time. Failures are classified —
  server unreachable, model not downloaded, model runner cannot load, bad API
  key — and each carries a specific remediation. A reindex against a stopped
  Ollama now fails in about 100 ms with `No Ollama server responding at <url>`,
  where it previously spent ~60 s per file before reporting anything. The probe
  is skipped for runs of fewer than five files, so save-triggered incremental
  reindexes stay cheap.
- **Restart recovery for Ollama** via the new `docSearch.ollamaAutoRestart`
  setting (`never` / `prompt` / `auto`, default `prompt`). When Ollama is
  running but cannot load its model, the error notification offers a **Restart
  Ollama** button; on success the reindex is retried once. Restarts use a fixed
  internal command list (`brew services` or user `systemctl`), never a shell and
  never `sudo`; supervisors that would need root — or that manage `Ollama.app` —
  are reported with the command to run by hand rather than driven automatically.
  Error text is enriched with the daemon-vs-binary version skew when the Ollama
  CLI reports one.
- **Reindex aborts instead of grinding** when the provider is unusable: fatal
  failures stop immediately, and any three consecutive embed failures end the
  run. The mtime cache is written before aborting, so files already indexed are
  not re-embedded on the next run.

### Fixed

- **Indexing no longer appears frozen on "Loading AI model…" when every file
  fails.** The error path did not report progress — it skipped straight to the
  next file — so a provider that failed on every file left the UI pinned to
  whichever phase came before it, for the length of the corpus. Failures are now
  reported as their own progress phase, and the loading message counts elapsed
  seconds so a slow model load is visibly distinct from a stalled one.
- **A timed-out embedding request is no longer retried.** The single retry is
  meant for a connection refused or reset in transit; applying it to a timeout
  simply doubled every stall (30 s became 60 s per file). Connection errors are
  still retried once.

### Changed

- `docSearch.ollamaUrl` now defaults to `http://127.0.0.1:11434` instead of
  `http://localhost:11434`. Ollama binds IPv4 only, while some systems resolve
  `localhost` to `::1` first. Existing explicit settings are unaffected.
- `Indexer.reindex()` throws `EmbedderUnavailableError` when it abandons a run,
  and its `onProgress` callback gained a `"failed"` phase. All in-tree callers
  already handled thrown errors; external callers of the core API should catch
  it.

## [0.6.0] - 2026-08-08

### Added

- **Stable launcher path** (`~/.doc-search/bin/`): activation now writes tiny
  forwarder scripts (`mcp-server.js`, `mcp-doc-search.js`) at a
  version-independent path under the doc-search home and refreshes them on
  every upgrade. "Generate .mcp.json" embeds the stable path, and the
  activation-time `.mcp.json` repair now repoints stale versioned extension
  paths at it — so a configured MCP server survives extension upgrades in
  every workspace, including ones never reopened in VS Code. Respects
  `DOC_SEARCH_HOME`; falls back to the versioned path if the bin directory is
  unwritable. The CLI's run-directly guard now also recognizes being loaded
  through the launcher.
- **Scoped-fetch guidance in the `get`/`multi_get` tool descriptions**: the
  MCP tool descriptions now steer agents toward `from_line`/`max_lines`/
  `max_bytes` fetches around a search hit instead of whole-file pulls, and
  toward capping per-file limits in batch fetches — the token-economics
  rationale lives in `doc/agent-guide.md`.

- **Agent usage guide** (`doc/agent-guide.md`): token-efficient patterns for
  AI coding agents driving the MCP tools — why chunk-level retrieval beats
  whole-file reads in agentic sessions, scoped `get`/`multi_get` usage,
  multi-repo federation via external roots, delegating broad doc sweeps to
  subagents, and operational notes (config-at-startup, centralized index,
  sandboxed-shell reindex pitfalls). Linked from the README and the MCP
  integration doc.

### Security

- **Cleared all open Dependabot alerts (7) and `npm audit` findings.**
  Transitive bumps: `sharp` ≥ 0.35.0 (libvips CVEs — the only runtime-scope
  alert), `js-yaml` ≥ 4.3.1, `hono` ≥ 4.13.1, `@hono/node-server` ≥ 2.0.5
  (all dev-scope), plus `npm audit fix` for `body-parser`, `brace-expansion`,
  `path-to-regexp`, and `protobufjs`. Dev-dependency group bump
  (`@modelcontextprotocol/sdk` 1.30, `prettier` 3.9, `typescript-eslint`
  8.66, `@types/node`, `@vitest/coverage-v8`) and CI action bumps
  (`actions/setup-node@v7`, pinned `github/codeql-action@v4.37.3`).

## [0.5.2] - 2026-08-08

### Fixed

- **A chunk denser than the embedding model's context window no longer drops
  the file from the index.** The chunker budgets characters but the model
  budgets tokens, so token-dense content (config dumps, tables) could
  overflow Ollama's `num_ctx` from within `maxChunkChars`, failing the file
  with `Ollama embedding failed (500): the input length exceeds the context
length`. The Ollama embedder now halves the text and retries (up to 3
  halvings) when it sees that specific error, embedding the chunk's head —
  with a stderr warning — instead of losing the file entirely. Other 5xx
  errors are still thrown unchanged.

### Changed

- **Docs: the in-tree `.doc-search-index` layout is now explicitly documented
  as deprecated.** Indexes are centralized under `~/.doc-search/indexes/`
  (the `global` default since 0.3.0); README, configuration, and
  MCP-integration docs now mark workspace mode, `docSearch.indexDir`, and
  `DOC_SEARCH_INDEX_DIR` as deprecated instead of merely "legacy". No
  behavior change.

## [0.5.1] - 2026-07-17

### Fixed

- **The reindex command and Index Status panel ignored external roots.** The
  fresh-config indexer built for `docSearch.reindex` and the status panel
  omitted `extraRoots`, so "Files found" showed workspace files only and —
  worse — running a reindex from there **pruned every `ext://` entry** from
  the index (they were re-added by the next reindex through a correctly
  configured path, e.g. the MCP server's `reindex_docs`, at the cost of
  re-embedding). Only the activation-time catch-up indexer and the MCP
  server/CLI had the roots wired. The fresh-indexer path now parses
  `extraRoots` like every other construction site; regression-tested.

## [0.5.0] - 2026-07-17

### Added

- **External folders are now editable in the settings panel.** "Doc Search:
  Open Settings" gained an "External folders" section — a name/path/pattern
  list editor for `docSearch.extraRoots` with add/remove rows, so the 0.4.0
  feature no longer requires hand-editing settings.json. Entries are saved
  as typed (trimmed; empty pattern falls back to the `**/*.{md,mdx}` default;
  the setting is removed entirely when the list is empty), and validation
  warnings from the engine (`parseExtraRoots`) are shown after saving so you
  learn immediately which entries would be ignored and why. The section
  includes the read-access security note inline.

## [0.4.0] - 2026-07-17

### Added

- **External documentation roots (`docSearch.extraRoots`).** Index directories
  _outside_ the workspace alongside the workspace docs — e.g. a locally cloned
  vendor-documentation repo — and search them from any project session. Each
  root gets a unique `name` and an absolute `path` (leading `~` expanded); an
  optional `glob` defaults to `**/*.{md,mdx}`, so MDX corpora work out of the
  box. Files under a root are keyed as `ext://<name>/<relative-path>` in search
  results, `list_docs`, and the mtime cache, and can be fetched with `get` /
  `multi_get` via that ref or their docid. Also configurable for the standalone
  MCP server / CLI via the `DOC_SEARCH_EXTRA_ROOTS` env var (JSON array), which
  overrides the settings.json value.
  - **Containment per root:** every `ext://` ref is re-validated against the
    realpath of its declared root; `..` traversal out of a root is rejected,
    unknown or malformed roots are dropped with a warning, and a bad entry
    never takes the engine down.
  - **Missing-root safety:** a configured root whose directory is absent
    (unmounted disk, not yet cloned) is skipped without pruning its existing
    index entries; removing the root from the setting prunes them on the next
    reindex.
  - **Scope note:** the save-time file watcher covers only the workspace —
    refresh an external root by reindexing after updating it. A configured
    root grants doc-search MCP/CLI clients read access to that subtree; review
    the setting when opening untrusted workspaces.

### Security

- **Patched the vulnerable transitive dependencies flagged by Dependabot (20 → 0 open alerts).** Patched versions are pinned via npm `overrides`. The shipped runtime now resolves `protobufjs` ≥7.6.3 (was 7.5.4 — clears **1 critical + 5 high + 5 moderate** advisories pulled in through `@huggingface/transformers`) and `@protobufjs/utf8` ≥1.1.1. Build/dev tooling was likewise pinned: `fast-uri` ≥3.1.2, `flatted` ≥3.4.2, `lodash` ≥4.18.0, `@hono/node-server` ≥1.19.13, `postcss` ≥8.5.14, and `picomatch` ≥2.3.2 (scoped under `micromatch` so `vitest`/`vite` keep `picomatch` 4.x); `uuid` / `@azure/identity` (under `@vscode/vsce`) were bumped to their patched releases.

## [0.3.2] - 2026-06-24

### Changed

- **A superseded in-tree `.doc-search-index` is now removed automatically.** When migration is _skipped_ because a populated global index already exists for the workspace (e.g. the index was rebuilt globally before the legacy one could be migrated), the extension now removes the redundant in-tree `.doc-search-index` on activation and shows a one-time notification — so you no longer end up with both an in-tree and a global copy. Cleanup runs only in the VS Code extension (the trusted writer), never in the MCP server / CLI reader, and reuses the same fail-closed safety gate as migration (real directory, sentinel present, no interior symlinks; the only populated index is never deleted).
- **Settings UI clarifies the index location.** The settings panel's "Search index location" hint now explains that the index lives globally under `~/.doc-search` by default and that entering a custom folder switches to legacy in-tree storage.

## [0.3.1] - 2026-06-24

### Fixed

- **Legacy `.doc-search-index` migration never ran for real indexes.** The 0.3.0 safety gate required the LanceDB sentinel (`doc_chunks.lance`) to be a regular file, but LanceDB always stores it as a directory, so every real legacy index was rejected as "unsafe." The index was silently re-built in the global location and the in-tree `.doc-search-index` was left behind instead of migrated. The gate now accepts a file-or-directory sentinel (still refusing symlinks), matching the populated-index check.
- **Stale `.mcp.json` after an extension upgrade.** A generated `.mcp.json` embeds an absolute path to the extension's `dist/mcp-server.js`; upgrading the extension moves the install directory, leaving the configured MCP server pointing at a defunct path. The extension now re-points an existing doc-search server entry to the current build on activation (it never creates the file or touches other servers / the `env` block).

## [0.3.0] - 2026-06-24

### Changed

- **Index location moved to `~/.doc-search` by default.** The search index now lives under `~/.doc-search/indexes/<workspace-key>/` (global location, outside your project tree) instead of in-tree at `.doc-search-index`. This reduces project clutter and keeps the index out of version control without requiring a `.gitignore` edit. The location is derived from the workspace's canonical path, so the VS Code extension, the MCP server, and the CLI all share one index per workspace (clones at different paths keep independent indexes).
  - **Automatic migration:** any existing `.doc-search-index` folder is migrated to the global location on first use. No manual action required.
  - **No `.gitignore` modification:** the legacy `.doc-search-index` entry in `.gitignore` (if present) is now harmless and can be removed manually.
  - **Workspace mode available:** set `docSearch.indexLocation` to `workspace` to use the legacy in-tree location.
  - **New environment variables:** `DOC_SEARCH_HOME` (base directory override) and `DOC_SEARCH_INDEX_LOCATION` (mode selection) for CLI and MCP server parity with VS Code settings.

## [0.2.0] - 2026-05-11

Security release. Addresses findings from the 2026-05-09 internal
security review (three HIGH, four MEDIUM, three LOW); no externally-
reported CVEs. Minor-version bump because the API-key handling and
path-validation changes affect user-visible behavior (and one
deprecated `settings.json` field).

### Security

- **Path traversal in `get` / `multi_get` / `resolveRef` (H1, H2,
  M4, L2).** The legacy `rel.startsWith("..")` checks missed
  mid-path escapes like `doc/../../etc/passwd`, and the CLI's
  `get` / `multi-get` accepted absolute paths outright. A shared
  `resolveSafePath` helper now backs every site that maps a
  user-supplied ref to a filesystem path; absolute refs, leading
  `..`, mid-path `..` that escapes the root, and Windows-style
  separators are all rejected. The configured `indexDir` and
  `docGlob` are likewise validated — escape attempts fall back to
  the defaults with a stderr warning.
- **OpenAI API key was written to `.vscode/settings.json` (H3,
  M1).** The Settings panel previously persisted the key via
  `cfg.update("openaiApiKey", ...)`, which lands in plaintext in a
  file commonly committed to repos. The panel now reads and writes
  the key exclusively from VS Code's SecretStorage. The MCP server
  and CLI read the key only from `OPENAI_API_KEY` env — never from
  `settings.json`. The `docSearch.openaiApiKey` setting is marked
  deprecated; the generated `.mcp.json` copies the key from
  SecretStorage into the env block (the file is gitignored by the
  same command).
- **Absolute filesystem paths leaked in MCP error responses (M3).**
  Caught exceptions previously surfaced raw `String(err)` to JSON-RPC
  clients, often embedding the user's home directory, repo path,
  and sometimes customer / project names. A new
  `sanitizeForClient` helper routes every catch-handler in the MCP
  transport and tool surface through a regex that strips POSIX,
  Windows-drive, and UNC absolute paths. The full error still goes
  to stderr for the operator.
- **HTTP daemon could buffer unbounded request bodies (M2).** The
  Streamable HTTP transport's `readBody` now caps the request at
  10 MB; overflow returns 413 and closes the socket. Real MCP
  requests are JSON-RPC envelopes of a few KB, so the cap is
  generous but bounds worst-case memory.
- **PID file race on daemon start (L3).** `writePidFile` now uses
  `O_EXCL` to refuse clobbering a live daemon's pidfile, with stale
  detection for the case where the previous daemon crashed. Every
  `process.kill()` in `stopDaemon` treats `ESRCH` (process already
  gone) as success rather than fatal, so a race between liveness
  check and signal delivery never leaves a stranded pidfile.
- **Webview message handlers (L1).** `openUrl` in the Settings
  panel now allows only `http(s)`; other schemes (`file:`,
  `vscode:`, `javascript:`, `data:`, …) are dropped silently.
  `openResult` in the Search panel validates the relative file ref
  before joining onto the workspace root.

### Changed

- **Settings: `docSearch.openaiApiKey` is deprecated.** Existing
  values are migrated to SecretStorage on activation; the setting
  is no longer read at runtime by either the extension or the MCP
  server. Set the key in the Doc Search Settings panel instead.

## [0.1.3] - 2026-05-11

### Fixed

- **LocalEmbedder no longer crashes at runtime.** The built-in
  (zero-config) embedding provider failed for every reindex with
  `Cannot find module .../transformers.node.mjs`. The packaged VSIX
  ships only `transformers.node.cjs` (the `.mjs` is stripped to keep
  the bundle small), but the code used dynamic `import()`, which
  Node's exports resolver routes to the missing `.mjs`. Switched to
  `require()` via `createRequire` so resolution lands on the `.cjs`
  that's actually shipped. Also restored the `sharp` / `@img`
  transitive deps in the VSIX — transformers' webpack-bundled CJS
  eagerly `require()`s `sharp` at module load even though we only
  embed text, so stripping it crashed the loader before the pipeline
  could run. Net VSIX cost: roughly +16 MB on darwin-arm64.
- **Index Status panel "Full Reindex" used a stale embed provider.**
  The panel held the indexer instance built at extension activation,
  so users who switched embed providers in Settings still hit the
  activation-time provider when they clicked the panel's Full
  Reindex / Incremental Reindex buttons. The panel now rebuilds the
  indexer from fresh config on each action, mirroring the
  `docSearch.reindex` command path.
- **Failed reindexes no longer report "No documents found matching
  the file pattern."** When all files failed to embed (e.g. Ollama
  unreachable, model not pulled, API key missing) the result message
  was the same as when the glob matched nothing. The panel now
  distinguishes total-failure, partial-failure, no-files, and success
  cases, and surfaces the first underlying error string so the cause
  is visible without opening the developer console.

### Changed

- **VSIX no longer ships internal/dev files.** `CLAUDE.md`,
  `vitest.config.ts`, `eslint.config.mjs`, `bin/mcp-doc-search.ts`
  (CLI source — bundled output is in `dist/`), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `package-lock.json`, and stray
  local files (`.mcp.json`, `.doc-search-index/`, `.vscode/`,
  `*.vsix`) are now excluded. node_modules dev cruft (CHANGELOGs,
  `.eslintrc`, `test/`, `example/`, `docs/`, `.d.ts`, `.travis.yml`,
  etc.) is also dropped. File count: ~2064 (down from 5378 at 0.1.1).
- `scripts/verify-vsix.mjs` now fails the build if any of the above
  re-leak into the packaged VSIX.

## [0.1.2] - 2026-05-09

### Changed

- **VSIX install footprint cut roughly in half.** `glob`,
  `jsonc-parser`, and `@modelcontextprotocol/sdk` are inlined into
  `dist/` by esbuild at build time, so they no longer need to ship
  as separate `node_modules` trees. Total VSIX file count went from
  5378 → 2257 (-58%); JS files from 1947 → 701 (-64%); per-target
  VSIX sizes are now 34–45 MB across the four targets.

### Security

- Dependency bumps for moderate/high advisories surfaced by
  Dependabot: `ip-address` 10.1.0 → 10.2.0 and `express-rate-limit`
  8.3.0 → 8.5.1 (both transitive via `@modelcontextprotocol/sdk`'s
  HTTP transport stack); `@modelcontextprotocol/sdk` 1.27.1 →
  1.29.0; `glob` 11 → 13 (advisory on old 11.x versions).

### Documentation

- README refreshed to reflect the public marketplace listing,
  the full set of MCP tools (`get`, `multi_get`, `set_context` /
  `list_contexts` / `remove_context`), and the three build outputs
  (extension, MCP server, standalone CLI).

## [0.1.1]

### Fixed

- Settings panel: a "Save failed" banner now clears when the user retries
  the save (and on success), instead of lingering after the underlying
  problem has been corrected.

## [0.1.0]

Initial public release.

### Added

- VS Code extension with type-ahead search command, status bar indicator,
  and walkthrough.
- Standalone MCP server (stdio transport) exposing `search_docs`,
  `list_docs`, `reindex_docs`, `get`, `multi_get`, `set_context`,
  `list_contexts`, and `remove_context` tools.
- HTTP transport (`--http --port`) and detached daemon mode
  (`--daemon` / `--stop`) with idle model disposal.
- Standalone CLI (`mcp-doc-search` binary) mirroring all MCP tools, with
  `--json`, `--files`, and `--explain` output modes.
- Local embeddings via bundled `all-MiniLM-L6-v2` (ONNX) — no API key
  required. Optional Ollama and OpenAI providers.
- Heading-aware markdown chunking with code-fence skipping, mtime cache
  for incremental reindex, and prune-on-reindex for deleted files.
- Hybrid search (vector cosine + keyword bonus), `explain: true` for
  per-result score breakdown, and SHA-256 docids for stable references.
- Per-file context notes (`set_context` / `list_contexts` /
  `remove_context`) so the index can carry curator-supplied hints.
- On-activation catch-up reindex when the workspace has changed since the
  last index run.

[Unreleased]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.8.0...HEAD
[0.3.1]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.3.0...ext-v0.3.1
[0.3.0]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.2.0...ext-v0.3.0
[0.2.0]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.1.3...ext-v0.2.0
[0.1.3]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.1.2...ext-v0.1.3
[0.1.2]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.1.1...ext-v0.1.2
[0.1.1]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.1.0...ext-v0.1.1
[0.1.0]: https://github.com/de-otio/mcp-doc-search/releases/tag/ext-v0.1.0
