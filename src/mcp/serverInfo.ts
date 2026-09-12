/**
 * Identity and usage guidance the MCP server reports during `initialize`.
 *
 * `__PKG_NAME__` / `__PKG_VERSION__` are substituted from package.json at
 * build time (esbuild `define` in esbuild.mcp.mjs, vitest `define` for the
 * test run). The `typeof` guard keeps an unbundled import (ts-node, a stray
 * `require` of the sources) from throwing a ReferenceError.
 */
declare const __PKG_NAME__: string;
declare const __PKG_VERSION__: string;

export const SERVER_INFO = {
  name: typeof __PKG_NAME__ === "string" ? __PKG_NAME__ : "mcp-doc-search",
  version: typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "0.0.0-dev",
} as const;

/**
 * Server-level instructions (MCP `InitializeResult.instructions`): the three
 * agent-guide rules, so a client that surfaces them steers its model toward
 * the token-efficient access pattern without any per-project prompt. Keep in
 * step with doc/agent-guide.md "Retrieval patterns" and "Delegate broad
 * sweeps to subagents".
 */
export const SERVER_INSTRUCTIONS = [
  "Doc Search: semantic search over this workspace's markdown documentation.",
  "",
  '1. Search before reading. For conceptual questions ("how does X work", "where is Y decided") call `search_docs` with 2-3 query rephrasings instead of grepping and reading whole files; grep stays right for exact strings, symbols and code.',
  "2. Fetch scoped, not whole. Follow up a hit with `get` on its `#docid` and `from_line`/`max_lines`/`max_bytes` around the matched chunk; batch related fetches with `multi_get`. Reserve whole-file reads for files you are about to edit.",
  "3. Delegate broad sweeps. When answering needs more than a handful of documents, hand the queries to a subagent that returns synthesized findings only (answer, `file:line` evidence, coverage note), so the raw chunks never enter the main context.",
].join("\n");
