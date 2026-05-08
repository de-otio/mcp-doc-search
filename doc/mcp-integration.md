# MCP Integration

MCP Doc Search exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets any MCP-compatible AI assistant search, list, and reindex your documentation directly. This works with Claude Code, Cursor, and any other client that supports MCP.

## Setup

### Step 1: Generate the configuration file

1. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **Doc Search: Generate .mcp.json**
3. A `.mcp.json` file is created in your workspace root

The generated file includes your current settings and looks like this:

```json
{
  "mcpServers": {
    "doc-search": {
      "command": "node",
      "args": ["/path/to/extension/dist/mcp-server.js"],
      "env": {
        "DOC_SEARCH_WORKSPACE": "/path/to/your/workspace",
        "DOC_SEARCH_GLOB": "doc/**/*.md",
        "DOC_SEARCH_INDEX_DIR": ".doc-search-index"
      }
    }
  }
}
```

### Step 2: Connect your MCP client

Point your MCP client at the generated `.mcp.json`. Most clients read it automatically from the workspace root.

**Claude Code** (VS Code extension or CLI): detects `.mcp.json` automatically. You will see a prompt to approve the project-scoped MCP server the first time.

**Claude Code CLI:**

```bash
claude mcp list   # verify doc-search appears
```

**Other clients:** refer to your client's documentation for how to load an `.mcp.json` or configure a stdio MCP server.

### Step 3: Verify it works

Ask your AI assistant something like:

> "Search my docs for getting started"

It will call the `search_docs` tool and return matching documentation sections.

### Troubleshooting

**"Tool not found" or the assistant doesn't use MCP tools**

- Make sure `.mcp.json` is in the **workspace root** (the folder you opened in your editor)
- Reload the window or restart the client
- For Claude Code CLI: run `claude mcp list` to check if `doc-search` appears

**"No results" from search**

- The search index must be built first. Run **Doc Search: Reindex Documentation** from the command palette before using the MCP tools
- The MCP server shares the same index as the VS Code extension — if search works in the extension, it will work via MCP

**Server fails to start**

- Check that the `args` path in `.mcp.json` points to a valid file. Run:
  ```bash
  ls ~/.vscode/extensions/de-otio.mcp-doc-search-*/dist/mcp-server.js
  ```
- If you reinstalled the extension, regenerate `.mcp.json` (the path includes the version number)

## Manual setup (without the extension command)

If you prefer to configure the MCP server manually:

### Creating .mcp.json by hand

Create `.mcp.json` in your workspace root:

```json
{
  "mcpServers": {
    "doc-search": {
      "command": "node",
      "args": ["<path-to-extension>/dist/mcp-server.js"],
      "env": {
        "DOC_SEARCH_WORKSPACE": "<absolute-path-to-workspace>",
        "DOC_SEARCH_GLOB": "doc/**/*.md",
        "DOC_SEARCH_INDEX_DIR": ".doc-search-index"
      }
    }
  }
}
```

To find the extension path:

```bash
ls ~/.vscode/extensions/de-otio.mcp-doc-search-*/dist/mcp-server.js
```

### Using the Claude Code CLI

```bash
claude mcp add doc-search \
  -s project \
  -e DOC_SEARCH_WORKSPACE=/absolute/path/to/workspace \
  -e DOC_SEARCH_GLOB="doc/**/*.md" \
  -e DOC_SEARCH_INDEX_DIR=".doc-search-index" \
  -- node ~/.vscode/extensions/de-otio.mcp-doc-search-*/dist/mcp-server.js
```

## MCP Tools

Once connected, the assistant can call three tools:

### search_docs

Search documentation using natural language.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `query` | string | (required) | Natural language search query |
| `n` | number | 5 | Maximum number of results to return |

**Returns:** Array of search results, each containing:

- `file` — relative path to the source file
- `heading` — the section heading
- `text` — chunk text content
- `lineStart` — line number in the source file
- `score` — relevance score (0-1, higher is better)

### list_docs

List all indexed documentation files.

**Parameters:** None

**Returns:** Array of `{file, title}` objects for every indexed file.

### reindex_docs

Trigger a documentation reindex.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `force` | boolean | false | If true, reindex all files. If false, only changed files. |

**Returns:** Index statistics:

- `indexed` — number of files processed
- `skipped` — number of unchanged files skipped
- `totalChunks` — total chunks in the index
- `durationMs` — time taken in milliseconds

## Environment Variables

The MCP server is configured via the `env` block in `.mcp.json`. The **Generate .mcp.json** command fills these in automatically from your extension settings.

| Variable               | Default             | Description                                          |
| ---------------------- | ------------------- | ---------------------------------------------------- |
| `DOC_SEARCH_WORKSPACE` | `process.cwd()`     | Absolute path to workspace root                      |
| `DOC_SEARCH_GLOB`      | `doc/**/*.md`       | File glob pattern                                    |
| `DOC_SEARCH_INDEX_DIR` | `.doc-search-index` | Index directory (relative to workspace)              |
| `USE_OPENAI`           | `0`                 | Set to `1` to use OpenAI embeddings                  |
| `OPENAI_API_KEY`       | —                   | Required if `USE_OPENAI=1`                           |
| `OLLAMA_URL`           | —                   | Ollama server URL (presence enables Ollama provider) |
| `OLLAMA_MODEL`         | `nomic-embed-text`  | Ollama model name                                    |

## Shared Index

The MCP server and VS Code extension share the same LanceDB index directory. This means:

- Files indexed by the extension are immediately searchable via MCP
- A reindex triggered via MCP updates the same index the extension uses
- Both must use the same embedding provider — switching providers in one requires a full reindex
