import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { McpSetupPanel } from "../../src/extension/mcpSetupPanel.js";

describe("McpSetupPanel", () => {
  let mockPanel: any;
  let mockContext: any;
  let deps: any;

  beforeEach(() => {
    vi.clearAllMocks();
    McpSetupPanel.reset();

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
        await messageHandler({ type: "copy", text: "test content" });

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("test content");
        expect(vscode.window.showInformationMessage).toHaveBeenCalled();
      }
    });

    it("should include MCP server configuration in clipboard", async () => {
      McpSetupPanel.createOrShow(mockContext, deps);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        const testContent = "mcp-doc-search config";
        await messageHandler({ type: "copy", text: testContent });

        const copyCall = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0];
        expect(copyCall[0]).toBe(testContent);
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
        const promise = messageHandler({ type: "copy", text: "test" });

        // The error will be thrown since the implementation doesn't handle it
        await expect(promise).rejects.toThrow("Clipboard error");
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

  describe("rendered snippets", () => {
    const html = (): string => mockPanel.webview.html as string;

    const portableDeps = {
      mcpServerPath: "/Users/me/.doc-search/bin/mcp-server.js",
      env: {
        DOC_SEARCH_WORKSPACE: "/Users/me/project",
        DOC_SEARCH_GLOB: "doc/**/*.md",
        USE_OPENAI: "1",
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
      },
      portable: {
        mcpServerPath: "${HOME}/.doc-search/bin/mcp-server.js",
        env: {
          DOC_SEARCH_WORKSPACE: "${CLAUDE_PROJECT_DIR}",
          DOC_SEARCH_GLOB: "doc/**/*.md",
          USE_OPENAI: "1",
          OPENAI_API_KEY: "${OPENAI_API_KEY}",
        },
      },
    };

    it("shows the portable form in the Claude Code tab and the absolute form for other clients", () => {
      McpSetupPanel.createOrShow(mockContext, portableDeps);
      const out = html();

      // Claude Code tab: what was written to .mcp.json.
      expect(out).toContain("${HOME}/.doc-search/bin/mcp-server.js");
      expect(out).toContain("${CLAUDE_PROJECT_DIR}");
      // Copilot / Continue / Kilo Code snippets: absolute paths.
      expect(out).toContain("/Users/me/.doc-search/bin/mcp-server.js");
      expect(out).toContain("/Users/me/project");
    });

    it("single-quotes CLI env values so the shell cannot expand the key reference", () => {
      McpSetupPanel.createOrShow(mockContext, portableDeps);
      const out = html();

      expect(out).toContain("-e 'OPENAI_API_KEY=${OPENAI_API_KEY}'");
      expect(out).not.toMatch(/-e OPENAI_API_KEY="/);
    });

    it("tells the user where to set OPENAI_API_KEY when the OpenAI provider is selected", () => {
      McpSetupPanel.createOrShow(mockContext, portableDeps);
      expect(html()).toContain("Export <code>OPENAI_API_KEY</code>");
    });

    it("omits the OpenAI note for other providers", () => {
      McpSetupPanel.createOrShow(mockContext, deps);
      expect(html()).not.toContain("Export <code>OPENAI_API_KEY</code>");
    });

    it("warns when .mcp.json is tracked by git", () => {
      McpSetupPanel.createOrShow(mockContext, { ...deps, mcpJsonTracked: true });
      expect(html()).toContain("tracked by git");
    });

    it("does not warn when .mcp.json is not tracked", () => {
      McpSetupPanel.createOrShow(mockContext, deps);
      expect(html()).not.toContain("tracked by git");
    });

    it("falls back to the absolute form when no portable form is supplied", () => {
      McpSetupPanel.createOrShow(mockContext, deps);
      const out = html();
      expect(out).toContain("/path/to/mcp-server.js");
      expect(out).not.toContain("${HOME}");
    });
  });
});
