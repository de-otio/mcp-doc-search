import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTools, _resetStatusCache, attachStructuredContent } from "../../src/mcp/tools.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

vi.mock("../../src/core/searcher.js", () => ({
  search: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "line1\nline2\nline3\nline4\nline5"),
  // readRef's pre-read checks: size cap (statSync) and symlink containment
  // (realpathSync.native on both root and leaf; lstatSync in the crawl).
  statSync: vi.fn(() => ({ size: 100 })),
  lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
  realpathSync: Object.assign(
    vi.fn((p: string) => p),
    { native: vi.fn((p: string) => p) },
  ),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("glob", () => ({
  glob: vi.fn(async () => []),
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
      resolveRef: vi.fn(),
      getWorkspaceRoot: vi.fn(() => "/workspace"),
      rootForAbsPath: vi.fn(() => "/workspace"),
      keyForAbsPath: vi.fn((absPath: string) =>
        absPath.startsWith("/workspace/") ? absPath.slice("/workspace/".length) : absPath,
      ),
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

    // -----------------------------------------------------------------------
    // get & multi_get (Phase 5)
    // -----------------------------------------------------------------------

    it("get: returns file content with line bounds", async () => {
      const { readFileSync } = await import("node:fs");
      vi.mocked(readFileSync).mockReturnValue("line1\nline2\nline3\nline4\nline5");
      mockIndexer.resolveRef.mockReturnValue({
        file: "/workspace/doc/guide.md",
        docid: "abc123",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/guide.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.file).toContain("doc/guide.md");
      expect(parsed.docid).toBe("abc123");
      expect(parsed.content).toContain("line1");
      expect(parsed.lines).toHaveLength(2);
      expect(parsed.truncated).toBe(false);
    });

    it("get: enforces max_bytes and sets truncated=true", async () => {
      const { readFileSync } = await import("node:fs");
      vi.mocked(readFileSync).mockReturnValue("a".repeat(200));
      mockIndexer.resolveRef.mockReturnValue({
        file: "/workspace/doc/guide.md",
        docid: "abc123",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/guide.md", max_bytes: 10 } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.truncated).toBe(true);
      expect(parsed.content.length).toBeLessThanOrEqual(10);
    });

    // -----------------------------------------------------------------------
    // Sec 2.3: response caps and symlink containment in get / multi_get
    // -----------------------------------------------------------------------

    it("get: clamps max_bytes above the 1 MiB ceiling", async () => {
      const { readFileSync } = await import("node:fs");
      const { MAX_BYTES_CEILING } = await import("../../src/mcp/tools.js");
      // 1 MiB + 1 byte of content; the caller asks for far more than that.
      vi.mocked(readFileSync).mockReturnValue("a".repeat(MAX_BYTES_CEILING + 1));
      mockIndexer.resolveRef.mockReturnValue({ file: "/workspace/doc/big.md", docid: "b16b16" });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/big.md", max_bytes: 1e12 } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.truncated).toBe(true);
      expect(Buffer.byteLength(parsed.content, "utf8")).toBe(MAX_BYTES_CEILING);
    });

    it("get: clamps max_lines above the 5000-line ceiling (and defaults to it)", async () => {
      const { readFileSync } = await import("node:fs");
      const { MAX_LINES_CEILING } = await import("../../src/mcp/tools.js");
      const lines = Array.from({ length: MAX_LINES_CEILING + 10 }, (_, i) => `l${i + 1}`);
      vi.mocked(readFileSync).mockReturnValue(lines.join("\n"));
      mockIndexer.resolveRef.mockReturnValue({
        file: "/workspace/doc/long.md",
        docid: "10d6e5",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      for (const args of [
        { ref: "doc/long.md", max_lines: 1e9, max_bytes: 1e6 },
        { ref: "doc/long.md", max_bytes: 1e6 },
      ]) {
        const result = await callToolHandler({ params: { name: "get", arguments: args } });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.lines).toEqual([1, MAX_LINES_CEILING]);
        expect(parsed.content.split("\n")).toHaveLength(MAX_LINES_CEILING);
      }
    });

    it("get: refuses a file larger than the read ceiling before reading it", async () => {
      const { readFileSync, statSync } = await import("node:fs");
      const { MAX_FILE_BYTES } = await import("../../src/mcp/tools.js");
      vi.mocked(statSync).mockReturnValueOnce({ size: MAX_FILE_BYTES + 1 } as any);
      vi.mocked(readFileSync).mockClear();
      mockIndexer.resolveRef.mockReturnValue({
        file: "/workspace/doc/huge.md",
        docid: "0000ff",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/huge.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/too large/i);
      expect(parsed.error).not.toContain("/workspace");
      expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    });

    it("get: refuses a ref whose real path leaves the workspace via a symlink", async () => {
      const { readFileSync, realpathSync } = await import("node:fs");
      vi.mocked(readFileSync).mockClear();
      // Root canonicalizes to itself; the leaf canonicalizes to a path outside.
      vi.mocked(realpathSync.native).mockImplementation(((p: string) =>
        p === "/workspace/doc/link.md" ? "/home/victim/.ssh/id_ed25519" : p) as any);
      mockIndexer.resolveRef.mockReturnValue({
        file: "/workspace/doc/link.md",
        docid: "11a11a",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/link.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/symlink/i);
      expect(parsed.error).not.toContain("/home/victim");
      expect(parsed.error).not.toContain("/workspace");
      expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
      vi.mocked(realpathSync.native).mockImplementation(((p: string) => p) as any);
    });

    it("multi_get: caps a glob at 500 matches and reports the truncation", async () => {
      const { glob } = await import("glob");
      const { readFileSync } = await import("node:fs");
      const { MAX_GLOB_MATCHES } = await import("../../src/mcp/tools.js");
      const total = MAX_GLOB_MATCHES + 7;
      const matches = Array.from(
        { length: total },
        (_, i) => `doc/${String(i).padStart(4, "0")}.md`,
      );
      vi.mocked(glob).mockResolvedValue(matches);
      vi.mocked(readFileSync).mockReturnValue("x");
      mockIndexer.resolveRef.mockImplementation((ref: string) => ({
        file: `/workspace/${ref}`,
        docid: "abcdef",
      }));

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "multi_get", arguments: { refs: "doc/**/*.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.docs).toHaveLength(MAX_GLOB_MATCHES);
      expect(parsed.docs[0].file).toBe("doc/0000.md");
      expect(parsed.globTruncated).toEqual({ matched: total, limit: MAX_GLOB_MATCHES });
      // The glob is asked not to follow symlinked directories.
      expect(vi.mocked(glob).mock.calls[0]?.[1]).toMatchObject({ follow: false, nodir: true });
    });

    it("multi_get: omits the truncation marker when a glob fits the cap", async () => {
      const { glob } = await import("glob");
      const { readFileSync } = await import("node:fs");
      vi.mocked(glob).mockResolvedValue(["doc/a.md"]);
      vi.mocked(readFileSync).mockReturnValue("x");
      mockIndexer.resolveRef.mockReturnValue({ file: "/workspace/doc/a.md", docid: "abcdef" });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "multi_get", arguments: { refs: "doc/*.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.docs).toHaveLength(1);
      expect(parsed).not.toHaveProperty("globTruncated");
    });

    it("set_context: surfaces a ContextValidationError as a typed, path-free error", async () => {
      const { ContextValidationError } = await import("../../src/core/indexer.js");
      mockIndexer.setContext.mockImplementation(() => {
        throw new ContextValidationError("Context text exceeds 200 characters (got 201)");
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "set_context", arguments: { path: "doc", text: "x".repeat(201) } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("Context text exceeds 200 characters (got 201)");
      // A validation refusal is not an operator-facing error: nothing logged.
      expect(stderr).not.toHaveBeenCalled();
      stderr.mockRestore();
    });

    it("set_context: echoes the stored (sanitized) text and updatedAt", async () => {
      mockIndexer.setContext.mockReturnValue({
        text: "Roadmap (v2)",
        updatedAt: "2026-09-12T10:00:00.000Z",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "set_context", arguments: { path: "doc", text: "Roadmap [v2]" } },
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        status: "ok",
        text: "Roadmap (v2)",
        updatedAt: "2026-09-12T10:00:00.000Z",
      });
    });

    it("get: returns error for nonexistent ref", async () => {
      mockIndexer.resolveRef.mockReturnValue({ error: "File not found: doc/missing.md" });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/missing.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("not found");
    });

    it("multi_get: handles an array of refs", async () => {
      const { readFileSync } = await import("node:fs");
      vi.mocked(readFileSync).mockReturnValue("content here");
      mockIndexer.resolveRef
        .mockReturnValueOnce({ file: "/workspace/doc/a.md", docid: "aaa111" })
        .mockReturnValueOnce({ file: "/workspace/doc/b.md", docid: "bbb222" });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: {
          name: "multi_get",
          arguments: { refs: ["doc/a.md", "doc/b.md"] },
        },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.docs).toHaveLength(2);
      expect(parsed.errors).toHaveLength(0);
      expect(parsed.docs[0].docid).toBe("aaa111");
      expect(parsed.docs[1].docid).toBe("bbb222");
    });

    it("multi_get: handles comma-separated refs", async () => {
      const { readFileSync } = await import("node:fs");
      vi.mocked(readFileSync).mockReturnValue("comma content");
      mockIndexer.resolveRef
        .mockReturnValueOnce({ file: "/workspace/doc/x.md", docid: "xxx111" })
        .mockReturnValueOnce({ file: "/workspace/doc/y.md", docid: "yyy222" });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: {
          name: "multi_get",
          arguments: { refs: "doc/x.md, doc/y.md" },
        },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.docs).toHaveLength(2);
    });

    it("multi_get: handles glob pattern", async () => {
      const { glob } = await import("glob");
      const { readFileSync } = await import("node:fs");
      vi.mocked(glob).mockResolvedValue(["doc/a.md", "doc/b.md"]);
      vi.mocked(readFileSync).mockReturnValue("glob content");
      mockIndexer.resolveRef
        .mockReturnValueOnce({ file: "/workspace/doc/a.md", docid: "aaa111" })
        .mockReturnValueOnce({ file: "/workspace/doc/b.md", docid: "bbb222" });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: {
          name: "multi_get",
          arguments: { refs: "doc/**/*.md" },
        },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.docs).toHaveLength(2);
    });

    it("multi_get: collects per-ref errors without failing the batch", async () => {
      const { readFileSync } = await import("node:fs");
      vi.mocked(readFileSync).mockReturnValue("good content");
      mockIndexer.resolveRef
        .mockReturnValueOnce({ file: "/workspace/doc/good.md", docid: "ggg111" })
        .mockReturnValueOnce({ error: "File not found: doc/bad.md" });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: {
          name: "multi_get",
          arguments: { refs: ["doc/good.md", "doc/bad.md"] },
        },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.docs).toHaveLength(1);
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0].ref).toBe("doc/bad.md");
    });

    // -----------------------------------------------------------------------
    // Error paths (branch coverage)
    // -----------------------------------------------------------------------

    it("get: returns error when ref is empty string", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "  " } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("ref is required");
    });

    it("get: returns error when fs.readFileSync throws", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error("EACCES");
      });
      mockIndexer.resolveRef.mockReturnValue({
        file: "/workspace/doc/x.md",
        docid: "abc",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/x.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("EACCES");
    });

    it("get: returns error when file does not exist on disk", async () => {
      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValue(false);
      mockIndexer.resolveRef.mockReturnValue({
        file: "/workspace/doc/missing.md",
        docid: "abc",
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/missing.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("File not found");
    });

    it("set_context: returns error when path is empty", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "set_context", arguments: { path: "  ", text: "x" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("path is required");
    });

    it("set_context: catches and returns indexer errors", async () => {
      mockIndexer.setContext.mockImplementation(() => {
        throw new Error("absolute path not allowed");
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "set_context", arguments: { path: "/abs", text: "x" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("absolute path");
    });

    it("list_contexts: catches and returns indexer errors", async () => {
      mockIndexer.listContexts.mockImplementation(() => {
        throw new Error("disk error");
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "list_contexts", arguments: {} },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("disk error");
    });

    it("remove_context: returns error when path is empty", async () => {
      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "remove_context", arguments: { path: "" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("path is required");
    });

    it("remove_context: catches and returns indexer errors", async () => {
      mockIndexer.removeContext.mockImplementation(() => {
        throw new Error("write failed");
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "remove_context", arguments: { path: "doc/x" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("write failed");
    });

    it("multi_get: catches top-level errors", async () => {
      // Force a synchronous throw by making refs trigger an unexpected type
      mockIndexer.resolveRef.mockImplementation(() => {
        throw new Error("internal");
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "multi_get", arguments: { refs: ["doc/x.md"] } },
      });

      const parsed = JSON.parse(result.content[0].text);
      // A synchronous throw from resolveRef during the loop is caught by
      // the outer try/catch (which wraps the entire multi_get handler) and
      // returns a top-level error string.
      expect(parsed.error).toContain("internal");
    });

    // -----------------------------------------------------------------------
    // M3: error responses must never embed absolute filesystem paths.
    // -----------------------------------------------------------------------

    it("get: catch-handler strips absolute paths from a thrown Error", async () => {
      const { existsSync, readFileSync } = await import("node:fs");
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      // Use a workspace-internal path so we go past the !existsSync branch
      // and reach the readFileSync that we force to throw.
      mockIndexer.resolveRef.mockReturnValue({
        file: "/workspace/doc/x.md",
        docid: "abc123",
      });
      mockIndexer.getWorkspaceRoot.mockReturnValue("/workspace");
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error("blew up at /Users/alice/repos/secret-client/doc/x.md");
      });

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "get", arguments: { ref: "doc/x.md" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      const text = JSON.stringify(parsed);
      expect(text).not.toContain("/Users/alice");
      expect(text).not.toContain("secret-client");
      stderrSpy.mockRestore();
    });

    it("search_docs: catch-handler strips absolute paths", async () => {
      const { search } = await import("../../src/core/searcher.js");
      vi.mocked(search).mockRejectedValueOnce(
        new Error("Embedder failed at /Users/alice/.cache/transformers/foo.onnx"),
      );
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "search_docs", arguments: { query: "anything" } },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Embedder failed");
      expect(parsed.error).not.toContain("/Users/alice");
      stderrSpy.mockRestore();
    });

    it("reindex_docs: catch-handler strips absolute paths from passthrough errors", async () => {
      mockIndexer.reindex.mockRejectedValueOnce(
        new Error("OpenAI auth failed: see logs in /var/log/openai/audit.json"),
      );
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      registerTools(mockServer, {
        store: mockStore,
        indexer: mockIndexer,
        embedProvider: mockEmbedProvider,
      });

      const callToolHandler = vi.mocked(mockServer.setRequestHandler).mock.calls[1]?.[1];
      const result = await callToolHandler({
        params: { name: "reindex_docs", arguments: {} },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("OpenAI auth failed");
      expect(parsed.error).not.toContain("/var/log");
      stderrSpy.mockRestore();
    });
  });
});

describe("tool metadata: annotations, outputSchema, structuredContent", () => {
  const ALL_TOOLS = [
    "search_docs",
    "list_docs",
    "reindex_docs",
    "get",
    "multi_get",
    "set_context",
    "list_contexts",
    "remove_context",
  ];
  const READ_ONLY_TOOLS = ["search_docs", "get", "multi_get", "list_docs", "list_contexts"];
  const WRITE_TOOLS = ["reindex_docs", "set_context", "remove_context"];

  let mockServer: any;
  let deps: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetStatusCache();
    // Earlier suites replace the fs mock implementations (e.g. to throw);
    // clearAllMocks keeps those, so restore a readable file here.
    const nodeFs = await import("node:fs");
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue("line1\nline2\nline3");
    mockServer = { setRequestHandler: vi.fn() };
    deps = {
      store: { query: vi.fn(), listFiles: vi.fn() },
      indexer: {
        reindex: vi.fn(),
        getStatus: vi.fn().mockResolvedValue({
          totalFiles: 1,
          cachedFiles: 1,
          changedFiles: 0,
          newFiles: 0,
          deletedFiles: 0,
          chunkCount: 1,
          lastIndexed: new Date(),
          needsReindex: false,
          docGlob: "doc/**/*.md",
        }),
        listContexts: vi.fn().mockReturnValue({}),
        setContext: vi.fn(),
        removeContext: vi.fn(),
        getContextFor: vi.fn().mockReturnValue(""),
        resolveRef: vi.fn(),
        getWorkspaceRoot: vi.fn(() => "/workspace"),
        keyForAbsPath: vi.fn((absPath: string) => absPath.replace(/^\/workspace\//, "")),
        rootForAbsPath: vi.fn(() => "/workspace"),
      },
      embedProvider: { embed: vi.fn() },
    };
    registerTools(mockServer, deps);
  });

  async function listTools(): Promise<any[]> {
    const handler = vi.mocked(mockServer.setRequestHandler).mock.calls[0][1];
    return (await handler({})).tools;
  }

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const handler = vi.mocked(mockServer.setRequestHandler).mock.calls[1][1];
    return handler({ params: { name, arguments: args } });
  }

  it("registers list-tools before call-tool (tests index the handlers by position)", () => {
    expect(vi.mocked(mockServer.setRequestHandler).mock.calls).toHaveLength(2);
  });

  it("every tool carries annotations and an object outputSchema", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.outputSchema?.properties, tool.name).toBeDefined();
    }
  });

  it("marks readers read-only and writers non-destructive idempotent", async () => {
    const tools = await listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of READ_ONLY_TOOLS) {
      expect(byName[name].annotations, name).toEqual({ readOnlyHint: true });
    }
    for (const name of WRITE_TOOLS) {
      expect(byName[name].annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
  });

  it("declares a result-size hint on get and multi_get only", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const hint = tool._meta?.["anthropic/maxResultSizeChars"];
      if (tool.name === "get" || tool.name === "multi_get") {
        expect(typeof hint, tool.name).toBe("number");
        expect(hint, tool.name).toBeGreaterThan(10240);
      } else {
        expect(tool._meta, tool.name).toBeUndefined();
      }
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.multi_get._meta["anthropic/maxResultSizeChars"]).toBeGreaterThan(
      byName.get._meta["anthropic/maxResultSizeChars"],
    );
  });

  it("wraps the search_docs result array under results in structuredContent", async () => {
    const { search } = await import("../../src/core/searcher.js");
    const hits = [
      { file: "a.md", heading: "A", excerpt: "x", score: 0.5, lineStart: 1, docid: "abc123" },
    ];
    vi.mocked(search).mockResolvedValue(hits as any);

    const result = await callTool("search_docs", { query: "x" });

    expect(JSON.parse(result.content[0].text)).toEqual(hits);
    expect(result.structuredContent).toEqual({ results: hits });
  });

  it("wraps the list_docs result array under files in structuredContent", async () => {
    const files = [{ file: "a.md", title: "A" }];
    deps.store.listFiles.mockResolvedValue(files);

    const result = await callTool("list_docs");

    expect(JSON.parse(result.content[0].text)).toEqual(files);
    expect(result.structuredContent).toEqual({ files });
  });

  it.each([
    ["reindex_docs", { force: true }],
    ["get", { ref: "#abc123" }],
    ["multi_get", { refs: "a.md,#bad" }],
    ["set_context", { path: "doc", text: "Docs" }],
    ["list_contexts", {}],
    ["remove_context", { path: "doc" }],
  ])("%s: structuredContent equals the parsed text block", async (name, args) => {
    deps.indexer.reindex.mockResolvedValue({
      indexed: 1,
      skipped: 0,
      failedFiles: 0,
      totalChunks: 2,
      durationMs: 5,
      pruned: 0,
    });
    deps.indexer.resolveRef.mockImplementation((ref: string) =>
      ref === "#bad" ? { error: "Unknown ref" } : { file: "/workspace/a.md", docid: "abc123" },
    );
    deps.indexer.listContexts.mockReturnValue({ doc: "Docs" });
    deps.indexer.removeContext.mockReturnValue(true);

    const result = await callTool(name, args);

    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
    expect(result.structuredContent).not.toHaveProperty("error");
  });

  it("mirrors error payloads into structuredContent too", async () => {
    const result = await callTool("search_docs", { query: "   " });
    expect(result.structuredContent).toEqual({ error: "Query is required." });

    const unknown = await callTool("nope");
    expect(unknown.structuredContent).toEqual({ error: "Unknown tool: nope" });
  });

  describe("attachStructuredContent", () => {
    it("leaves non-JSON and multi-block results untouched", () => {
      const plain = { content: [{ type: "text" as const, text: "not json" }] };
      expect(attachStructuredContent("get", plain)).toBe(plain);

      const two = {
        content: [
          { type: "text" as const, text: "{}" },
          { type: "text" as const, text: "{}" },
        ],
      };
      expect(attachStructuredContent("get", two)).toBe(two);
    });

    it("does not overwrite structured content a handler already set", () => {
      const preset = {
        content: [{ type: "text" as const, text: '{"a":1}' }],
        structuredContent: { b: 2 },
      };
      expect(attachStructuredContent("get", preset)).toBe(preset);
    });

    it("wraps a bare array under a generic key for tools without a mapping", () => {
      const result = attachStructuredContent("custom", {
        content: [{ type: "text" as const, text: "[1,2]" }],
      });
      expect(result.structuredContent).toEqual({ items: [1, 2] });
    });

    it("ignores JSON scalars (structuredContent must be an object)", () => {
      const scalar = { content: [{ type: "text" as const, text: "42" }] };
      expect(attachStructuredContent("get", scalar)).toBe(scalar);
    });
  });
});
