# Changelog

All notable changes to **mcp-doc-search** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/de-otio/mcp-doc-search/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/de-otio/mcp-doc-search/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/de-otio/mcp-doc-search/releases/tag/v0.1.0
