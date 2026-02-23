import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { search } from "../core/searcher.js";
import type { EngineDeps } from "./config.js";

export function registerTools(server: Server, deps: EngineDeps): void {
  const { store, indexer, embedProvider } = deps;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_docs",
        description: [
          "Search project documentation semantically.",
          "",
          "Returns up to n results, each with:",
          "  - file: relative path to the markdown file",
          "  - heading: section heading where the match was found",
          "  - excerpt: relevant text snippet (up to 600 chars)",
          "  - score: cosine similarity (0–1, higher is better)",
          "  - line_start: approximate line number in the file",
          "",
          "Use this instead of Grep when you want semantic/natural-language search",
          "across doc/**/*.md. Falls back to empty list if index has not been built yet",
          "(run reindex_docs first).",
        ].join("\n"),
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
        description:
          "List all markdown files currently indexed, with their top-level heading/title.\nUseful for browsing available documentation before searching.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "reindex_docs",
        description: [
          "Rebuild the documentation search index.",
          "",
          "Crawls doc/**/*.md, splits files into sections, embeds each section,",
          "and upserts into the local ChromaDB vector store.",
          "",
          "Args:",
          "    force: if True, re-embed all files even if unchanged (slow).",
          "           Default is incremental — only changed files are re-processed.",
          "",
          "Returns stats: indexed (files changed), skipped (unchanged), total_chunks, duration_s.",
          "",
          "Run this after adding or significantly changing documentation.",
        ].join("\n"),
        inputSchema: {
          type: "object",
          properties: {
            force: { type: "boolean" },
          },
          required: [],
        },
      },
    ],
  }));

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
          content: [
            { type: "text", text: JSON.stringify({ error: String(err) }) },
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
            { type: "text", text: JSON.stringify({ error: String(err) }) },
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
            { type: "text", text: JSON.stringify({ error: String(err) }) },
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
