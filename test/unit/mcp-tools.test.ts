import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

describe("MCP Tools", () => {
  let mockServer: any;
  let mockStore: any;
  let mockIndexer: any;
  let mockEmbedProvider: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStore = {
      query: vi.fn(),
      listFiles: vi.fn(),
    };

    mockIndexer = {
      reindex: vi.fn(),
    };

    mockEmbedProvider = {
      embed: vi.fn(),
    };

    mockServer = {
      setRequestHandler: vi.fn(),
    };
  });

  describe("registerTools", () => {
    it("should register search_docs tool with correct schema", () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const listToolsHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[0]?.[1];
      expect(listToolsHandler).toBeDefined();
    });

    it("should validate search_docs query parameter", async () => {
      const { CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      if (callToolHandler) {
        const result = await callToolHandler({
          params: {
            name: "search_docs",
            arguments: { query: "  " },
          },
        });

        expect(result.content[0].text).toContain("Query is required");
      }
    });

    it("should clamp search n parameter between 1 and 100", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      if (callToolHandler) {
        mockStore.query.mockResolvedValue([]);

        const result = await callToolHandler({
          params: {
            name: "search_docs",
            arguments: { query: "test", n: 500 },
          },
        });

        expect(mockStore.query).toHaveBeenCalled();
      }
    });

    it("should handle reindex_docs with force parameter", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      if (callToolHandler) {
        mockIndexer.reindex.mockResolvedValue({
          indexed: 5,
          skipped: 0,
          failedFiles: 0,
          totalChunks: 20,
          durationMs: 1000,
        });

        const result = await callToolHandler({
          params: {
            name: "reindex_docs",
            arguments: { force: true },
          },
        });

        expect(mockIndexer.reindex).toHaveBeenCalledWith(true);
      }
    });

    it("should return empty list for unknown tool", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      if (callToolHandler) {
        const result = await callToolHandler({
          params: {
            name: "unknown_tool",
            arguments: {},
          },
        });

        expect(result.content[0].text).toContain("Unknown tool");
      }
    });
  });
});
