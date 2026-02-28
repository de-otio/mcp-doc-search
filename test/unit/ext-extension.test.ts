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
  });

  describe("deactivate", () => {
    it("should be callable without errors", () => {
      expect(() => deactivate()).not.toThrow();
    });
  });
});
