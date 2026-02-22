# MCP Integration with Claude Code

MCP Doc Search exposes a Model Context Protocol (MCP) server that lets Claude Code search, list, and reindex your documentation directly. This works with both the **Claude Code VS Code extension** and the **Claude Code CLI**.

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
        "DOC_SEARCH_INDEX_DIR": ".claude/doc-index"
      }
    }
  }
}
```

### Step 2: Claude Code picks it up automatically

Claude Code (both the VS Code extension and the CLI) automatically reads `.mcp.json` from your workspace root. There is nothing else to configure.

- **Claude Code VS Code extension**: The next time you open the Claude Code panel in VS Code, it detects the `.mcp.json` and starts the MCP server. You will see a prompt asking you to approve the project-scoped MCP server the first time.
- **Claude Code CLI**: Run `claude` from the workspace root. It reads `.mcp.json` and connects to the server automatically.

### Step 3: Verify it works

Open Claude Code and ask something like:

> "Search my docs for getting started"

Claude will call the `search_docs` tool and return matching documentation sections. If you see results, everything is working.

### Troubleshooting

**"Tool not found" or Claude doesn't use the MCP tools**

- Make sure `.mcp.json` is in the **workspace root** (the folder you opened in VS Code)
- Reload the VS Code window (`Cmd+Shift+P` → **Developer: Reload Window**)
- In the Claude Code CLI, run `claude mcp list` to check if `doc-search` appears

**"No results" from search**

- The search index must be built first. Run **Doc Search: Reindex Documentation** from the command palette before using the MCP tools
- The MCP server shares the same index as the VS Code extension — if search works in the extension, it will work via MCP

**Server fails to start**

- Check that the `args` path in `.mcp.json` points to a valid file. Run:
  ```bash
  ls ~/.vscode/extensions/de-otio-org.mcp-doc-search-*/dist/mcp-server.js
  ```
- If you reinstalled the extension, regenerate `.mcp.json` (the path includes the version number)

## Manual setup (without the extension command)

If you prefer to configure the MCP server manually or via the CLI:

### Using the Claude Code CLI

```bash
claude mcp add doc-search \
  -s project \
  -e DOC_SEARCH_WORKSPACE=/absolute/path/to/workspace \
  -e DOC_SEARCH_GLOB="doc/**/*.md" \
  -e DOC_SEARCH_INDEX_DIR=".claude/doc-index" \
  -- node ~/.vscode/extensions/de-otio-org.mcp-doc-search-*/dist/mcp-server.js
```

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
        "DOC_SEARCH_INDEX_DIR": ".claude/doc-index"
      }
    }
  }
}
```

To find the extension path:
```bash
ls ~/.vscode/extensions/de-otio-org.mcp-doc-search-*/dist/mcp-server.js
```

## MCP Tools

Once connected, Claude Code can call three tools:

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

| Variable | Default | Description |
|----------|---------|-------------|
| `DOC_SEARCH_WORKSPACE` | `process.cwd()` | Absolute path to workspace root |
| `DOC_SEARCH_GLOB` | `doc/**/*.md` | File glob pattern |
| `DOC_SEARCH_INDEX_DIR` | `.claude/doc-index` | Index directory (relative to workspace) |
| `USE_OPENAI` | `0` | Set to `1` to use OpenAI embeddings |
| `OPENAI_API_KEY` | — | Required if `USE_OPENAI=1` |
| `OLLAMA_URL` | — | Ollama server URL (presence enables Ollama provider) |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama model name |

## Shared Index

The MCP server and VS Code extension share the same LanceDB index directory. This means:

- Files indexed by the extension are immediately searchable via MCP
- A reindex triggered from Claude Code updates the same index the extension uses
- Both must use the same embedding provider — switching providers in one requires a full reindex

## Usage Examples

Once configured, you can ask Claude Code things like:

- "Search my docs for how authentication works"
- "What does the API documentation say about rate limits?"
- "Reindex the documentation — I just added new files"
- "List all the documentation files in the index"

Claude Code will automatically call `search_docs`, `list_docs`, or `reindex_docs` as appropriate.
