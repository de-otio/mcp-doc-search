# Development Guide

## Prerequisites

- Node.js 22+ (`engines.node`; the stable launcher refuses older runtimes)
- npm
- VS Code (for extension development)

## Setup

```bash
git clone <repo-url>
cd mcp-doc-search
npm install
```

## Project Structure

```
src/
├── core/           # Framework-agnostic search engine
│   ├── types.ts       # Interfaces and type definitions
│   ├── chunker.ts     # Markdown heading-aware chunking
│   ├── embedder.ts    # Embedding providers (local, Ollama, OpenAI)
│   ├── vectorstore.ts # LanceDB wrapper
│   ├── searcher.ts    # Hybrid vector + keyword search
│   └── indexer.ts     # Crawl, chunk, embed, upsert pipeline
├── extension/      # VS Code extension integration
│   ├── extension.ts      # Entry point and activation
│   ├── config.ts         # Settings reader
│   ├── commands.ts       # Command registrations
│   ├── searchPanel.ts    # Quick-pick search UI
│   ├── settingsPanel.ts  # Settings webview
│   ├── indexStatusPanel.ts  # Index health panel
│   ├── statusBar.ts      # Status bar indicator
│   └── fileWatcher.ts    # Auto-reindex on save
├── mcp/            # Standalone MCP server
│   ├── server.ts      # MCP protocol entry point
│   ├── tools.ts       # Tool handlers
│   └── config.ts      # Environment-based configuration
test/
├── unit/           # Unit tests
└── integration/    # Integration tests
```

## Building

```bash
# Build both extension and MCP server
npm run build

# Watch mode (rebuilds on change)
npm run watch
```

The build uses esbuild with two separate configurations:

- `esbuild.extension.mjs` — bundles `src/extension/extension.ts` → `dist/extension.js`
- `esbuild.mcp.mjs` — bundles `src/mcp/server.ts` → `dist/mcp-server.js`

Both outputs are **CommonJS** (`format: "cjs"`). This is required because VS Code does not support ESM extensions.

### External Dependencies

These are not bundled by esbuild and must ship with the extension:

- `vscode` — provided by the VS Code runtime
- `@lancedb/lancedb` — native bindings (platform-specific)
- `@huggingface/transformers` — loaded at runtime

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npx vitest run test/unit/chunker.test.ts
```

Tests use Vitest and are located in `test/unit/` and `test/integration/`.

## Packaging

```bash
# Package for current platform
npm run package

# Platform-specific builds
npm run package:darwin-arm
npm run package:darwin-x64
npm run package:linux-x64
npm run package:win-x64
```

The package script runs `npm prune --omit=dev` before `vsce package` to exclude dev dependencies, then restores them with `npm install` afterward.

Platform-specific builds are necessary because `@lancedb/lancedb` includes native binaries.

Every packaged VSIX is checked by `scripts/verify-vsix.mjs` before it can be uploaded or published. Besides the required bundles and the size cap (80 MB), the check fails on any dev-only path (`src/`, `test/`, `.vscode/`, `CLAUDE.md`, ...) and on any credential-shaped file at any depth in the archive: `.env*`, `*.pem`, `*.key`, `.npmrc`, `id_*`, `*token*`, `*secret*`. The last three are name heuristics and exempt files with a code extension (`tokenizers.js` inside a library is fine; `token.json` is not). The rules are pure functions with unit tests in `test/unit/verify-vsix.test.ts`.

## Releasing

Releases are cut by `.github/workflows/publish-extension.yml`.

1. Bump `version` in `package.json` and move the `## [Unreleased]` entries in `CHANGELOG.md` under a new `## [X.Y.Z] - date` heading, in a PR to `main`.
2. Tag the merge commit `ext-vX.Y.Z` and push the tag. The tag must match `package.json`, or the workflow fails.

What the workflow then does, and the guarantees each step gives:

| Stage         | What happens                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait-for-ci` | Blocks until `ci.yml` has succeeded on the tagged commit. Nothing is packaged from a commit CI has not passed.                                  |
| `package`     | Builds one VSIX per target (darwin-arm64, darwin-x64, linux-x64, win32-x64), runs `verify-vsix.mjs`, then signs a build-provenance attestation. |
| `publish`     | Waits for approval on the `marketplace` environment, then uploads each VSIX to the VS Code Marketplace (idempotent on re-run).                  |
| `release`     | Waits for approval on the `marketplace` environment again, then creates the GitHub Release with the changelog section and the four VSIX assets. |

Manual runs (`workflow_dispatch`) behave the same, with one exception: `dry_run: true` packages only, skips the CI gate, signs nothing and publishes nothing. A dispatch with `dry_run: false` is a real publish and waits for CI like a tag push does.

Security properties of the pipeline:

- **Least privilege.** The workflow token is `contents: read` everywhere; `contents: write` exists only on the `release` job. The `package` matrix, which executes npm lifecycle scripts from third-party dependencies, never holds a token that can write to the repository.
- **Human approval before the Marketplace PAT is used.** The `publish` and `release` jobs run in the `marketplace` GitHub Environment. A required reviewer on that environment (repo Settings > Environments > marketplace) turns a tag push into a request that a maintainer approves in the Actions UI before the publish step can read `VSCODE_MARKETPLACE_PAT`.
- **Build provenance.** Each VSIX carries a SLSA provenance attestation signed by `actions/attest-build-provenance`. Verify a downloaded file with `gh attestation verify <file>.vsix --repo de-otio/mcp-doc-search`.
- **Pinned actions.** Every `uses:` in every workflow is pinned to a full commit SHA with a `# vX.Y.Z` comment; Dependabot's `github-actions` ecosystem bumps the SHA and the comment together. All pinned actions run on the `node24` runtime (or are composites of node24 actions).
- **Timeouts** on every job, so a wedged Marketplace call cannot burn the six-hour default.

## Key Design Decisions

### CommonJS output

Source files use ESM imports, but esbuild transpiles to CommonJS. The `package.json` must not have `"type": "module"` or VS Code will fail to load the extension.

### Heading-aware chunking

Splitting on markdown headings (rather than fixed character counts) preserves document structure and produces more semantically meaningful chunks.

### Hybrid search

Pure vector search can miss exact keyword matches. The keyword boost (0.03 per matching term, with camelCase expansion) ensures that documents containing the exact search terms rank higher.

### Stable chunk IDs

Using `MD5(file:lineNumber)` for chunk IDs means the same section always gets the same ID, allowing safe re-indexing without orphaned entries.

### Shared index

Both the VS Code extension and MCP server read/write the same LanceDB directory, keeping them in sync without coordination.

## Debugging

### Extension

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. Set breakpoints in `src/extension/` files
4. Use the Debug Console for output

### MCP Server

```bash
# Run the MCP server directly
DOC_SEARCH_WORKSPACE=/path/to/workspace node dist/mcp-server.js
```

The server communicates over stdio, so you'll see MCP protocol messages in the terminal.

## Adding a New Embedding Provider

1. Implement the `EmbedProvider` interface in `src/core/embedder.ts`
2. Add a case to `createEmbedProvider()` factory
3. Add the provider option to `docSearch.embedProvider` in `package.json` (contributes.configuration)
4. Update `src/extension/config.ts` to read any new settings
5. Update `src/mcp/config.ts` to read any new environment variables
