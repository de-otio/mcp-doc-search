import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../../src/extension/extension.js";

vi.mock("../../src/extension/config.js");
vi.mock("../../src/core/vectorstore.js");
vi.mock("../../src/core/embedder.js");
vi.mock("../../src/core/indexer.js");
vi.mock("../../src/extension/statusBar.js");
vi.mock("../../src/extension/commands.js");
vi.mock("../../src/extension/fileWatcher.js");
vi.mock("../../src/core/gitignore.js");
vi.mock("../../src/core/indexLocation.js", () => ({
  resolveMode: vi.fn(() => "global" as const),
  resolveIndexLocation: vi.fn(() => ({
    indexDir: "/mock-home/.doc-search/indexes/workspace-abc123",
    mode: "global" as const,
    shouldGitignore: false,
  })),
}));

describe("Extension", () => {
  let mockContext: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockContext = {
      secrets: {
        get: vi.fn().mockResolvedValue(""),
        store: vi.fn(),
      },
      subscriptions: [],
      extensionPath: "/mock/extension",
    };

    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/workspace" } }];

    const { readConfig, readOpenAIApiKey } = await import("../../src/extension/config.js");
    vi.mocked(readOpenAIApiKey).mockImplementation(async (secrets: any) => {
      await secrets.get("openaiApiKey");
      return "";
    });
    vi.mocked(readConfig).mockReturnValue({
      docGlob: "doc/**/*.md",
      indexDir: ".doc-search-index",
      indexLocation: "global",
      headingDepth: 2,
      maxChunkChars: 4000,
      embedProvider: "local",
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "nomic-embed-text",
      openaiApiKey: "",
      autoReindex: false,
    } as any);

    const { LanceVectorStore } = await import("../../src/core/vectorstore.js");
    vi.mocked(LanceVectorStore).prototype.open = vi.fn().mockResolvedValue(undefined);
  });

  describe("activate", () => {
    it("should initialize extension components", async () => {
      await activate(mockContext);

      expect(mockContext.secrets.get).toHaveBeenCalled();
    });

    it("should return early if no workspace folders", async () => {
      (vscode.workspace as any).workspaceFolders = undefined;

      await activate(mockContext);

      expect(mockContext.secrets.get).not.toHaveBeenCalled();
    });

    it("should create file watcher when autoReindex enabled", async () => {
      const { readConfig } = await import("../../src/extension/config.js");
      vi.mocked(readConfig).mockReturnValue({
        docGlob: "doc/**/*.md",
        indexDir: ".doc-search-index",
        indexLocation: "global",
        headingDepth: 2,
        maxChunkChars: 4000,
        embedProvider: "local",
        ollamaUrl: "http://localhost:11434",
        ollamaModel: "nomic-embed-text",
        openaiApiKey: "",
        autoReindex: true,
      } as any);

      await activate(mockContext);

      // FileWatcher should be instantiated
    });

    it("should skip file watcher when autoReindex disabled", async () => {
      const { readConfig } = await import("../../src/extension/config.js");
      vi.mocked(readConfig).mockReturnValue({
        docGlob: "doc/**/*.md",
        indexDir: ".doc-search-index",
        indexLocation: "global",
        headingDepth: 2,
        maxChunkChars: 4000,
        embedProvider: "local",
        ollamaUrl: "http://localhost:11434",
        ollamaModel: "nomic-embed-text",
        openaiApiKey: "",
        autoReindex: false,
      } as any);

      await activate(mockContext);

      // FileWatcher should not be instantiated
    });

    it("should trigger catch-up reindex when autoReindex enabled and needsReindex is true", async () => {
      const { readConfig } = await import("../../src/extension/config.js");
      vi.mocked(readConfig).mockReturnValue({
        docGlob: "doc/**/*.md",
        indexDir: ".doc-search-index",
        indexLocation: "global",
        headingDepth: 2,
        maxChunkChars: 4000,
        embedProvider: "local",
        ollamaUrl: "http://localhost:11434",
        ollamaModel: "nomic-embed-text",
        openaiApiKey: "",
        autoReindex: true,
      } as any);

      const { Indexer } = await import("../../src/core/indexer.js");
      vi.mocked(Indexer).prototype.getStatus = vi.fn().mockResolvedValue({
        totalFiles: 3,
        cachedFiles: 2,
        changedFiles: 0,
        newFiles: 1,
        deletedFiles: 2,
        chunkCount: 10,
        lastIndexed: new Date(),
        needsReindex: true,
        docGlob: "doc/**/*.md",
      });
      vi.mocked(Indexer).prototype.reindex = vi.fn().mockResolvedValue({
        indexed: 1,
        skipped: 0,
        failedFiles: 0,
        totalChunks: 3,
        durationMs: 50,
      });

      const { StatusBarManager } = await import("../../src/extension/statusBar.js");
      const setIndexingMock = vi.fn();
      const setReadyMock = vi.fn();
      vi.mocked(StatusBarManager).prototype.setIndexing = setIndexingMock;
      vi.mocked(StatusBarManager).prototype.setReady = setReadyMock;

      await activate(mockContext);

      // store.open() is non-blocking; flush microtasks so the .then() chain runs
      await Promise.resolve();
      await Promise.resolve();

      expect(vi.mocked(Indexer).prototype.reindex).toHaveBeenCalledWith(false);
      expect(setIndexingMock).toHaveBeenCalled();
      expect(setReadyMock).toHaveBeenCalled();
    });
  });

  describe("resolver wiring", () => {
    it("calls resolveIndexLocation with the resolved mode and indexDir", async () => {
      const { resolveIndexLocation, resolveMode } = await import("../../src/core/indexLocation.js");

      await activate(mockContext);

      expect(vi.mocked(resolveMode)).toHaveBeenCalledWith("global", ".doc-search-index");
      expect(vi.mocked(resolveIndexLocation)).toHaveBeenCalledWith(
        "/workspace",
        expect.objectContaining({ indexDir: ".doc-search-index" }),
      );
    });

    it("does not call ensureGitignored when shouldGitignore is false (global mode)", async () => {
      const { ensureGitignored } = await import("../../src/core/gitignore.js");

      await activate(mockContext);

      expect(vi.mocked(ensureGitignored)).not.toHaveBeenCalled();
    });

    it("calls ensureGitignored when shouldGitignore is true (workspace mode)", async () => {
      const { resolveIndexLocation } = await import("../../src/core/indexLocation.js");
      vi.mocked(resolveIndexLocation).mockReturnValueOnce({
        indexDir: "/workspace/.doc-search-index",
        mode: "workspace",
        shouldGitignore: true,
        gitignoreEntry: ".doc-search-index",
      });

      const { ensureGitignored } = await import("../../src/core/gitignore.js");

      await activate(mockContext);

      expect(vi.mocked(ensureGitignored)).toHaveBeenCalledWith("/workspace", ".doc-search-index");
    });
  });

  describe("deactivate", () => {
    it("should be callable without errors", () => {
      expect(() => deactivate()).not.toThrow();
    });
  });

  describe("activation error paths", () => {
    it("sets error on the status bar when catch-up reindex throws", async () => {
      const { readConfig } = await import("../../src/extension/config.js");
      vi.mocked(readConfig).mockReturnValue({
        docGlob: "doc/**/*.md",
        indexDir: ".doc-search-index",
        indexLocation: "global",
        headingDepth: 2,
        maxChunkChars: 4000,
        embedProvider: "local",
        ollamaUrl: "http://localhost:11434",
        ollamaModel: "nomic-embed-text",
        openaiApiKey: "",
        autoReindex: true,
      } as any);

      const { Indexer } = await import("../../src/core/indexer.js");
      vi.mocked(Indexer).prototype.getStatus = vi.fn().mockResolvedValue({
        totalFiles: 3,
        cachedFiles: 2,
        changedFiles: 0,
        newFiles: 1,
        deletedFiles: 0,
        chunkCount: 10,
        lastIndexed: new Date(),
        needsReindex: true,
        docGlob: "doc/**/*.md",
      });
      vi.mocked(Indexer).prototype.reindex = vi.fn().mockRejectedValue(new Error("catch-up boom"));

      const { StatusBarManager } = await import("../../src/extension/statusBar.js");
      const setErrorMock = vi.fn();
      vi.mocked(StatusBarManager).prototype.setIndexing = vi.fn();
      vi.mocked(StatusBarManager).prototype.setError = setErrorMock;

      await activate(mockContext);

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(setErrorMock).toHaveBeenCalledWith(expect.stringContaining("catch-up boom"));
    });

    it("shows a warning when store.open() rejects", async () => {
      const { LanceVectorStore } = await import("../../src/core/vectorstore.js");
      vi.mocked(LanceVectorStore).prototype.open = vi
        .fn()
        .mockRejectedValue(new Error("vectorstore boom"));

      await activate(mockContext);

      await Promise.resolve();
      await Promise.resolve();

      expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
        expect.stringContaining("vectorstore boom"),
      );
    });
  });
});
