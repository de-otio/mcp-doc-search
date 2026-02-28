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
      IndexStatusPanel.createOrShow(mockContext, mockIndexer);

      expect(vscode.window.createWebviewPanel).toHaveBeenCalled();
    });

    it("should reveal existing panel on second call", () => {
      IndexStatusPanel.createOrShow(mockContext, mockIndexer);
      IndexStatusPanel.createOrShow(mockContext, mockIndexer);

      expect(mockPanel.reveal).toHaveBeenCalled();
    });

    it("should send index status on ready", async () => {
      IndexStatusPanel.createOrShow(mockContext, mockIndexer);

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
      IndexStatusPanel.createOrShow(mockContext, mockIndexer);

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

      IndexStatusPanel.createOrShow(mockContext, mockIndexer);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "reindex" });

        expect(mockPanel.webview.postMessage).toHaveBeenCalled();
      }
    });

    it("should handle errors during reindex", async () => {
      mockIndexer.reindex.mockRejectedValue(new Error("Reindex failed"));

      IndexStatusPanel.createOrShow(mockContext, mockIndexer);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "reindex" });

        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: expect.any(String) }),
        );
      }
    });

    it("should set disposed flag on dispose", () => {
      IndexStatusPanel.createOrShow(mockContext, mockIndexer);

      const disposeHandler = vi.mocked(mockPanel.onDidDispose).mock.calls[0]?.[0];
      if (disposeHandler) {
        disposeHandler();
      }

      expect(mockPanel.onDidDispose).toHaveBeenCalled();
    });
  });
});
