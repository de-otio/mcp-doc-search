import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { search } from "../core/searcher.js";
import type { EngineDeps } from "./config.js";
import type { IndexStatus } from "../core/types.js";

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
    "Returns ~600-char chunks with `file:line` — typically saves a Read call.",
    "If results look stale, run `reindex_docs`.",
  ].join("\n");
}

function buildListDesc(status: IndexStatus | null): string {
  if (!status || status.totalFiles === 0) {
    return "List indexed markdown files. Index is currently empty — run `reindex_docs` first.";
  }
  const stale = status.needsReindex ? " (index may be stale — consider running `reindex_docs`)" : "";
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

export function registerTools(server: Server, deps: EngineDeps): void {
  const { store, indexer, embedProvider } = deps;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const status = await getCachedStatus(indexer);
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
        const results = await search(query, n, store, embedProvider);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
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
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
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
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
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
