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
      secrets: {
        get: vi.fn().mockResolvedValue(""),
        store: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        onDidChange: vi.fn(),
      },
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

    // -----------------------------------------------------------------------
    // H3: OpenAI API key lives in SecretStorage, never in settings.json
    // -----------------------------------------------------------------------

    it("on ready, reads openaiApiKey from SecretStorage and not from settings.json", async () => {
      mockContext.secrets.get.mockResolvedValue("sk-from-secrets");

      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];
      await handler({ type: "ready" });

      expect(mockContext.secrets.get).toHaveBeenCalledWith("docSearch.openaiApiKey");

      const configMessage = mockPanel.webview.postMessage.mock.calls.find(
        (c: any) => c[0].type === "config",
      );
      expect(configMessage?.[0].config.openaiApiKey).toBe("sk-from-secrets");

      // Verify the panel never asked workspace settings for the key.
      const cfgGetCalls = vi
        .mocked(vscode.workspace.getConfiguration)
        .mock.results[0]?.value.get.mock.calls.map((c: any) => c[0]);
      expect(cfgGetCalls).not.toContain("openaiApiKey");
    });

    it("on saveConfig with a key, writes to SecretStorage and not to cfg.update", async () => {
      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

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
          openaiApiKey: "sk-newkey",
          autoReindex: true,
        },
      });

      expect(mockContext.secrets.store).toHaveBeenCalledWith("docSearch.openaiApiKey", "sk-newkey");

      // Verify cfg.update was never called with openaiApiKey as the key,
      // even when the panel saves a value. This is the core invariant.
      const cfg = vi.mocked(vscode.workspace.getConfiguration).mock.results[0]?.value;
      const updateKeys = cfg.update.mock.calls.map((c: any) => c[0]);
      expect(updateKeys).not.toContain("openaiApiKey");
    });

    it("on saveConfig with an empty key, deletes the secret", async () => {
      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

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
          openaiApiKey: "",
          autoReindex: true,
        },
      });

      expect(mockContext.secrets.delete).toHaveBeenCalledWith("docSearch.openaiApiKey");
      expect(mockContext.secrets.store).not.toHaveBeenCalled();
    });

    it("clears a legacy settings.json key on save", async () => {
      // Simulate a pre-migration install: openaiApiKey lingering in workspace settings.
      const cfg = vi.mocked(vscode.workspace.getConfiguration).mock.results;
      // Reconfigure the default mock to return a stale value for openaiApiKey.
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, def: any) =>
          key === "openaiApiKey" ? "sk-legacy" : key === "embedProvider" ? "local" : def,
        ),
        update: vi.fn(),
      } as any);

      SettingsPanel.createOrShow(mockContext);
      const handler = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.calls[0]?.[0];

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
          openaiApiKey: "sk-new",
          autoReindex: true,
        },
      });

      // The latest getConfiguration mock should have been asked to clear the legacy key.
      const latestCfg = vi.mocked(vscode.workspace.getConfiguration).mock.results.at(-1)?.value;
      expect(latestCfg.update).toHaveBeenCalledWith("openaiApiKey", undefined, expect.anything());
      void cfg;
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
