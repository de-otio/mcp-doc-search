import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs";
import { registerCommands } from "../../src/extension/commands.js";
import { SearchPanel } from "../../src/extension/searchPanel.js";
import { SettingsPanel } from "../../src/extension/settingsPanel.js";
import { IndexStatusPanel } from "../../src/extension/indexStatusPanel.js";
import { McpSetupPanel } from "../../src/extension/mcpSetupPanel.js";

vi.mock("../../src/extension/searchPanel.js", () => ({
  SearchPanel: { createOrShow: vi.fn() },
}));
vi.mock("../../src/extension/settingsPanel.js", () => ({
  SettingsPanel: { createOrShow: vi.fn() },
}));
vi.mock("../../src/extension/indexStatusPanel.js", () => ({
  IndexStatusPanel: {
    createOrShow: vi.fn(),
    notifyProgress: vi.fn(),
    notifyDone: vi.fn(),
    notifyError: vi.fn(),
  },
}));
vi.mock("../../src/extension/mcpSetupPanel.js", () => ({
  McpSetupPanel: { createOrShow: vi.fn() },
}));
vi.mock("../../src/extension/config.js", () => ({
  readConfig: vi.fn(() => ({
    docGlob: "doc/**/*.md",
    indexDir: ".doc-search-index",
    maxChunkChars: 4000,
    headingDepth: 2,
    embedProvider: "local",
    autoReindex: true,
  })),
  readOpenAIApiKey: vi.fn(async () => undefined),
}));
vi.mock("../../src/core/embedder.js", () => ({
  createEmbedProvider: vi.fn(() => ({ embed: vi.fn() })),
}));
let _indexerImpl: () => any = () => ({
  reindex: vi.fn(async (_force: any, onProgress: any) => {
    if (onProgress) {
      onProgress(0, 0, "", "scanning");
      onProgress(0, 1, "doc/foo.md", "loading");
      onProgress(1, 1, "doc/foo.md", "indexing");
    }
    return { indexed: 1, skipped: 0, totalChunks: 5, durationMs: 100, pruned: 0, failedFiles: 0 };
  }),
});

vi.mock("../../src/core/indexer.js", () => ({
  Indexer: function (this: any) {
    Object.assign(this, _indexerImpl());
  },
}));
vi.mock("../../src/core/gitignore.js", () => ({
  ensureGitignored: vi.fn(),
}));
vi.mock("node:fs");

describe("Commands", () => {
  let mockContext: any;
  let deps: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContext = {
      subscriptions: [],
      secrets: { store: vi.fn(), get: vi.fn(), delete: vi.fn() },
      extensionPath: "/mock/extension",
    };

    deps = {
      context: mockContext,
      indexer: { reindex: vi.fn() },
      store: {},
      embedProvider: {},
      statusBar: {
        setIndexing: vi.fn(),
        setReady: vi.fn(),
        setError: vi.fn(),
      },
      workspaceRoot: "/workspace",
      config: {
        docGlob: "doc/**/*.md",
        indexDir: ".doc-search-index",
        maxChunkChars: 4000,
        headingDepth: 2,
      },
    };

    vi.mocked(vscode.window.withProgress).mockImplementation(async (_opts, cb) =>
      cb({ report: vi.fn() } as any),
    );
  });

  function findHandler(name: string): any {
    const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
    const call = calls.find((c) => c[0] === name);
    return call?.[1];
  }

  describe("registerCommands wiring", () => {
    it("registers all 6 commands", () => {
      registerCommands(mockContext, deps);
      expect(vi.mocked(vscode.commands.registerCommand)).toHaveBeenCalledTimes(6);
    });

    it("registers each known command name", () => {
      registerCommands(mockContext, deps);
      const names = vi.mocked(vscode.commands.registerCommand).mock.calls.map((c) => c[0]);
      expect(names).toEqual(
        expect.arrayContaining([
          "docSearch.search",
          "docSearch.reindex",
          "docSearch.openIndexStatus",
          "docSearch.openSettings",
          "docSearch.openWalkthrough",
          "docSearch.generateMcpJson",
        ]),
      );
    });

    it("pushes disposables onto context.subscriptions", () => {
      registerCommands(mockContext, deps);
      expect(mockContext.subscriptions.length).toBeGreaterThan(0);
    });
  });

  describe("docSearch.search", () => {
    it("opens SearchPanel with fresh embed provider", async () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.search");
      await handler();

      expect(vi.mocked(SearchPanel.createOrShow)).toHaveBeenCalledOnce();
      const args = vi.mocked(SearchPanel.createOrShow).mock.calls[0];
      expect(args[1]).toMatchObject({
        workspaceRoot: "/workspace",
        store: deps.store,
      });
      expect(args[1].embedProvider).toBeDefined();
    });
  });

  describe("docSearch.reindex", () => {
    it("with forceArg=true skips the quick-pick prompt", async () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.reindex");
      await handler(true);

      expect(vi.mocked(vscode.window.showQuickPick)).not.toHaveBeenCalled();
      expect(deps.statusBar.setIndexing).toHaveBeenCalled();
      expect(deps.statusBar.setReady).toHaveBeenCalled();
    });

    it("with forceArg=false also skips the quick-pick prompt", async () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.reindex");
      await handler(false);

      expect(vi.mocked(vscode.window.showQuickPick)).not.toHaveBeenCalled();
    });

    it("without forceArg shows a quick-pick and aborts on cancel", async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as any);

      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.reindex");
      await handler();

      expect(vi.mocked(vscode.window.showQuickPick)).toHaveBeenCalledOnce();
      expect(deps.statusBar.setIndexing).not.toHaveBeenCalled();
    });

    it("without forceArg uses chosen option's force flag", async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "$(trash) Full reindex",
        description: "Reindex all files from scratch",
        force: true,
      } as any);

      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.reindex");
      await handler();

      expect(vi.mocked(vscode.window.showQuickPick)).toHaveBeenCalledOnce();
      expect(deps.statusBar.setIndexing).toHaveBeenCalled();
    });

    it("on success notifies done and shows information message", async () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.reindex");
      await handler(true);

      expect(vi.mocked(IndexStatusPanel.notifyDone)).toHaveBeenCalledOnce();
      expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledOnce();
      const msg = vi.mocked(vscode.window.showInformationMessage).mock.calls[0][0];
      expect(msg).toContain("Indexed 1 file");
    });

    it("on reindex error sets error state and surfaces it", async () => {
      _indexerImpl = () => ({
        reindex: vi.fn(async () => {
          throw new Error("boom");
        }),
      });

      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.reindex");
      await handler(true);

      expect(deps.statusBar.setError).toHaveBeenCalledWith(expect.stringContaining("boom"));
      expect(vi.mocked(IndexStatusPanel.notifyError)).toHaveBeenCalledWith(
        expect.stringContaining("boom"),
      );
      expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalledOnce();
    });
  });

  describe("docSearch.openIndexStatus", () => {
    it("delegates to IndexStatusPanel.createOrShow", () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.openIndexStatus");
      handler();

      expect(vi.mocked(IndexStatusPanel.createOrShow)).toHaveBeenCalledWith(
        mockContext,
        expect.any(Function),
      );
    });
  });

  describe("docSearch.openSettings", () => {
    it("delegates to SettingsPanel.createOrShow", () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.openSettings");
      handler();

      expect(vi.mocked(SettingsPanel.createOrShow)).toHaveBeenCalledWith(mockContext);
    });
  });

  describe("docSearch.openWalkthrough", () => {
    it("executes the workbench openWalkthrough command with the right id", () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.openWalkthrough");
      handler();

      expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
        "workbench.action.openWalkthrough",
        expect.stringContaining("docSearch.getStarted"),
        false,
      );
    });
  });

  describe("docSearch.generateMcpJson", () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue("");
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    });

    it("writes a fresh .mcp.json when none exists", async () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.generateMcpJson");
      await handler();

      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledOnce();
      const [path, contents] = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(String(path)).toContain(".mcp.json");
      const parsed = JSON.parse(String(contents));
      expect(parsed.mcpServers["doc-search"]).toBeDefined();
      expect(parsed.mcpServers["doc-search"].command).toBe("node");
      expect(parsed.mcpServers["doc-search"].env.DOC_SEARCH_WORKSPACE).toBe("/workspace");
    });

    it("merges into an existing .mcp.json without clobbering siblings", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ mcpServers: { other: { command: "x" } } }),
      );

      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.generateMcpJson");
      await handler();

      const [, contents] = vi.mocked(fs.writeFileSync).mock.calls[0];
      const parsed = JSON.parse(String(contents));
      expect(parsed.mcpServers.other).toEqual({ command: "x" });
      expect(parsed.mcpServers["doc-search"]).toBeDefined();
    });

    it("recovers from a malformed existing .mcp.json by starting fresh", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("{ not json");

      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.generateMcpJson");
      await handler();

      const [, contents] = vi.mocked(fs.writeFileSync).mock.calls[0];
      const parsed = JSON.parse(String(contents));
      expect(parsed.mcpServers["doc-search"]).toBeDefined();
    });

    it("opens McpSetupPanel after writing", async () => {
      registerCommands(mockContext, deps);
      const handler = findHandler("docSearch.generateMcpJson");
      await handler();

      expect(vi.mocked(McpSetupPanel.createOrShow)).toHaveBeenCalledOnce();
    });
  });
});
