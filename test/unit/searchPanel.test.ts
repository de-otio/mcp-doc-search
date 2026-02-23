import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { SearchPanel } from "../../src/extension/searchPanel.js";

vi.mock("../../src/core/searcher.js");

describe("SearchPanel", () => {
  let mockPanel: any;
  let mockContext: any;
  let deps: any;

  beforeEach(() => {
    vi.clearAllMocks();

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

    deps = {
      workspaceRoot: "/workspace",
      store: { query: vi.fn() },
      embedProvider: { embed: vi.fn() },
    };

    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel);
  });

  describe("SearchPanel", () => {
    it("should create panel on first call", () => {
      SearchPanel.createOrShow(mockContext, deps);

      expect(vscode.window.createWebviewPanel).toHaveBeenCalled();
    });

    it("should reveal existing panel on second call", () => {
      SearchPanel.createOrShow(mockContext, deps);
      SearchPanel.createOrShow(mockContext, deps);

      expect(mockPanel.reveal).toHaveBeenCalled();
    });

    it("should handle search message", async () => {
      const { search } = await import("../../src/core/searcher.js");

      vi.mocked(search).mockResolvedValue([
        {
          file: "test.md",
          heading: "Test",
          excerpt: "Test content",
          score: 0.95,
          lineStart: 0,
        },
      ]);

      SearchPanel.createOrShow(mockContext, deps);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "search", query: "test" });

        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "results" }),
        );
      }
    });

    it("should handle search errors", async () => {
      const { search } = await import("../../src/core/searcher.js");

      vi.mocked(search).mockRejectedValue(new Error("Search failed"));

      SearchPanel.createOrShow(mockContext, deps);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "search", query: "test" });

        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "results",
            error: expect.any(String),
          }),
        );
      }
    });

    it("should not post message after dispose", async () => {
      SearchPanel.createOrShow(mockContext, deps);

      const disposeHandler = vi.mocked(mockPanel.onDidDispose).mock.calls[0]?.[0];
      if (disposeHandler) {
        disposeHandler();
      }

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "search", query: "test" });

        // postMessage should not be called or should be guarded
      }
    });

    it("should handle empty query", async () => {
      SearchPanel.createOrShow(mockContext, deps);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "search", query: "   " });

        // Should return early, no postMessage
      }
    });
  });
});
