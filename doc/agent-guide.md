# Agent usage guide

How to use doc-search from an AI coding agent (Claude Code, or any MCP
client driving an LLM) so that a large markdown corpus stays cheap to
query. The advice here was distilled from running doc-search against a
multi-repo corpus of several thousand markdown files.

## Why this matters: agent token economics

In an agentic session, everything a tool returns enters the model's
context and is then **re-sent (and re-billed) on every subsequent turn**
of the session. Reading a 15 KB markdown file costs ~4k tokens once —
and then ~4k tokens × every remaining turn. Over a long session the
carrying cost dwarfs the read itself.

doc-search's tools are shaped to keep that carrying cost down:

- `search_docs` returns ~600-char chunks, not files.
- `get` / `multi_get` accept `#docid` refs plus `from_line`, `max_lines`,
  and `max_bytes` (default cap 10 KB), so confirmation reads stay scoped.

The savings only materialize if the agent actually uses them — hence the
patterns below.

## Retrieval patterns

1. **Search before reading.** For any conceptual question ("how does X
   work", "where is Y decided"), call `search_docs` with 2–3 query
   rephrasings rather than Grep-then-Read. Grep remains the right tool
   for exact strings, symbols, and code.
2. **Fetch scoped, not whole.** Follow up hits via their `#docid` with
   `from_line`/`max_lines`/`max_bytes` around the matched chunk. Reserve
   whole-file reads for files the agent is about to edit.
3. **Batch related fetches** with `multi_get` (comma list or glob)
   instead of sequential `get` calls.
4. **Trust `list_docs` for existence checks** ("is there a doc about X?")
   before assuming a doc needs to be written.

## Multi-repo corpora: federate, don't re-grep

When related repos each hold markdown (a notes/architecture hub plus
product repos), configure `docSearch.extraRoots` hub-and-spoke:

- The hub repo lists each sibling as an external root; results surface
  as `ext://<name>/<path>` refs, fetchable through the same scoped `get`.
- Siblings get the reverse link to the hub's doc tree.
- External roots refresh on reindex only (not on file save) — reindex
  after pulling a federated repo.

Without federation, cross-repo questions degrade into per-repo grep
sweeps — the most expensive access pattern an agent has.

## Delegate broad sweeps to subagents

When answering requires consulting more than a handful of documents,
have the main agent delegate to a subagent that performs the doc-search
queries and returns **synthesized findings only** (answer first,
`file:line` evidence, coverage note). The raw chunks then live in the
subagent's context and never enter the main session's per-turn bill.
This composes with federation: one subagent sweep can cover every
`ext://` root in a single index.

## Operational notes for agents

- The MCP server reads configuration **once at startup**. After changing
  globs or `extraRoots`, an in-session `reindex_docs` still uses the old
  config — reindex via the standalone CLI (same engine, same index) or
  restart the session.
- The index is centralized under `~/.doc-search/indexes/<workspace-key>`
  (see [configuration](configuration.md)); the in-tree
  `.doc-search-index/` layout is deprecated.
- Point `.mcp.json` (and shell invocations) at the **stable launcher**
  `~/.doc-search/bin/mcp-server.js` / `~/.doc-search/bin/mcp-doc-search.js`
  rather than the versioned extension install dir — the versioned path dies
  on every extension upgrade; the launcher is refreshed on activation and
  survives them.
- Sandboxed agent shells often block `localhost`: with the Ollama
  embedding provider, a CLI reindex then fails every file with a bare
  `fetch failed`. Run reindexes outside the sandbox (or allowlist
  localhost). A **single** file failing with a context-length message is
  different and benign — since 0.5.2 the embedder truncates and retries
  such chunks automatically.
- `search_docs` scores are 0–1 (vector similarity + keyword re-rank);
  results below ~0.5 are usually noise. An empty result for a topic the
  agent can see on disk means the index is stale — suggest a reindex
  rather than silently falling back to grep.
