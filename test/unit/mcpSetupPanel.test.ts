import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { McpSetupPanel } from "../../src/extension/mcpSetupPanel.js";

describe("McpSetupPanel", () => {
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
      mcpServerPath: "/path/to/mcp-server.js",
      env: {
        DOC_SEARCH_WORKSPACE: "/workspace",
        NODE_PATH: "/usr/local/bin/node",
      },
    };

    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel);
    vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);
  });

  describe("McpSetupPanel", () => {
    it("should create panel on first call", () => {
      McpSetupPanel.createOrShow(mockContext, deps);

      expect(vscode.window.createWebviewPanel).toHaveBeenCalled();
    });

    it("should reveal existing panel on second call", () => {
      McpSetupPanel.createOrShow(mockContext, deps);
      McpSetupPanel.createOrShow(mockContext, deps);

      expect(mockPanel.reveal).toHaveBeenCalled();
    });

    it("should handle copy message", async () => {
      McpSetupPanel.createOrShow(mockContext, deps);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "copy" });

        expect(vscode.env.clipboard.writeText).toHaveBeenCalled();
        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "copyResult" }),
        );
      }
    });

    it("should include MCP server configuration in clipboard", async () => {
      McpSetupPanel.createOrShow(mockContext, deps);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "copy" });

        const copyCall = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0];
        expect(copyCall[0]).toContain("mcp-doc-search");
      }
    });

    it("should show confirmation message after copy", async () => {
      McpSetupPanel.createOrShow(mockContext, deps);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "copy" });

        expect(vscode.window.showInformationMessage).toHaveBeenCalled();
      }
    });

    it("should handle copy errors gracefully", async () => {
      vi.mocked(vscode.env.clipboard.writeText).mockRejectedValue(new Error("Clipboard error"));

      McpSetupPanel.createOrShow(mockContext, deps);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "copy" });

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining("failed"),
        );
      }
    });

    it("should set disposed flag on dispose", () => {
      McpSetupPanel.createOrShow(mockContext, deps);

      const disposeHandler = vi.mocked(mockPanel.onDidDispose).mock.calls[0]?.[0];
      if (disposeHandler) {
        disposeHandler();
      }

      expect(mockPanel.onDidDispose).toHaveBeenCalled();
    });
  });
});
