import { describe, it, expect, vi, beforeEach } from "vitest";
import { LanceVectorStore } from "../../src/core/vectorstore.js";

// Mock LanceDB
vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(),
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
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

      expect(mockTable.add).toHaveBeenCalledWith(records);
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
    it("should delete records by file path", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.deleteByFile("test.md");

      expect(mockTable.delete).toHaveBeenCalledWith("file = 'test.md'");
    });

    it("should escape single quotes in file paths", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();
      await store.deleteByFile("test's-file.md");

      expect(mockTable.delete).toHaveBeenCalledWith("file = 'test''s-file.md'");
    });

    it("should reject suspicious file paths", async () => {
      const lancedb = await import("@lancedb/lancedb");
      vi.mocked(lancedb.connect).mockResolvedValue(mockDb);
      mockDb.openTable.mockResolvedValue(mockTable);

      const store = new LanceVectorStore("/tmp/index");
      await store.open();

      // Should not throw, but should catch internally
      await store.deleteByFile("test<script>.md");

      expect(mockTable.delete).not.toHaveBeenCalled();
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
