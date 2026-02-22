# Getting Started

## Installation

### From the VS Code Marketplace

1. Open VS Code
2. Go to the Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search for "MCP Doc Search"
4. Click **Install**

### From a VSIX File

```bash
code --install-extension mcp-doc-search-0.1.0.vsix
```

Platform-specific builds are available for:
- macOS ARM (`darwin-arm64`)
- macOS Intel (`darwin-x64`)
- Linux (`linux-x64`)
- Windows (`win32-x64`)

## First-Time Setup

Once installed, the extension activates automatically when your workspace contains markdown files.

### 1. Configure Your Doc Glob (Optional)

By default, the extension indexes files matching `doc/**/*.md`. If your documentation lives elsewhere, update the glob pattern:

1. Open the command palette (`Cmd+Shift+P`)
2. Run **Doc Search: Open Settings**
3. Change the **Doc Glob** to match your documentation structure

Common patterns:
- `docs/**/*.md` — a `docs/` folder
- `**/*.md` — all markdown files in the workspace
- `wiki/**/*.md,guides/**/*.md` — multiple directories

### 2. Build the Index

The index builds automatically when you first search, but you can also trigger it manually:

1. Open the command palette (`Cmd+Shift+P`)
2. Run **Doc Search: Reindex Documentation**
3. Choose **Full Reindex** for the initial build

The status bar shows indexing progress. Subsequent reindexes are incremental — only changed files are re-embedded.

### 3. Search Your Docs

1. Open the command palette (`Cmd+Shift+P`)
2. Run **Doc Search: Search Documentation**
3. Type a natural language query
4. Select a result to jump directly to that section

### 4. Set Up Claude Code Integration (Optional)

To let Claude Code search your docs via MCP:

1. Open the command palette (`Cmd+Shift+P`)
2. Run **Doc Search: Generate .mcp.json**
3. A `.mcp.json` file is created in your workspace root
4. Claude Code will automatically detect and use the MCP server

## Walkthrough

The extension includes a built-in walkthrough. Access it via:

1. Open the command palette (`Cmd+Shift+P`)
2. Run **Doc Search: Open Walkthrough**

## Troubleshooting

### Index not building

- Check that your `docSearch.docGlob` pattern matches your files
- Ensure markdown files exist in your workspace
- Run **Doc Search: Open Index Status** to see diagnostics

### Search returns no results

- Verify the index has been built (check status bar)
- Try broader search terms
- Run a full reindex if the index may be stale

### Slow initial indexing

The first index build downloads the embedding model (~22MB) and processes all files. Subsequent runs are incremental and much faster. Consider using the Ollama or OpenAI provider for faster embedding of large documentation sets.
