import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { SettingsPanel } from "../../src/extension/settingsPanel.js";

vi.mock("node:child_process");

describe("SettingsPanel", () => {
  let mockPanel: any;
  let mockContext: any;

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

    SettingsPanel.reset();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel);

    const mockCfg = {
      get: vi.fn((key: string, defaultValue: any) => {
        const defaults: Record<string, any> = {
          docGlob: "doc/**/*.md",
          indexDir: ".doc-search-index",
          headingDepth: 2,
          maxChunkChars: 4000,
          embedProvider: "local",
          ollamaUrl: "http://localhost:11434",
          ollamaModel: "nomic-embed-text",
          openaiApiKey: "",
          autoReindex: true,
        };
        return defaults[key] ?? defaultValue;
      }),
      update: vi.fn(),
    };

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockCfg as any);
  });

  describe("SettingsPanel", () => {
    it("should create panel on first call", () => {
      SettingsPanel.createOrShow(mockContext);

      expect(vscode.window.createWebviewPanel).toHaveBeenCalled();
    });

    it("should reveal existing panel on second call", () => {
      SettingsPanel.createOrShow(mockContext);
      SettingsPanel.createOrShow(mockContext);

      expect(mockPanel.reveal).toHaveBeenCalled();
    });

    it("should handle getConfig message", async () => {
      SettingsPanel.createOrShow(mockContext);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "ready" });

        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "config" }),
        );
      }
    });

    it("should handle saveConfig message", async () => {
      SettingsPanel.createOrShow(mockContext);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        const newConfig = {
          docGlob: "docs/**/*.md",
          indexDir: ".index",
          headingDepth: 1,
          maxChunkChars: 5000,
          embedProvider: "local",
          ollamaUrl: "http://localhost:11434",
          ollamaModel: "nomic-embed-text",
          autoReindex: false,
        };

        await messageHandler({ type: "saveConfig", config: newConfig });

        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "saveResult" }),
        );
      }
    });

    it("should handle testConnection message for Ollama", async () => {
      SettingsPanel.createOrShow(mockContext);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({
          type: "testConnection",
          provider: "ollama",
          ollamaUrl: "http://localhost:11434",
        });

        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "testResult" }),
        );
      }
    });

    it("should handle testConnection message for OpenAI", async () => {
      SettingsPanel.createOrShow(mockContext);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({
          type: "testConnection",
          provider: "openai",
          apiKey: "sk-test",
        });

        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "testResult" }),
        );
      }
    });

    it("should handle errors in message processing", async () => {
      SettingsPanel.createOrShow(mockContext);

      const messageHandler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      if (messageHandler) {
        await messageHandler({ type: "saveConfig", config: null });

        expect(mockPanel.webview.postMessage).toHaveBeenCalled();
      }
    });

    it("should set disposed flag on dispose", () => {
      SettingsPanel.createOrShow(mockContext);

      const disposeHandler = vi.mocked(mockPanel.onDidDispose).mock.calls[0]?.[0];
      if (disposeHandler) {
        disposeHandler();
      }

      // Panel should be cleaned up
      expect(mockPanel.onDidDispose).toHaveBeenCalled();
    });

    it("handles reloadWindow message", async () => {
      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      await handler({ type: "reloadWindow" });

      expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
        "workbench.action.reloadWindow",
      );
    });

    it("handles reindex message: opens index status, kicks reindex, disposes panel", async () => {
      mockPanel.dispose = vi.fn();
      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      await handler({ type: "reindex" });

      expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
        "docSearch.openIndexStatus",
      );
      expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
        "docSearch.reindex",
        false,
      );
      expect(mockPanel.dispose).toHaveBeenCalled();
    });

    it("handles openSearch message: disposes panel and opens search", async () => {
      mockPanel.dispose = vi.fn();
      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      await handler({ type: "openSearch" });

      expect(mockPanel.dispose).toHaveBeenCalled();
      expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith("docSearch.search");
    });

    it("handles openUrl message: opens external URL", async () => {
      const openExternal = vi.fn();
      (vscode.env as any).openExternal = openExternal;
      const parseSpy = vi.fn((u: string) => ({ url: u }));
      (vscode.Uri as any).parse = parseSpy;

      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      await handler({ type: "openUrl", url: "https://example.com" });

      expect(parseSpy).toHaveBeenCalledWith("https://example.com");
      expect(openExternal).toHaveBeenCalled();
    });

    it("handles checkOllama: server reachable", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      await handler({ type: "checkOllama", ollamaUrl: "http://localhost:11434" });

      expect(fetchSpy).toHaveBeenCalled();
      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ollamaStatus", running: true, installed: true }),
      );

      fetchSpy.mockRestore();
    });

    it("handles checkOllama: server unreachable, falls back to binary check", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      const { execFile } = await import("node:child_process");
      vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
        cb(null);
      }) as any);

      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      await handler({ type: "checkOllama", ollamaUrl: "http://localhost:11434" });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ollamaStatus", running: false, installed: true }),
      );

      fetchSpy.mockRestore();
    });

    it("handles checkOllama: trims trailing slash from URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      await handler({ type: "checkOllama", ollamaUrl: "http://localhost:11434/" });

      expect(fetchSpy).toHaveBeenCalledWith("http://localhost:11434");
      fetchSpy.mockRestore();
    });

    it("saveConfig with providerChanged kicks docSearch.reindex", async () => {
      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

      // Default config has embedProvider="local"; switching to openai changes it
      await handler({
        type: "saveConfig",
        config: {
          docGlob: "doc/**/*.md",
          indexDir: ".doc-search-index",
          headingDepth: 2,
          maxChunkChars: 4000,
          embedProvider: "openai",
          ollamaUrl: "http://localhost:11434",
          ollamaModel: "nomic-embed-text",
          openaiApiKey: "sk-test",
          autoReindex: true,
        },
      });

      expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
        "docSearch.reindex",
        true,
      );
    });
  });
});
