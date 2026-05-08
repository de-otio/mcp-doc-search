import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTools, _resetStatusCache } from "../../src/mcp/tools.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

vi.mock("../../src/core/searcher.js", () => ({
  search: vi.fn(),
}));

describe("MCP Tools", () => {
  let mockServer: any;
  let mockStore: any;
  let mockIndexer: any;
  let mockEmbedProvider: any;

  const baseStatus = {
    totalFiles: 42,
    cachedFiles: 42,
    changedFiles: 0,
    newFiles: 0,
    deletedFiles: 0,
    chunkCount: 150,
    lastIndexed: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    needsReindex: false,
    docGlob: "docs/**/*.md",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStatusCache();

    mockStore = {
      query: vi.fn(),
      listFiles: vi.fn(),
    };

    mockIndexer = {
      reindex: vi.fn(),
      getStatus: vi.fn().mockResolvedValue(baseStatus),
      listContexts: vi.fn().mockReturnValue({}),
      setContext: vi.fn(),
      removeContext: vi.fn(),
      getContextFor: vi.fn().mockReturnValue(""),
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
      const { search } = await import("../../src/core/searcher.js");

      vi.mocked(search).mockResolvedValue([
        {
          file: "test.md",
          heading: "Test",
          content: "Test content",
          score: 0.95,
        },
      ]);

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
            arguments: { query: "test", n: 500 },
          },
        });

        // Verify that search was called with clamped n value (100, not 500)
        const searchMock = vi.mocked(search);
        expect(searchMock).toHaveBeenCalledWith(
          "test",
          100,
          mockStore,
          mockEmbedProvider,
          { explain: false },
          mockIndexer,
        );
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

    it("tool list includes set_context, list_contexts, and remove_context", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const listToolsHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[0]?.[1];
      const response = await listToolsHandler({});
      const toolNames = response.tools.map((t: any) => t.name);

      expect(toolNames).toContain("set_context");
      expect(toolNames).toContain("list_contexts");
      expect(toolNames).toContain("remove_context");
    });

    it("set_context calls indexer.setContext and returns status ok", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      const result = await callToolHandler({
        params: {
          name: "set_context",
          arguments: { path: "doc/01-business", text: "Product roadmap" },
        },
      });

      expect(mockIndexer.setContext).toHaveBeenCalledWith("doc/01-business", "Product roadmap");
      expect(JSON.parse(result.content[0].text)).toEqual({ status: "ok" });
    });

    it("set_context returns error when path is empty", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      const result = await callToolHandler({
        params: {
          name: "set_context",
          arguments: { path: "", text: "Some description" },
        },
      });

      expect(JSON.parse(result.content[0].text)).toHaveProperty("error");
      expect(mockIndexer.setContext).not.toHaveBeenCalled();
    });

    it("list_contexts returns current context map", async () => {
      const contexts = { "doc/01-business": "Roadmap", "doc/02-technical": "Tech docs" };
      mockIndexer.listContexts.mockReturnValue(contexts);

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      const result = await callToolHandler({
        params: { name: "list_contexts", arguments: {} },
      });

      expect(JSON.parse(result.content[0].text)).toEqual(contexts);
    });

    it("remove_context returns { removed: true } when entry exists", async () => {
      mockIndexer.removeContext.mockReturnValue(true);

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      const result = await callToolHandler({
        params: { name: "remove_context", arguments: { path: "doc/01-business" } },
      });

      expect(mockIndexer.removeContext).toHaveBeenCalledWith("doc/01-business");
      expect(JSON.parse(result.content[0].text)).toEqual({ removed: true });
    });

    it("remove_context returns { removed: false } when entry does not exist", async () => {
      mockIndexer.removeContext.mockReturnValue(false);

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];

      const result = await callToolHandler({
        params: { name: "remove_context", arguments: { path: "doc/non-existent" } },
      });

      expect(JSON.parse(result.content[0].text)).toEqual({ removed: false });
    });

    it("list_contexts description shows current count", async () => {
      mockIndexer.listContexts.mockReturnValue({
        "doc/01": "A",
        "doc/02": "B",
        "doc/03": "C",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const listToolsHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[0]?.[1];
      const response = await listToolsHandler({});
      const listContextsTool = response.tools.find((t: any) => t.name === "list_contexts");

      expect(listContextsTool.description).toContain("3");
    });
  });

  describe("dynamic tool descriptions", () => {
    async function getTools(server: any) {
      const handler = vi.mocked(server.setRequestHandler).mock.calls[0]?.[1];
      const result = await handler({});
      return result.tools as Array<{ name: string; description: string }>;
    }

    it("search_docs description includes file count and glob when index is populated", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const tools = await getTools(mockServer);
      const desc = tools.find((t) => t.name === "search_docs")!.description;

      expect(desc).toContain("42");
      expect(desc).toContain("docs/**/*.md");
      expect(desc).toContain("150");
    });

    it("search_docs description falls back to empty-index message when totalFiles === 0", async () => {
      mockIndexer.getStatus.mockResolvedValue({ ...baseStatus, totalFiles: 0 });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const tools = await getTools(mockServer);
      const desc = tools.find((t) => t.name === "search_docs")!.description;

      expect(desc).toContain("reindex_docs");
      expect(desc).toContain("Index empty");
    });

    it("search_docs description falls back gracefully when getStatus() throws", async () => {
      mockIndexer.getStatus.mockRejectedValue(new Error("store unavailable"));

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const tools = await getTools(mockServer);
      const desc = tools.find((t) => t.name === "search_docs")!.description;

      expect(desc).toContain("Index empty");
    });

    it("description does not contain absolute filesystem paths", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const tools = await getTools(mockServer);
      for (const tool of tools) {
        expect(tool.description).not.toMatch(/\/Users\//);
        expect(tool.description).not.toMatch(/\/home\//);
        expect(tool.description).not.toMatch(/C:\\/);
      }
    });

    it("status is cached within 30s window (getStatus called only once)", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      // Call listTools twice in succession
      const handler = vi.mocked(mockServer.setRequestHandler).mock.calls[0]?.[1];
      await handler({});
      await handler({});

      expect(mockIndexer.getStatus).toHaveBeenCalledTimes(1);
    });

    it("cache expires after 30s and getStatus is called again", async () => {
      const realDateNow = Date.now;
      let fakeNow = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

      try {
        registerTools(mockServer, {
          store: mockStore,
          indexer: mockIndexer,
          embedProvider: mockEmbedProvider,
        });

        const handler = vi.mocked(mockServer.setRequestHandler).mock.calls[0]?.[1];
        await handler({});
        expect(mockIndexer.getStatus).toHaveBeenCalledTimes(1);

        // Advance clock by 31 seconds
        fakeNow += 31_000;
        _resetStatusCache();

        await handler({});
        expect(mockIndexer.getStatus).toHaveBeenCalledTimes(2);
      } finally {
        vi.spyOn(Date, "now").mockRestore();
      }
    });
  });
});
