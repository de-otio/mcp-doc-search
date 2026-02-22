# MCP Doc Search

Semantic search for your documentation — right inside VS Code and Claude Code.

## How it works

1. **Index** — Markdown files are split into heading-aware chunks and embedded into vectors
2. **Search** — Type a question and get the most relevant passages instantly
3. **MCP** — Claude Code can search your docs automatically via the built-in MCP server

## Embedding providers

| Provider | Setup | Quality | Offline |
|----------|-------|---------|---------|
| **Local** | None | Good | Yes |
| **Ollama** | Install Ollama | Better | Yes |
| **OpenAI** | API key | Best | No |
