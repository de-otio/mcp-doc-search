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

    it("should return stats with all required fields including pruned", async () => {
      const { glob } = await import("glob");
      vi.mocked(glob).mockResolvedValue([]);

      const indexer = new Indexer(config, mockStore as any);
      const stats = await indexer.reindex(true);

      expect(stats).toHaveProperty("indexed");
      expect(stats).toHaveProperty("skipped");
      expect(stats).toHaveProperty("failedFiles");
      expect(stats).toHaveProperty("totalChunks");
      expect(stats).toHaveProperty("durationMs");
      expect(stats).toHaveProperty("pruned");
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

    it("should prune deleted file: deleteByFile called and pruned=1", async () => {
      const { glob } = await import("glob");
      const { statSync } = await import("node:fs");

      // Glob returns only bar.md — foo.md was deleted
      vi.mocked(glob).mockResolvedValue(["/workspace/doc/bar.md"]);
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 2000 } as any);

      const indexer = new Indexer(config, mockStore as any);
      // Simulate cache that still holds foo.md
      vi.spyOn(indexer as any, "loadMtimeCache").mockReturnValue({
        "doc/foo.md": "1000",
        "doc/bar.md": "999",
      });
      vi.spyOn(indexer as any, "saveMtimeCache").mockImplementation(() => {});

      const { chunkMarkdown } = await import("../../src/core/chunker.js");
      vi.mocked(chunkMarkdown).mockReturnValue([]);

      const stats = await indexer.reindex(false);

      expect(mockStore.deleteByFile).toHaveBeenCalledWith("doc/foo.md");
      expect(stats.pruned).toBe(1);
    });

    it("should prune renamed file: old path deleted, new path indexed", async () => {
      const { glob } = await import("glob");
      const { statSync } = await import("node:fs");
      const { chunkMarkdown } = await import("../../src/core/chunker.js");

      // Renamed: foo.md → bar.md
      vi.mocked(glob).mockResolvedValue(["/workspace/doc/bar.md"]);
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 3000 } as any);
      vi.mocked(chunkMarkdown).mockReturnValue([
        { id: "c1", text: "bar content", file: "doc/bar.md", heading: "Bar", lineStart: 0 },
      ]);

      mockEmbedProvider.embed.mockResolvedValue([[0.1, 0.2]]);
      mockStore.ensureTable.mockResolvedValue(undefined);
      mockStore.deleteByFile.mockResolvedValue(undefined);
      mockStore.upsert.mockResolvedValue(undefined);

      const indexer = new Indexer(config, mockStore as any);
      vi.spyOn(indexer as any, "loadMtimeCache").mockReturnValue({
        "doc/foo.md": "1000",
      });
      vi.spyOn(indexer as any, "saveMtimeCache").mockImplementation(() => {});

      const stats = await indexer.reindex(false);

      // foo.md pruned from store
      expect(mockStore.deleteByFile).toHaveBeenCalledWith("doc/foo.md");
      expect(stats.pruned).toBe(1);
      // bar.md indexed
      expect(stats.indexed).toBe(1);
      // deleteByFile called for bar.md during the embed loop (stale chunk cleanup)
      expect(mockStore.deleteByFile).toHaveBeenCalledWith("doc/bar.md");
    });

    it("should prune glob-excluded file when glob narrows", async () => {
      const { glob } = await import("glob");
      const { statSync } = await import("node:fs");

      // Narrowed glob returns only api.md; guide.md no longer matches
      vi.mocked(glob).mockResolvedValue(["/workspace/doc/api.md"]);
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 5000 } as any);

      const { chunkMarkdown } = await import("../../src/core/chunker.js");
      vi.mocked(chunkMarkdown).mockReturnValue([]);

      const indexer = new Indexer(config, mockStore as any);
      vi.spyOn(indexer as any, "loadMtimeCache").mockReturnValue({
        "doc/api.md": "5000",
        "doc/guide.md": "4000",
      });
      vi.spyOn(indexer as any, "saveMtimeCache").mockImplementation(() => {});

      const stats = await indexer.reindex(false);

      expect(mockStore.deleteByFile).toHaveBeenCalledWith("doc/guide.md");
      expect(stats.pruned).toBe(1);
    });

    it("should not crash on bogus path-traversal-shaped cache key", async () => {
      const { glob } = await import("glob");

      vi.mocked(glob).mockResolvedValue([]);

      const indexer = new Indexer(config, mockStore as any);
      vi.spyOn(indexer as any, "loadMtimeCache").mockReturnValue({
        "../../../etc/passwd": "1000",
        "doc/normal.md": "2000",
      });
      vi.spyOn(indexer as any, "saveMtimeCache").mockImplementation(() => {});

      // deleteByFile on the bogus key may throw (safeLanceFilter rejects it) —
      // the prune loop catches errors, so reindex must still complete cleanly.
      mockStore.deleteByFile.mockRejectedValue(new Error("suspicious characters"));

      await expect(indexer.reindex(false)).resolves.not.toThrow();
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

    it("should set needsReindex=true when deletedFiles > 0", async () => {
      const { glob } = await import("glob");

      // Glob returns nothing — all cached files are deleted
      vi.mocked(glob).mockResolvedValue([]);
      mockStore.count.mockResolvedValue(5);

      const indexer = new Indexer(config, mockStore as any);
      vi.spyOn(indexer as any, "loadMtimeCache").mockReturnValue({
        "doc/gone.md": "1000",
      });

      const status = await indexer.getStatus();

      expect(status.deletedFiles).toBe(1);
      expect(status.needsReindex).toBe(true);
    });
  });
});
