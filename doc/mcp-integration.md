# MCP Integration with Claude Code

MCP Doc Search exposes a Model Context Protocol (MCP) server that lets Claude Code search, list, and reindex your documentation directly.

## Setup

### Automatic (via VS Code)

1. Open the command palette (`Cmd+Shift+P`)
2. Run **Doc Search: Generate .mcp.json**
3. A `.mcp.json` file is created in your workspace root

The generated file looks like:

```json
{
  "mcpServers": {
    "doc-search": {
      "command": "node",
      "args": ["/path/to/extension/dist/mcp-server.js"],
      "env": {
        "DOC_SEARCH_WORKSPACE": "/path/to/workspace",
        "DOC_SEARCH_GLOB": "doc/**/*.md",
        "DOC_SEARCH_INDEX_DIR": ".claude/doc-index"
      }
    }
  }
}
```

### Manual

Create `.mcp.json` in your workspace root with the structure above. Adjust the `args` path to point to your installed extension's `dist/mcp-server.js`.

To find the extension path:
```bash
ls ~/.vscode/extensions/de-otio-org.mcp-doc-search-*/dist/mcp-server.js
```

## MCP Tools

Claude Code can call these tools once the MCP server is configured:

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

The MCP server is configured via environment variables (set in `.mcp.json` or the shell):

| Variable | Default | Description |
|----------|---------|-------------|
| `DOC_SEARCH_WORKSPACE` | (required) | Absolute path to workspace root |
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

Once configured, Claude Code can naturally use the tools:

- "Search my docs for how authentication works"
- "What does the API documentation say about rate limits?"
- "Reindex the documentation — I just added new files"
- "List all the documentation files in the index"

Claude Code will automatically call `search_docs`, `list_docs`, or `reindex_docs` as appropriate.
