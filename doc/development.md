# Development Guide

## Prerequisites

- Node.js 18+
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
