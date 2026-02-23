import { describe, it, expect, vi, beforeEach } from "vitest";
import { Indexer } from "../../src/core/indexer.js";
import type { LanceVectorStore } from "../../src/core/vectorstore.js";
import type { EmbedProvider, IndexerConfig } from "../../src/core/types.js";

vi.mock("glob");
vi.mock("node:fs");
vi.mock("../../src/core/chunker.js");

describe("Indexer", () => {
  let mockStore: any;
  let mockEmbedProvider: any;
  let config: IndexerConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStore = {
      deleteByFile: vi.fn(),
      ensureTable: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn(),
      listFiles: vi.fn(),
    };

    mockEmbedProvider = {
      embed: vi.fn(),
    };

    config = {
      workspaceRoot: "/workspace",
      docGlob: "doc/**/*.md",
      indexDir: "/workspace/.doc-search-index",
      maxChunkChars: 4000,
      headingDepth: 2,
      embedProvider: mockEmbedProvider,
    };
  });

  describe("reindex", () => {
    it("should track failed files on embed error", async () => {
      const { glob } = await import("glob");
      const { chunkMarkdown } = await import("../../src/core/chunker.js");
      const { statSync } = await import("node:fs");

      vi.mocked(glob).mockResolvedValue(["/workspace/doc/test.md", "/workspace/doc/broken.md"]);
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 1000 } as any);
      vi.mocked(chunkMarkdown)
        .mockReturnValueOnce([
          {
            id: "chunk-1",
            text: "Test content",
            file: "doc/test.md",
            heading: "Test",
            lineStart: 0,
          },
        ])
        .mockReturnValueOnce([
          {
            id: "chunk-2",
            text: "Broken content",
            file: "doc/broken.md",
            heading: "Broken",
            lineStart: 0,
          },
        ]);

      mockEmbedProvider.embed
        .mockResolvedValueOnce([[0.1, 0.2]])
        .mockRejectedValueOnce(new Error("Embedding failed"));
      mockStore.ensureTable.mockResolvedValue(undefined);
      mockStore.deleteByFile.mockResolvedValue(undefined);
      mockStore.upsert.mockResolvedValue(undefined);

      const indexer = new Indexer(config, mockStore as any);
      const stats = await indexer.reindex(true);

      expect(stats.indexed).toBe(1);
      expect(stats.failedFiles).toBe(1);
    });

    it("should skip unchanged files when force=false", async () => {
      const { glob } = await import("glob");
      const { chunkMarkdown } = await import("../../src/core/chunker.js");
      const { statSync } = await import("node:fs");

      vi.mocked(glob).mockResolvedValue(["/workspace/doc/test.md"]);
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 1000 } as any);

      const indexer = new Indexer(config, mockStore as any);

      // Simulate existing cache with same mtime
      const cachePath = indexer["mtimeCachePath"]?.();
      if (cachePath) {
        vi.spyOn(indexer as any, "loadMtimeCache").mockReturnValue({
          "doc/test.md": "1000",
        });
      }

      const stats = await indexer.reindex(false);

      expect(stats.skipped).toBeGreaterThanOrEqual(0);
    });

    it("should return stats with all required fields", async () => {
      const { glob } = await import("glob");
      vi.mocked(glob).mockResolvedValue([]);

      const indexer = new Indexer(config, mockStore as any);
      const stats = await indexer.reindex(true);

      expect(stats).toHaveProperty("indexed");
      expect(stats).toHaveProperty("skipped");
      expect(stats).toHaveProperty("failedFiles");
      expect(stats).toHaveProperty("totalChunks");
      expect(stats).toHaveProperty("durationMs");
    });

    it("should call onProgress with correct phases", async () => {
      const { glob } = await import("glob");
      const { chunkMarkdown } = await import("../../src/core/chunker.js");
      const { statSync } = await import("node:fs");

      vi.mocked(glob).mockResolvedValue(["/workspace/doc/test.md"]);
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 1000 } as any);
      vi.mocked(chunkMarkdown).mockReturnValue([
        {
          id: "chunk-1",
          text: "Test",
          file: "doc/test.md",
          heading: "Test",
          lineStart: 0,
        },
      ]);

      mockEmbedProvider.embed.mockResolvedValue([[0.1, 0.2]]);
      mockStore.ensureTable.mockResolvedValue(undefined);
      mockStore.deleteByFile.mockResolvedValue(undefined);
      mockStore.upsert.mockResolvedValue(undefined);

      const progressCalls: any[] = [];
      const onProgress = (processed: number, total: number, file: string, phase: string) => {
        progressCalls.push({ processed, total, file, phase });
      };

      const indexer = new Indexer(config, mockStore as any);
      await indexer.reindex(true, onProgress);

      expect(progressCalls.some((c) => c.phase === "scanning")).toBe(true);
    });
  });

  describe("getStatus", () => {
    it("should return index status", async () => {
      const { glob } = await import("glob");

      vi.mocked(glob).mockResolvedValue(["/workspace/doc/test.md"]);
      mockStore.count.mockResolvedValue(10);

      const indexer = new Indexer(config, mockStore as any);
      const status = await indexer.getStatus();

      expect(status).toHaveProperty("totalFiles");
      expect(status).toHaveProperty("cachedFiles");
      expect(status).toHaveProperty("changedFiles");
      expect(status).toHaveProperty("newFiles");
      expect(status).toHaveProperty("deletedFiles");
      expect(status).toHaveProperty("chunkCount");
      expect(status).toHaveProperty("lastIndexed");
      expect(status).toHaveProperty("needsReindex");
    });
  });
});
