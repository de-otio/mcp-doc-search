import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  LanceVectorStore,
  fileHashKey,
  isStaleHandleError,
  COMPACT_GRACE_MS,
} from "../../src/core/vectorstore.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// Mock LanceDB
vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(),
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}));

describe("LanceVectorStore", () => {
  let mockTable: any;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTable = {
      schema: vi.fn(),
      delete: vi.fn(),
      add: vi.fn(),
      search: vi.fn(),
      query: vi.fn(),
      countRows: vi.fn(),
      optimize: vi.fn(),
      listIndices: vi.fn().mockResolvedValue([]),
      createIndex: vi.fn(),
    };

    mockDb = {
      openTable: vi.fn(),
      createTable: vi.fn(),
      dropTable: vi.fn(),
    };
  });

  describe("open", () => {
    it("should open database connection", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      expect(store.isOpen()).toBe(true);
    });

    it("should handle missing table gracefully", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockRejectedValue(new Error("Table not found"));

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      expect(store.isOpen()).toBe(true);
      expect(store.hasTable()).toBe(false);
    });
  });

  describe("ensureTable", () => {
    it("should create table if not exists", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockRejectedValue(new Error("Not found"));
      mockDb.createTable.mockResolvedValue(mockTable);
      mockTable.delete.mockResolvedValue(undefined);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.ensureTable(384);

      expect(mockDb.createTable).toHaveBeenCalled();
      expect(store.hasTable()).toBe(true);
    });

    it("drops and recreates an EMPTY table on dimension mismatch", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.schema.mockResolvedValue({
        fields: [{ name: "vector", type: { listSize: 768 } }],
      });
      mockTable.countRows.mockResolvedValue(0);
      mockDb.createTable.mockResolvedValue(mockTable);
      mockTable.delete.mockResolvedValue(undefined);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.ensureTable(384);

      expect(mockDb.dropTable).toHaveBeenCalledWith("doc_chunks");
      expect(mockDb.createTable).toHaveBeenCalled();
    });

    it("refuses to drop a POPULATED table on dimension mismatch, naming both sides", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.schema.mockResolvedValue({
        fields: [{ name: "vector", type: { listSize: 768 } }],
      });
      mockTable.countRows.mockResolvedValue(5431);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      // Every deliberate rebuild drops the table first, so a populated table
      // here means the mismatch went undetected — destroying it silently is
      // how a second runner's index disappears without anyone asking.
      await expect(store.ensureTable(384)).rejects.toThrow(
        /5431 rows of 768-dimension vectors and this process embeds at 384/,
      );
      expect(mockDb.dropTable).not.toHaveBeenCalled();
    });
  });

  describe("upsert", () => {
    it("should add records to table", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      const records = [
        {
          id: "test-1",
          vector: [0.1, 0.2],
          file: "test.md",
          heading: "Test",
          lineStart: 0,
          text: "Test content",
        },
      ];

      await store.upsert(records);

      // Each row is stored with the sha256 of its key, which deleteByFile filters on.
      expect(mockTable.add).toHaveBeenCalledWith([{ ...records[0], fileHash: sha256("test.md") }]);
    });

    it("should throw error if table not initialized", async () => {
      const store = new LanceVectorStore("/tmp/index");

      const records = [
        {
          id: "test-1",
          vector: [0.1],
          file: "test.md",
          heading: "Test",
          lineStart: 0,
          text: "Test",
        },
      ];

      await expect(store.upsert(records)).rejects.toThrow("Table not initialized");
    });
  });

  describe("query", () => {
    it("should return query results", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const mockResults = [
        {
          file: "test.md",
          heading: "Test",
          lineStart: 0,
          text: "Test content",
          _distance: 0.1,
        },
      ];

      mockTable.search.mockReturnValue({
        distanceType: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(mockResults),
          }),
        }),
      });

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      const results = await store.query([0.1, 0.2], 10);

      expect(results).toHaveLength(1);
      expect(results[0].file).toBe("test.md");
    });

    it("should return empty list if table not exists", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockRejectedValue(new Error("Not found"));

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      const results = await store.query([0.1, 0.2], 10);

      expect(results).toEqual([]);
    });
  });

  describe("stale table handles", () => {
    const manifestGone = (): Error =>
      new Error(
        "Failed to execute query stream: GenericFailure, lance error: Not found: " +
          "/idx/doc_chunks.lance/_versions/1352.manifest",
      );

    /** search() that throws the given error once, then returns rows. */
    function searchFailingOnce(err: Error, rows: unknown[]): () => unknown {
      let calls = 0;
      return () => ({
        distanceType: () => ({
          limit: () => ({
            toArray: async () => {
              if (calls++ === 0) throw err;
              return rows;
            },
          }),
        }),
      });
    }

    it("recognises a vanished manifest and nothing else", () => {
      expect(isStaleHandleError(manifestGone())).toBe(true);
      // The form a compacted-away data fragment produces (observed against
      // LanceDB 0.13: a search on a stale handle reports the missing file, not
      // the missing manifest).
      expect(
        isStaleHandleError(
          new Error(
            "Failed to get next batch from stream: lance error: LanceError(IO): " +
              "Execution error: Not found: /idx/doc_chunks.lance/data/f0f748c3.lance",
          ),
        ),
      ).toBe(true);
      // A missing table is also "Not found" — it must not be read as a stale
      // handle, or open() would be retried pointlessly on every empty index.
      expect(isStaleHandleError(new Error("Not found: table doc_chunks"))).toBe(false);
      expect(isStaleHandleError(new Error("boom"))).toBe(false);
      expect(isStaleHandleError("Not found: x/1.manifest")).toBe(true);
    });

    it("checks out the latest version and retries the query once", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.checkoutLatest = vi.fn().mockResolvedValue(undefined);
      mockTable.search.mockImplementation(
        searchFailingOnce(manifestGone(), [
          { file: "a.md", heading: "A", lineStart: 0, text: "x", _distance: 0.2 },
        ]),
      );

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      const results = await store.query([0.1, 0.2], 10);

      expect(mockTable.checkoutLatest).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0].file).toBe("a.md");
    });

    it("reconnects when the handle has no checkoutLatest", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.query.mockReturnValueOnce({
        toArray: vi.fn().mockRejectedValue(manifestGone()),
      });
      mockTable.query.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([{ file: "a.md", heading: "A" }]),
      });

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      expect(await store.listFiles()).toEqual([{ file: "a.md", title: "A" }]);
      // open() ran twice: once for the initial open, once to re-resolve.
      expect(vi.mocked(lancedb.connect)).toHaveBeenCalledTimes(2);
    });

    it("retries count() and fullTextQuery() too", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.checkoutLatest = vi.fn().mockResolvedValue(undefined);
      mockTable.countRows.mockRejectedValueOnce(manifestGone()).mockResolvedValueOnce(42);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      expect(await store.count()).toBe(42);

      const ftsRows = [{ file: "a.md", heading: "A", lineStart: 0, text: "x", _score: 1 }];
      let ftsCalls = 0;
      mockTable.query.mockReturnValue({
        fullTextSearch: () => ({
          limit: () => ({
            toArray: async () => {
              if (ftsCalls++ === 0) throw manifestGone();
              return ftsRows;
            },
          }),
        }),
      });
      expect(await store.fullTextQuery("needle", 5)).toHaveLength(1);
    });

    it("propagates a second failure instead of looping", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.checkoutLatest = vi.fn().mockResolvedValue(undefined);
      mockTable.search.mockReturnValue({
        distanceType: () => ({
          limit: () => ({ toArray: vi.fn().mockRejectedValue(manifestGone()) }),
        }),
      });
      mockTable.schema.mockResolvedValue({ fields: [] });

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      await expect(store.query([0.1], 10)).rejects.toThrow("1352.manifest");
      expect(mockTable.checkoutLatest).toHaveBeenCalledTimes(1);
    });

    it("leaves an unrelated error alone", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.checkoutLatest = vi.fn();
      mockTable.countRows.mockRejectedValue(new Error("disk on fire"));

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      await expect(store.count()).rejects.toThrow("disk on fire");
      expect(mockTable.checkoutLatest).not.toHaveBeenCalled();
    });

    it("explains a failed search that is really a dimension mismatch", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.schema.mockResolvedValue({
        fields: [{ name: "vector", type: { listSize: 768 } }],
      });
      mockTable.search.mockReturnValue({
        distanceType: () => ({
          limit: () => ({ toArray: vi.fn().mockRejectedValue(new Error("GenericFailure")) }),
        }),
      });

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      await expect(store.query(new Array(384).fill(0), 5)).rejects.toThrow(
        /768-dimension vectors but this process embeds at 384/,
      );
    });
  });

  describe("deleteByFile", () => {
    it("filters on the sha256 of the key, never on the raw path", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.deleteByFile("test.md");

      expect(mockTable.delete).toHaveBeenCalledWith(`\`fileHash\` = '${sha256("test.md")}'`);
    });

    it.each([
      ["ext:// key", "ext://vendor/pages/guide.mdx"],
      ["single quote", "test's-file.md"],
      ["space and non-ASCII", "ext://v/ü file.md"],
      ["shell-ish characters", "a@b+c%d<script>.md"],
    ])("deletes keys the old allow-list refused (%s)", async (_label, key) => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.deleteByFile(key);

      const filter = mockTable.delete.mock.calls[0][0] as string;
      expect(filter).toBe(`\`fileHash\` = '${fileHashKey(key)}'`);
      // Hex only after the column name: nothing from the key reaches the SQL.
      expect(filter).toMatch(/^`fileHash` = '[0-9a-f]{64}'$/);
    });

    it("rethrows a failed delete after warning, instead of swallowing it", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.delete.mockRejectedValue(new Error("commit conflict"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      await expect(store.deleteByFile("doc/a.md")).rejects.toThrow("commit conflict");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("doc/a.md"));
      warn.mockRestore();
    });

    it("still enforces the key length cap", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      await expect(store.deleteByFile("x".repeat(2049))).rejects.toThrow(/too long/);
      expect(mockTable.delete).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("is a no-op when there is no table yet", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockRejectedValue(new Error("Not found"));

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await expect(store.deleteByFile("doc/a.md")).resolves.toBeUndefined();
      expect(mockTable.delete).not.toHaveBeenCalled();
    });
  });

  describe("dropTable", () => {
    it("drops the table and forgets it", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.dropTable();

      expect(mockDb.dropTable).toHaveBeenCalledWith("doc_chunks");
      expect(store.hasTable()).toBe(false);
    });

    it("is a no-op without a table", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockRejectedValue(new Error("Not found"));

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.dropTable();

      expect(mockDb.dropTable).not.toHaveBeenCalled();
    });
  });

  describe("count", () => {
    it("should return total records count", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.countRows.mockResolvedValue(42);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      const count = await store.count();

      expect(count).toBe(42);
    });

    it("should return 0 if table not exists", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockRejectedValue(new Error("Not found"));

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      const count = await store.count();

      expect(count).toBe(0);
    });
  });

  describe("retainedVersions", () => {
    it("counts manifest files in the table's _versions dir", async () => {
      const { readdirSync } = await import("node:fs");
      vi.mocked(readdirSync).mockReturnValue([
        "1.manifest",
        "2.manifest",
        "3.manifest",
        "stray.txt",
      ] as any);

      const store = new LanceVectorStore("/tmp/index");

      expect(store.retainedVersions()).toBe(3);
      expect(readdirSync).toHaveBeenCalledWith("/tmp/index/doc_chunks.lance/_versions");
    });

    it("returns 0 when the table has not been created yet", async () => {
      const { readdirSync } = await import("node:fs");
      vi.mocked(readdirSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const store = new LanceVectorStore("/tmp/index");

      expect(store.retainedVersions()).toBe(0);
    });
  });

  describe("compact", () => {
    it("prunes with a grace period, not to now, and maps the stats", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.optimize.mockResolvedValue({
        compaction: { fragmentsRemoved: 443, fragmentsAdded: 1 },
        prune: { bytesRemoved: 22_900_000, oldVersionsRemoved: 512 },
      });

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      const before = Date.now();
      const stats = await store.compact();

      expect(stats).toEqual({
        versionsRemoved: 512,
        bytesRemoved: 22_900_000,
        fragmentsRemoved: 443,
      });
      // Pruning to *now* deletes versions other processes are still reading
      // through; the cut-off must sit a full grace period in the past.
      const opts = mockTable.optimize.mock.calls[0][0];
      expect(opts.cleanupOlderThan).toBeInstanceOf(Date);
      expect(opts.cleanupOlderThan.getTime()).toBeGreaterThanOrEqual(before - COMPACT_GRACE_MS);
      expect(opts.cleanupOlderThan.getTime()).toBeLessThan(before - COMPACT_GRACE_MS + 60_000);
    });

    it("returns null when there is no table", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockRejectedValue(new Error("Not found"));

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      expect(await store.compact()).toBeNull();
      expect(mockTable.optimize).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("should close database connection", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      expect(store.isOpen()).toBe(true);

      await store.close();
      expect(store.isOpen()).toBe(false);
    });
  });
});
