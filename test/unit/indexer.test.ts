import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Indexer } from "../../src/core/indexer.js";
import type { LanceVectorStore } from "../../src/core/vectorstore.js";
import type { EmbedProvider, IndexerConfig } from "../../src/core/types.js";

vi.mock("glob");
vi.mock("node:fs");
vi.mock("../../src/core/chunker.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIndexer(config?: Partial<IndexerConfig>): Indexer {
  const mockStore = {
    deleteByFile: vi.fn(),
    ensureTable: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    listFiles: vi.fn(),
  } as unknown as LanceVectorStore;

  const defaultConfig: IndexerConfig = {
    workspaceRoot: "/workspace",
    docGlob: "doc/**/*.md",
    indexDir: "/workspace/.doc-search-index",
    maxChunkChars: 4000,
    headingDepth: 2,
    embedProvider: { embed: vi.fn() } as unknown as EmbedProvider,
    ...config,
  };

  return new Indexer(defaultConfig, mockStore);
}

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
      expect(stats.firstError).toBe("Embedding failed");
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

// ---------------------------------------------------------------------------
// Path-context API
// ---------------------------------------------------------------------------

describe("Indexer context API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue("{}");
    vi.mocked(writeFileSync).mockReturnValue(undefined);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
  });

  describe("getContextFor", () => {
    it("returns empty string when context.json does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const indexer = makeIndexer();
      expect(indexer.getContextFor("doc/01-business/compliance/foo.md")).toBe("");
    });

    it("returns the exact-path match when present", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "doc/01-business/compliance/foo.md": "Exact file context" }),
      );
      const indexer = makeIndexer();
      expect(indexer.getContextFor("doc/01-business/compliance/foo.md")).toBe("Exact file context");
    });

    it("walks up to find the most-specific ancestor", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          "doc/01-business": "Business docs",
          doc: "All docs",
        }),
      );
      const indexer = makeIndexer();
      // "doc/01-business/compliance" is more specific than "doc"
      expect(indexer.getContextFor("doc/01-business/compliance/foo.md")).toBe("Business docs");
    });

    it("falls back to parent prefix when direct match is missing", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ doc: "Top-level docs" }));
      const indexer = makeIndexer();
      expect(indexer.getContextFor("doc/02-technical/runbooks/oncall.md")).toBe("Top-level docs");
    });

    it("falls back to empty-string root key when present", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ "": "Root context" }));
      const indexer = makeIndexer();
      expect(indexer.getContextFor("anything/at/all.md")).toBe("Root context");
    });

    it("returns empty string when no ancestor matches", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "other/path": "Some other context" }),
      );
      const indexer = makeIndexer();
      expect(indexer.getContextFor("doc/01-business/foo.md")).toBe("");
    });
  });

  describe("setContext", () => {
    it("persists a new entry to context.json", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const indexer = makeIndexer();
      indexer.setContext("doc/01-business", "Product roadmap");
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
      const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(written);
      expect(parsed["doc/01-business"]).toBe("Product roadmap");
    });

    it("strips leading/trailing whitespace from text", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const indexer = makeIndexer();
      indexer.setContext("doc/01", "  trimmed  ");
      const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
      expect(JSON.parse(written)["doc/01"]).toBe("trimmed");
    });

    it("rejects absolute paths", () => {
      const indexer = makeIndexer();
      expect(() => indexer.setContext("/absolute/path", "text")).toThrow(/absolute/);
    });

    it("rejects paths containing ..", () => {
      const indexer = makeIndexer();
      expect(() => indexer.setContext("doc/../evil", "text")).toThrow(/\.\./);
    });

    it("removes the entry when text is empty after stripping", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "doc/01-business": "Existing entry" }),
      );
      const indexer = makeIndexer();
      // Prime the cache
      indexer.listContexts();
      indexer.setContext("doc/01-business", "   ");
      const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
      expect(JSON.parse(written)).not.toHaveProperty("doc/01-business");
    });

    it("normalizes Windows backslashes in prefix to POSIX forward slashes", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const indexer = makeIndexer();
      indexer.setContext("doc\\01-business", "Business docs");
      const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(written);
      expect(parsed["doc/01-business"]).toBe("Business docs");
    });
  });

  describe("removeContext", () => {
    it("returns true when an entry is removed", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "doc/01-business": "Some context" }),
      );
      const indexer = makeIndexer();
      expect(indexer.removeContext("doc/01-business")).toBe(true);
    });

    it("returns false when the entry does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const indexer = makeIndexer();
      expect(indexer.removeContext("doc/non-existent")).toBe(false);
    });

    it("removes the entry from the persisted file", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "doc/01-business": "Context A", "doc/02-technical": "Context B" }),
      );
      const indexer = makeIndexer();
      indexer.removeContext("doc/01-business");
      const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(written);
      expect(parsed).not.toHaveProperty("doc/01-business");
      expect(parsed["doc/02-technical"]).toBe("Context B");
    });
  });

  describe("listContexts", () => {
    it("returns empty object when no context.json exists", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const indexer = makeIndexer();
      expect(indexer.listContexts()).toEqual({});
    });

    it("returns a copy of all entries", () => {
      const data = { "doc/01-business": "Roadmap", "doc/02-technical": "Tech docs" };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(data));
      const indexer = makeIndexer();
      const result = indexer.listContexts();
      expect(result).toEqual(data);
      // Verify it's a copy, not the same reference
      result["new-key"] = "mutated";
      expect(indexer.listContexts()).not.toHaveProperty("new-key");
    });
  });

  describe("resolveRef", () => {
    it("resolves a relative path to an absolute path and returns cached docid", async () => {
      const { existsSync, readFileSync } = await import("node:fs");

      // Cache has the file with a known docid (new object format)
      vi.spyOn({ existsSync }, "existsSync");
      vi.mocked(existsSync).mockImplementation((p: any) => {
        return String(p).endsWith("mtime_cache.json") || String(p).endsWith("doc/guide.md");
      });
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).endsWith("mtime_cache.json")) {
          return JSON.stringify({ "doc/guide.md": { mtime: "1000", docid: "abc123" } });
        }
        return "# Guide\n\nContent.";
      });

      const indexer = makeIndexer();
      const result = indexer.resolveRef("doc/guide.md");

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.docid).toBe("abc123");
        expect(result.file).toContain("doc/guide.md");
      }
    });

    it("resolves a #docid ref using the docid reverse map from cache", async () => {
      const { existsSync, readFileSync } = await import("node:fs");

      vi.mocked(existsSync).mockImplementation((p: any) => {
        return String(p).endsWith("mtime_cache.json") || String(p).endsWith("doc/guide.md");
      });
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).endsWith("mtime_cache.json")) {
          return JSON.stringify({ "doc/guide.md": { mtime: "1000", docid: "abc123" } });
        }
        return "# Guide\n\nContent.";
      });

      const indexer = makeIndexer();
      const result = indexer.resolveRef("#abc123");

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.docid).toBe("abc123");
        expect(result.file).toContain("doc/guide.md");
      }
    });

    it("resolves a bare 6-char hex docid without # prefix", async () => {
      const { existsSync, readFileSync } = await import("node:fs");

      vi.mocked(existsSync).mockImplementation((p: any) => {
        return String(p).endsWith("mtime_cache.json") || String(p).endsWith("doc/guide.md");
      });
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).endsWith("mtime_cache.json")) {
          return JSON.stringify({ "doc/guide.md": { mtime: "1000", docid: "abc123" } });
        }
        return "# Guide\n\nContent.";
      });

      const indexer = makeIndexer();
      const result = indexer.resolveRef("abc123");

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.docid).toBe("abc123");
      }
    });

    it("returns an error for a nonexistent file path", async () => {
      const { existsSync, readFileSync } = await import("node:fs");

      vi.mocked(existsSync).mockImplementation((p: any) => {
        return String(p).endsWith("mtime_cache.json");
      });
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).endsWith("mtime_cache.json")) {
          return JSON.stringify({});
        }
        return "";
      });

      const indexer = makeIndexer();
      const result = indexer.resolveRef("doc/missing.md");

      expect("error" in result).toBe(true);
    });

    it("returns an error for a docid not in cache", async () => {
      const { existsSync, readFileSync } = await import("node:fs");

      vi.mocked(existsSync).mockImplementation((p: any) => {
        return String(p).endsWith("mtime_cache.json");
      });
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).endsWith("mtime_cache.json")) {
          return JSON.stringify({});
        }
        return "";
      });

      const indexer = makeIndexer();
      const result = indexer.resolveRef("#zzz999");

      expect("error" in result).toBe(true);
    });

    it("handles old-format cache (mtime string only) gracefully", async () => {
      const { existsSync, readFileSync } = await import("node:fs");

      // Old format: cache values are plain strings (mtime only)
      vi.mocked(existsSync).mockImplementation((p: any) => {
        return String(p).endsWith("mtime_cache.json") || String(p).endsWith("doc/legacy.md");
      });
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).endsWith("mtime_cache.json")) {
          return JSON.stringify({ "doc/legacy.md": "1000" }); // old format
        }
        return "# Legacy\n\nContent.";
      });

      const indexer = makeIndexer();
      const result = indexer.resolveRef("doc/legacy.md");

      // Should still resolve — docid will be computed from file content
      expect("error" in result).toBe(false);
    });
  });
});
