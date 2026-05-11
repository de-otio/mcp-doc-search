import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { IndexStatusPanel } from "../../src/extension/indexStatusPanel.js";

vi.useFakeTimers();

describe("IndexStatusPanel", () => {
  let mockPanel: any;
  let mockContext: any;
  let mockIndexer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    IndexStatusPanel.reset();

    mockPanel = {
      webview: {
        html: "",
        postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn((handler) => ({ dispose: vi.fn() })),
      },
      reveal: vi.fn(),
      onDidDispose: vi.fn((handler) => ({ dispose: vi.fn() })),
    };

    mockContext = {
      subscriptions: [],
    };

    mockIndexer = {
      getStatus: vi.fn().mockResolvedValue({
        totalFiles: 10,
        cachedFiles: 8,
        changedFiles: 2,
        newFiles: 0,
        deletedFiles: 0,
        chunkCount: 100,
        lastIndexed: new Date(),
        needsReindex: false,
        docGlob: "doc/**/*.md",
      }),
      reindex: vi.fn().mockResolvedValue({
        indexed: 2,
        skipped: 8,
        failedFiles: 0,
        totalChunks: 10,
        durationMs: 1000,
      }),
    };

    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(() => "local"),
    } as any);
  });

  describe("IndexStatusPanel", () => {
    it("should create panel on first call", () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);

      expect(vscode.window.createWebviewPanel).toHaveBeenCalled();
    });

    it("should reveal existing panel on second call", () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);

      expect(mockPanel.reveal).toHaveBeenCalled();
    });

    it("should send index status on ready", async () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "ready" });

        expect(mockIndexer.getStatus).toHaveBeenCalled();
        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "status" }),
        );
      }
    });

    it("should handle reindex message", async () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "reindex", force: false });

        expect(mockIndexer.reindex).toHaveBeenCalledWith(false, expect.any(Function));
        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "indexing",
            phase: "scanning",
          }),
        );
      }
    });

    it("should report progress during reindex", async () => {
      let progressHandler: any = null;

      mockIndexer.reindex.mockImplementation(async (force: boolean, onProgress?: any) => {
        if (onProgress) {
          onProgress(1, 10, "file1.md", "indexing");
          onProgress(2, 10, "file2.md", "indexing");
        }
        return {
          indexed: 2,
          skipped: 8,
          failedFiles: 0,
          totalChunks: 10,
          durationMs: 1000,
        };
      });

      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "reindex" });

        expect(mockPanel.webview.postMessage).toHaveBeenCalled();
      }
    });

    it("should handle errors during reindex", async () => {
      mockIndexer.reindex.mockRejectedValue(new Error("Reindex failed"));

      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "reindex" });

        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: expect.any(String) }),
        );
      }
    });

    it("should set disposed flag on dispose", () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);

      const disposeHandler = vi.mocked(mockPanel.onDidDispose).mock.calls[0]?.[0];
      if (disposeHandler) {
        disposeHandler();
      }

      expect(mockPanel.onDidDispose).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Static notify* methods (used by the reindex command)
    // -----------------------------------------------------------------------

    it("notifyProgress posts an indexing message when an instance exists", () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);
      mockPanel.webview.postMessage.mockClear();

      IndexStatusPanel.notifyProgress("scanning", 5, 10);

      expect(IndexStatusPanel.busy).toBe(true);
      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: "indexing",
        phase: "scanning",
        processed: 5,
        total: 10,
      });
    });

    it("notifyProgress is a no-op when no panel is open", () => {
      IndexStatusPanel.reset();
      // Should not throw even with no instance
      expect(() => IndexStatusPanel.notifyProgress("scanning")).not.toThrow();
      expect(IndexStatusPanel.busy).toBe(true);
    });

    it("notifyDone clears busy and posts reindexDone with stats", async () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);
      IndexStatusPanel.busy = true;
      mockPanel.webview.postMessage.mockClear();

      const stats = { indexed: 3, totalChunks: 12, skipped: 1, durationMs: 250 };
      await IndexStatusPanel.notifyDone(stats);

      expect(IndexStatusPanel.busy).toBe(false);
      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: "reindexDone",
        stats,
      });
    });

    it("notifyDone is a no-op when no panel is open", async () => {
      IndexStatusPanel.reset();
      IndexStatusPanel.busy = true;
      await IndexStatusPanel.notifyDone({ indexed: 1, totalChunks: 1, skipped: 0, durationMs: 1 });
      expect(IndexStatusPanel.busy).toBe(false);
    });

    it("notifyError clears busy and posts reindexError", () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);
      IndexStatusPanel.busy = true;
      mockPanel.webview.postMessage.mockClear();

      IndexStatusPanel.notifyError("disk full");

      expect(IndexStatusPanel.busy).toBe(false);
      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: "reindexError",
        message: "disk full",
      });
    });

    // -----------------------------------------------------------------------
    // Branch coverage: ready/refresh while busy + sendStatus error
    // -----------------------------------------------------------------------

    it("on ready, restores indexing state if a reindex is running", async () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);
      IndexStatusPanel.busy = true;
      mockPanel.webview.postMessage.mockClear();

      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];
      await handler({ type: "ready" });

      const calls = mockPanel.webview.postMessage.mock.calls.map((c: any) => c[0]);
      expect(calls.some((m: any) => m.type === "indexing" && m.phase === "scanning")).toBe(true);

      IndexStatusPanel.busy = false;
    });

    it("posts an error message when getStatus throws", async () => {
      mockIndexer.getStatus.mockRejectedValue(new Error("status oops"));
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);
      mockPanel.webview.postMessage.mockClear();

      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];
      await handler({ type: "ready" });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: "error",
        message: "status oops",
      });
    });

    it("runReindex returns immediately when already busy", async () => {
      IndexStatusPanel.createOrShow(mockContext, () => mockIndexer);
      IndexStatusPanel.busy = true;
      mockIndexer.reindex.mockClear();

      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];
      await handler({ type: "reindex", force: false });

      expect(mockIndexer.reindex).not.toHaveBeenCalled();

      IndexStatusPanel.busy = false;
    });
  });
});
