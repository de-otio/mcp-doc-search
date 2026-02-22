# MCP Doc Search

MCP Doc Search is a semantic documentation search system that combines a VS Code extension with a standalone MCP server. It enables natural language search across markdown documentation using local AI embeddings — no API keys required by default.

## Key Features

- **Hybrid search** — vector similarity combined with keyword re-ranking for accurate results
- **Heading-aware chunking** — splits markdown on `#`/`##` boundaries, preserving document structure
- **Local embeddings** — uses `all-MiniLM-L6-v2` (ONNX, 22MB) out of the box
- **Incremental indexing** — only re-embeds files that have changed (mtime-based caching)
- **Dual deployment** — same core engine powers both the VS Code extension and the MCP server
- **Zero configuration** — works immediately with sensible defaults

## How It Works

1. **Index** your markdown documentation (automatically on file save, or manually)
2. **Search** using natural language queries from VS Code or any MCP-compatible AI assistant
3. **Navigate** directly to the relevant section in your docs

The system chunks your markdown files at heading boundaries, generates vector embeddings for each chunk, and stores them in a local LanceDB database. When you search, your query is embedded and matched against the stored vectors, then re-ranked with keyword boosting for the best results.

## Components

| Component | Description |
|-----------|-------------|
| **Core Engine** (`src/core/`) | Framework-agnostic search engine — chunking, embedding, indexing, and search |
| **VS Code Extension** (`src/extension/`) | UI integration — search panel, status bar, settings, file watcher |
| **MCP Server** (`src/mcp/`) | MCP integration — exposes search, list, and reindex as MCP tools |

## Embedding Providers

| Provider | Dimensions | Requirements | Quality |
|----------|-----------|--------------|---------|
| **Local** (default) | 384 | None — bundled ONNX model | Good |
| **Ollama** | 768 | Local Ollama server running | Better |
| **OpenAI** | 1536 | API key | Best |

## Further Reading

- [Getting Started](getting-started.md) — installation and first-time setup
- [Configuration](configuration.md) — all settings and options
- [Architecture](architecture.md) — technical deep dive
- [MCP Integration](mcp-integration.md) — using with MCP-compatible AI assistants
- [Development](development.md) — contributing and building from source
