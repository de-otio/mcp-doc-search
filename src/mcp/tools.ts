import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { search } from "../core/searcher.js";
import type { EngineDeps } from "./config.js";
import type { IndexStatus } from "../core/types.js";
import { sanitizeForClient } from "./errors.js";

// Cache for getStatus() results — refreshed at most every 30 seconds.
interface StatusCache {
  status: IndexStatus;
  fetchedAt: number;
}
let _statusCache: StatusCache | null = null;
const STATUS_TTL_MS = 30_000;

/** Exposed for tests: reset the module-level cache. */
export function _resetStatusCache(): void {
  _statusCache = null;
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 10) return "just now";
  if (diffSeconds < 60) return `${diffSeconds} seconds ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

async function getCachedStatus(
  indexer: EngineDeps["indexer"],
  nowMs = Date.now(),
): Promise<IndexStatus | null> {
  if (_statusCache && nowMs - _statusCache.fetchedAt < STATUS_TTL_MS) {
    return _statusCache.status;
  }
  try {
    const status = await indexer.getStatus();
    _statusCache = { status, fetchedAt: nowMs };
    return status;
  } catch {
    return null;
  }
}

const FALLBACK_SEARCH_DESC =
  "Index empty — run `reindex_docs` first to populate it. Once indexed, this tool provides semantic search across project documentation.";

function buildSearchDesc(status: IndexStatus | null): string {
  if (!status || status.totalFiles === 0) return FALLBACK_SEARCH_DESC;
  const when = status.lastIndexed ? relativeTime(status.lastIndexed) : "never";
  return [
    `Semantic search across ${status.totalFiles} indexed markdown files in \`${status.docGlob}\` (last reindexed ${when}, ${status.chunkCount} chunks).`,
    "",
    "**Prefer this over Grep when:** searching docs (not code), the query is conceptual rather than a known symbol, or grep would return >20 hits.",
    "Returns ~600-char chunks with `file:line` and a stable `docid` — pass `#docid` to `get` or `multi_get` to fetch full content without a Read call.",
    "If results look stale, run `reindex_docs`.",
  ].join("\n");
}

function buildListDesc(status: IndexStatus | null): string {
  if (!status || status.totalFiles === 0) {
    return "List indexed markdown files. Index is currently empty — run `reindex_docs` first.";
  }
  const stale = status.needsReindex
    ? " (index may be stale — consider running `reindex_docs`)"
    : "";
  return `List all ${status.totalFiles} markdown files currently in the index, with their top-level heading/title${stale}. Use before searching to confirm docs exist.`;
}

function buildReindexDesc(status: IndexStatus | null): string {
  if (!status || status.totalFiles === 0) {
    return [
      "Crawl, chunk, embed, and index markdown documentation files.",
      "",
      "Run this first to populate the index, then use `search_docs` for semantic search.",
      "Pass `force: true` to re-embed all files even if unchanged.",
    ].join("\n");
  }
  const staleNote = status.needsReindex
    ? ` ${status.newFiles + status.changedFiles} file(s) need re-indexing.`
    : " Index is up to date.";
  return [
    `Rebuild the documentation search index (currently ${status.totalFiles} files, ${status.chunkCount} chunks).${staleNote}`,
    "",
    "Use when: docs have changed, new files were added, or `search_docs` returns stale results.",
    "Pass `force: true` to re-embed all files (slow but thorough); default is incremental.",
  ].join("\n");
}

const DEFAULT_MAX_BYTES = 10240;

/** Determine if a string looks like a glob pattern. */
function isGlobPattern(s: string): boolean {
  return s.includes("*") || s.includes("?") || s.includes("[");
}

/**
 * Read file content, optionally starting from a 1-indexed line,
 * with max_lines and max_bytes limits.
 * Returns { content, lines: [from, to], truncated }.
 */
function readRef(
  absPath: string,
  fromLine: number,
  maxLines: number | undefined,
  maxBytes: number,
): { content: string; lines: [number, number]; truncated: boolean } {
  const rawContent = readFileSync(absPath, "utf8");
  const allLines = rawContent.split("\n");
  const totalLines = allLines.length;

  const startIdx = Math.max(0, fromLine - 1);
  const endIdx = maxLines !== undefined ? Math.min(startIdx + maxLines, totalLines) : totalLines;

  const slice = allLines.slice(startIdx, endIdx).join("\n");
  let content = slice;
  let truncated = false;

  const rawBytes = Buffer.byteLength(content, "utf8");
  if (rawBytes > maxBytes) {
    content = Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
    truncated = true;
  }

  const fromLineActual = startIdx + 1;
  const returnedLines = content.split("\n").length;
  const toLineActual = startIdx + returnedLines;

  return {
    content,
    lines: [fromLineActual, toLineActual],
    truncated,
  };
}

export function registerTools(server: Server, deps: EngineDeps): void {
  const { store, indexer, embedProvider } = deps;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const status = await getCachedStatus(indexer);
    const contextCount = Object.keys(indexer.listContexts()).length;
    return {
      tools: [
        {
          name: "search_docs",
          description: buildSearchDesc(status),
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              n: { type: "number" },
              explain: { type: "boolean" },
            },
            required: ["query"],
          },
        },
        {
          name: "list_docs",
          description: buildListDesc(status),
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "reindex_docs",
          description: buildReindexDesc(status),
          inputSchema: {
            type: "object",
            properties: {
              force: { type: "boolean" },
            },
            required: [],
          },
        },
        {
          name: "get",
          description: [
            "Retrieve the full content of a single documentation file.",
            "",
            "ref accepts:",
            "  - A relative file path (e.g. 'doc/foo.md')",
            "  - A docid with # prefix (e.g. '#abc123') — from search_docs results",
            "  - A bare 6-char hex docid (e.g. 'abc123')",
            "",
            "Returns { file, docid, content, lines: [from, to], truncated, error? }.",
            "Default max_bytes is 10240 (10 KB). If exceeded, content is truncated and truncated=true.",
            "from_line is 1-indexed.",
          ].join("\n"),
          inputSchema: {
            type: "object",
            properties: {
              ref: { type: "string", description: "File path, #docid, or bare 6-char docid" },
              from_line: { type: "number", description: "1-indexed start line (default: 1)" },
              max_lines: { type: "number", description: "Max lines to return (default: all)" },
              max_bytes: {
                type: "number",
                description: "Max bytes to return (default: 10240)",
              },
            },
            required: ["ref"],
          },
        },
        {
          name: "multi_get",
          description: [
            "Batch-retrieve multiple documentation files.",
            "",
            "refs accepts:",
            "  - A glob string (e.g. 'doc/01-business/**/*.md') — when it contains *, ?, or [",
            "  - A comma-separated string of refs (e.g. 'doc/foo.md, #abc123, doc/bar.md')",
            "  - An array of ref strings",
            "",
            "Each ref is a path, #docid, or bare 6-char hex docid.",
            "Returns { docs: Array<{ file, docid, content, lines, truncated }>, errors: Array<{ ref, error }> }.",
            "max_bytes is enforced per file. Errors are collected; one bad ref doesn't fail the batch.",
          ].join("\n"),
          inputSchema: {
            type: "object",
            properties: {
              refs: {
                oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                description:
                  "Glob pattern, comma-separated refs, or array of refs (paths / #docids / bare docids)",
              },
              from_line: { type: "number", description: "1-indexed start line (default: 1)" },
              max_lines: { type: "number", description: "Max lines per file (default: all)" },
              max_bytes: {
                type: "number",
                description: "Max bytes per file (default: 10240)",
              },
            },
            required: ["refs"],
          },
        },
        {
          name: "set_context",
          description: [
            "Add a one-line description of what kind of docs live under a path prefix.",
            "Subsequent search results from that subtree will include the context as",
            "[Context: ...] at the start of each excerpt.",
            "",
            "Args:",
            "  path: relative POSIX path prefix (e.g. 'doc/01-business'). Must not be",
            "        absolute or contain '..'.",
            "  text: short description (e.g. 'Product roadmap and feature specs').",
            "        Passing empty text removes the entry.",
            "",
            "Returns { status: 'ok' } on success.",
          ].join("\n"),
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              text: { type: "string" },
            },
            required: ["path", "text"],
          },
        },
        {
          name: "list_contexts",
          description: `List all ${contextCount} path-context mapping${contextCount === 1 ? "" : "s"} currently defined.\nEach entry is a path prefix mapped to a short description used to annotate search results.`,
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "remove_context",
          description: [
            "Remove the path-context entry for the given prefix.",
            "Returns { removed: true } if the entry existed, { removed: false } if not.",
          ].join("\n"),
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = (args ?? {}) as Record<string, unknown>;

    if (name === "search_docs") {
      try {
        const query = String(input.query ?? "").trim();
        if (!query) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Query is required." }) }],
          };
        }
        const n = Math.max(1, Math.min(100, Math.floor(Number(input.n) || 5)));
        const explain = input.explain === true;
        const results = await search(query, n, store, embedProvider, { explain }, indexer);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: sanitizeForClient(err, "search_docs") }),
            },
          ],
        };
      }
    }

    if (name === "list_docs") {
      try {
        const files = await store.listFiles();
        return {
          content: [{ type: "text", text: JSON.stringify(files) }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: sanitizeForClient(err, "list_docs") }) },
          ],
        };
      }
    }

    if (name === "reindex_docs") {
      try {
        const force = input.force === true;
        const stats = await indexer.reindex(force);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "ok", ...stats }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: sanitizeForClient(err, "reindex_docs") }),
            },
          ],
        };
      }
    }

    if (name === "get") {
      try {
        const ref = String(input.ref ?? "").trim();
        if (!ref) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "ref is required." }) }],
          };
        }
        const fromLine = input.from_line !== undefined ? Math.max(1, Number(input.from_line)) : 1;
        const maxLines =
          input.max_lines !== undefined ? Math.max(1, Number(input.max_lines)) : undefined;
        const maxBytes =
          input.max_bytes !== undefined ? Math.max(1, Number(input.max_bytes)) : DEFAULT_MAX_BYTES;

        const resolved = indexer.resolveRef(ref);
        if ("error" in resolved) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }],
          };
        }

        const { file: absPath, docid } = resolved;
        const relFile = path.relative(indexer.getWorkspaceRoot(), absPath).replace(/\\/g, "/");

        if (!existsSync(absPath)) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: `File not found: ${relFile}` }) },
            ],
          };
        }

        const { content, lines, truncated } = readRef(absPath, fromLine, maxLines, maxBytes);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ file: relFile, docid, content, lines, truncated }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: sanitizeForClient(err, "get") }) },
          ],
        };
      }
    }

    if (name === "multi_get") {
      try {
        const refsRaw = input.refs;
        const fromLine = input.from_line !== undefined ? Math.max(1, Number(input.from_line)) : 1;
        const maxLines =
          input.max_lines !== undefined ? Math.max(1, Number(input.max_lines)) : undefined;
        const maxBytes =
          input.max_bytes !== undefined ? Math.max(1, Number(input.max_bytes)) : DEFAULT_MAX_BYTES;

        let refList: string[] = [];

        if (Array.isArray(refsRaw)) {
          refList = refsRaw.map((r) => String(r).trim()).filter(Boolean);
        } else {
          const refsStr = String(refsRaw ?? "").trim();
          if (isGlobPattern(refsStr)) {
            const workspaceRoot = indexer.getWorkspaceRoot();
            const matched = await glob(refsStr, {
              cwd: workspaceRoot,
              ignore: ["**/node_modules/**"],
            });
            matched.sort();
            refList = matched;
          } else {
            refList = refsStr
              .split(",")
              .map((r) => r.trim())
              .filter(Boolean);
          }
        }

        const docs: Array<{
          file: string;
          docid: string;
          content: string;
          lines: [number, number];
          truncated: boolean;
        }> = [];
        const errors: Array<{ ref: string; error: string }> = [];

        for (const ref of refList) {
          const resolved = indexer.resolveRef(ref);
          if ("error" in resolved) {
            errors.push({ ref, error: resolved.error });
            continue;
          }

          const { file: absPath, docid } = resolved;
          const relFile = path.relative(indexer.getWorkspaceRoot(), absPath).replace(/\\/g, "/");

          if (!existsSync(absPath)) {
            errors.push({ ref, error: `File not found: ${relFile}` });
            continue;
          }

          try {
            const { content, lines, truncated } = readRef(absPath, fromLine, maxLines, maxBytes);
            docs.push({ file: relFile, docid, content, lines, truncated });
          } catch (fileErr) {
            errors.push({ ref, error: sanitizeForClient(fileErr, `multi_get:${ref}`) });
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ docs, errors }) }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: sanitizeForClient(err, "multi_get") }) },
          ],
        };
      }
    }

    if (name === "set_context") {
      try {
        const prefix = String(input.path ?? "").trim();
        const text = String(input.text ?? "");
        if (!prefix) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "path is required." }) }],
          };
        }
        indexer.setContext(prefix, text);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: sanitizeForClient(err, "set_context") }),
            },
          ],
        };
      }
    }

    if (name === "list_contexts") {
      try {
        const contexts = indexer.listContexts();
        return {
          content: [{ type: "text", text: JSON.stringify(contexts) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: sanitizeForClient(err, "list_contexts") }),
            },
          ],
        };
      }
    }

    if (name === "remove_context") {
      try {
        const prefix = String(input.path ?? "").trim();
        if (!prefix) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "path is required." }) }],
          };
        }
        const removed = indexer.removeContext(prefix);
        return {
          content: [{ type: "text", text: JSON.stringify({ removed }) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: sanitizeForClient(err, "remove_context") }),
            },
          ],
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
      ],
    };
  });
}
