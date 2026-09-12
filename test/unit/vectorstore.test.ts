import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { LanceVectorStore, fileHashKey } from "../../src/core/vectorstore.js";

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

    it("should drop and recreate table on dimension mismatch", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);
      mockTable.schema.mockResolvedValue({
        fields: [{ name: "vector", type: { listSize: 768 } }],
      });
      mockDb.createTable.mockResolvedValue(mockTable);
      mockTable.delete.mockResolvedValue(undefined);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.ensureTable(384);

      expect(mockDb.dropTable).toHaveBeenCalledWith("doc_chunks");
      expect(mockDb.createTable).toHaveBeenCalled();
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
    it("optimizes with cleanupOlderThan=now and maps the stats", async () => {
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
      const opts = mockTable.optimize.mock.calls[0][0];
      expect(opts.cleanupOlderThan).toBeInstanceOf(Date);
      expect(opts.cleanupOlderThan.getTime()).toBeGreaterThanOrEqual(before);
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
