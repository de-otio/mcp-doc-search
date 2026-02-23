import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { registerCommands } from "../../src/extension/commands.js";

vi.mock("../../src/extension/searchPanel.js");
vi.mock("../../src/extension/settingsPanel.js");
vi.mock("../../src/extension/indexStatusPanel.js");
vi.mock("../../src/extension/mcpSetupPanel.js");

describe("Commands", () => {
  let mockContext: any;
  let deps: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContext = {
      subscriptions: [],
    };

    deps = {
      context: mockContext,
      indexer: {
        reindex: vi.fn(),
      },
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
      },
    };
  });

  describe("registerCommands", () => {
    it("should register all 6 commands", () => {
      registerCommands(mockContext, deps);

      expect(vi.mocked(vscode.commands.registerCommand)).toHaveBeenCalledTimes(
        6,
      );
    });

    it("should register docSearch.reindex command", () => {
      registerCommands(mockContext, deps);

      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const reindexCall = calls.find((c) => c[0] === "docSearch.reindex");

      expect(reindexCall).toBeDefined();
    });

    it("should register docSearch.search command", () => {
      registerCommands(mockContext, deps);

      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const searchCall = calls.find((c) => c[0] === "docSearch.search");

      expect(searchCall).toBeDefined();
    });

    it("should register docSearch.openSettings command", () => {
      registerCommands(mockContext, deps);

      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const settingsCall = calls.find((c) => c[0] === "docSearch.openSettings");

      expect(settingsCall).toBeDefined();
    });

    it("should handle reindex errors gracefully", async () => {
      deps.indexer.reindex.mockRejectedValue(new Error("Reindex failed"));

      registerCommands(mockContext, deps);

      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const reindexCall = calls.find((c) => c[0] === "docSearch.reindex");

      if (reindexCall) {
        const handler = reindexCall[1];
        await expect(handler()).rejects.toThrow();
      }
    });
  });
});
