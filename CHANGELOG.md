# Changelog

All notable changes to **mcp-doc-search** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.1.3...HEAD
[0.1.3]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.1.2...ext-v0.1.3
[0.1.2]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.1.1...ext-v0.1.2
[0.1.1]: https://github.com/de-otio/mcp-doc-search/compare/ext-v0.1.0...ext-v0.1.1
[0.1.0]: https://github.com/de-otio/mcp-doc-search/releases/tag/ext-v0.1.0
