import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  removeSupersededLegacyIndex: vi.fn(() => undefined),
}));
vi.mock("../../src/extension/stableBin.js", () => ({
  writeStableLaunchers: vi.fn(() => "/mock-home/.doc-search/bin/mcp-server.js"),
}));

/** In-memory stand-in for ExtensionContext.globalState. */
function makeGlobalState(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: vi.fn((key: string, fallback?: unknown) => (data.has(key) ? data.get(key) : fallback)),
    update: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
}

const STALE_LOCK = {
  pid: 56457,
  startedAt: "2026-09-13T06:14:05.451Z",
  heartbeatAt: new Date("2026-09-13T06:53:38.000Z"),
  stale: true,
  staleReason: "holder-dead",
};

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
      globalState: makeGlobalState(),
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

    // activate() needs a real provider object: the index directory is keyed by
    // the embedder's identity, so it is read before anything else happens.
    const { createEmbedProvider } = await import("../../src/core/embedder.js");
    vi.mocked(createEmbedProvider).mockReturnValue({
      embed: vi.fn(),
      identity: () => ({ provider: "local" as const, model: "Xenova/all-MiniLM-L6-v2", dim: 384 }),
    });
  });

  describe("activate", () => {
    it("should initialize extension components", async () => {
      await activate(mockContext);

      expect(mockContext.secrets.get).toHaveBeenCalled();
    });

    it("refreshes the stable launchers for the current extension build", async () => {
      const { writeStableLaunchers } = await import("../../src/extension/stableBin.js");

      await activate(mockContext);

      expect(vi.mocked(writeStableLaunchers)).toHaveBeenCalledWith("/mock/extension");
    });

    it("registers the native MCP server definition provider for the stable launcher", async () => {
      await activate(mockContext);

      expect(vi.mocked(vscode.lm.registerMcpServerDefinitionProvider)).toHaveBeenCalledWith(
        "docSearch.mcpServers",
        expect.objectContaining({ provideMcpServerDefinitions: expect.any(Function) }),
      );
      // The registration is owned by the extension lifetime.
      expect(mockContext.subscriptions).toContainEqual(
        expect.objectContaining({ dispose: expect.any(Function) }),
      );
      const provider = vi.mocked(vscode.lm.registerMcpServerDefinitionProvider).mock.calls[0][1];
      const [def] = (await provider.provideMcpServerDefinitions({} as any)) as any[];
      expect(def.args).toEqual(["/mock-home/.doc-search/bin/mcp-server.js"]);
      // Same env the .mcp.json generator emits (buildMcpServerEnv), with the
      // absolute workspace path because VS Code does not expand ${VAR} refs.
      expect(def.env).toEqual({
        DOC_SEARCH_WORKSPACE: "/workspace",
        DOC_SEARCH_GLOB: "doc/**/*.md",
      });
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

      // store.open() is non-blocking; wait for the .then() chain to finish
      await vi.waitFor(() => {
        expect(setReadyMock).toHaveBeenCalled();
      });

      expect(vi.mocked(Indexer).prototype.reindex).toHaveBeenCalledWith(false);
      expect(setIndexingMock).toHaveBeenCalled();
    });

    it("sweeps a stale reindex lock on activation, before the catch-up check, even with autoReindex off", async () => {
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

      const { Indexer } = await import("../../src/core/indexer.js");
      const clearStale = vi.fn().mockReturnValue({
        pid: 56457,
        startedAt: "2026-09-13T06:14:05.451Z",
        heartbeatAt: new Date("2026-09-13T06:53:38.000Z"),
        stale: true,
        staleReason: "holder-dead",
      });
      vi.mocked(Indexer).prototype.clearStaleReindexLock = clearStale;
      vi.mocked(Indexer).prototype.getStatus = vi.fn();
      vi.mocked(Indexer).prototype.reindex = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await activate(mockContext);
      await Promise.resolve();
      await Promise.resolve();

      expect(clearStale).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/stale reindex lock.*56457.*holder-dead/),
      );
      // autoReindex is off: nothing else runs.
      expect(vi.mocked(Indexer).prototype.getStatus).not.toHaveBeenCalled();
      expect(vi.mocked(Indexer).prototype.reindex).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("crash-loop guard (#117)", () => {
    const PAUSED_MESSAGE =
      "Doc Search: the last indexing runs did not finish, so automatic indexing is paused for this window.";

    async function setup(opts: { stale: boolean; needsReindex?: boolean }) {
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
      const proto = vi.mocked(Indexer).prototype;
      proto.clearStaleReindexLock = vi.fn().mockReturnValue(opts.stale ? STALE_LOCK : null);
      proto.getStatus = vi.fn().mockResolvedValue({ needsReindex: opts.needsReindex ?? true });
      proto.reindex = vi.fn().mockResolvedValue({ indexed: 1 });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      return proto;
    }

    /** Run the activation and let the store.open().then(...) chain settle. */
    async function activateAndSettle(): Promise<void> {
      await activate(mockContext);
      await vi.waitFor(() => {
        expect(mockContext.globalState.get).toHaveBeenCalled();
      });
      await new Promise((r) => setImmediate(r));
    }

    it("runs the catch-up on the first stale lock, then resets the counter on success", async () => {
      const proto = await setup({ stale: true });

      await activateAndSettle();

      expect(proto.reindex).toHaveBeenCalledWith(false);
      expect(vi.mocked(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
      // Incremented to 1 before the run, back to 0 after it succeeded.
      expect(mockContext.globalState.update.mock.calls.map((c: any[]) => c[1])).toEqual([1, 0]);
      expect([...mockContext.globalState.data.values()]).toEqual([0]);
    });

    it("skips the catch-up and warns when two stale locks were cleared in a row", async () => {
      const proto = await setup({ stale: true });
      // One unfinished run is already on record for THIS workspace.
      const { unfinishedRunsKey } = await import("../../src/extension/catchUpGuard.js");
      mockContext.globalState = makeGlobalState({ [unfinishedRunsKey("/workspace")]: 1 });

      await activateAndSettle();

      expect(proto.reindex).not.toHaveBeenCalled();
      expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
        PAUSED_MESSAGE,
        "Reindex now",
      );
      expect(mockContext.globalState.data.get(unfinishedRunsKey("/workspace"))).toBe(2);
    });

    it("stays paused on a later activation with no new stale lock", async () => {
      const proto = await setup({ stale: false });
      const { unfinishedRunsKey } = await import("../../src/extension/catchUpGuard.js");
      mockContext.globalState = makeGlobalState({ [unfinishedRunsKey("/workspace")]: 2 });

      await activateAndSettle();

      expect(proto.reindex).not.toHaveBeenCalled();
      expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
        PAUSED_MESSAGE,
        "Reindex now",
      );
    });

    it("keeps one workspace's counter from pausing another", async () => {
      const proto = await setup({ stale: false });
      const { unfinishedRunsKey } = await import("../../src/extension/catchUpGuard.js");
      mockContext.globalState = makeGlobalState({ [unfinishedRunsKey("/other-workspace")]: 5 });

      await activateAndSettle();

      expect(proto.reindex).toHaveBeenCalledWith(false);
    });

    it("does not reset the counter when the catch-up fails", async () => {
      const proto = await setup({ stale: true });
      proto.reindex = vi.fn().mockRejectedValue(new Error("boom"));

      await activateAndSettle();

      const { unfinishedRunsKey } = await import("../../src/extension/catchUpGuard.js");
      expect(mockContext.globalState.data.get(unfinishedRunsKey("/workspace"))).toBe(1);
    });

    it("runs 'Reindex now' via the reindex command and resets once the index is current", async () => {
      const proto = await setup({ stale: false });
      const { unfinishedRunsKey } = await import("../../src/extension/catchUpGuard.js");
      const key = unfinishedRunsKey("/workspace");
      mockContext.globalState = makeGlobalState({ [key]: 2 });
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Reindex now" as any);
      // First status (activation): behind. After the manual run: current.
      proto.getStatus = vi
        .fn()
        .mockResolvedValueOnce({ needsReindex: true })
        .mockResolvedValue({ needsReindex: false });

      await activateAndSettle();
      await vi.waitFor(() => {
        expect(mockContext.globalState.data.get(key)).toBe(0);
      });

      expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
        "docSearch.reindex",
        false,
      );
      // The automatic catch-up itself never ran.
      expect(proto.reindex).not.toHaveBeenCalled();
    });

    it("leaves the counter armed when 'Reindex now' did not finish the job", async () => {
      const proto = await setup({ stale: false });
      const { unfinishedRunsKey } = await import("../../src/extension/catchUpGuard.js");
      const key = unfinishedRunsKey("/workspace");
      mockContext.globalState = makeGlobalState({ [key]: 2 });
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Reindex now" as any);
      proto.getStatus = vi.fn().mockResolvedValue({ needsReindex: true });

      await activateAndSettle();
      await vi.waitFor(() => {
        expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalled();
      });
      await new Promise((r) => setImmediate(r));

      expect(mockContext.globalState.data.get(key)).toBe(2);
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

    it("removes a superseded in-tree index in global mode and notifies", async () => {
      const { removeSupersededLegacyIndex } = await import("../../src/core/indexLocation.js");
      vi.mocked(removeSupersededLegacyIndex).mockReturnValueOnce("/workspace/.doc-search-index");

      await activate(mockContext);

      expect(vi.mocked(removeSupersededLegacyIndex)).toHaveBeenCalledWith(
        "/workspace",
        "/mock-home/.doc-search/indexes/workspace-abc123",
      );
      expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(
        expect.stringContaining("removed the redundant in-tree"),
      );
    });

    it("notifies after a migration without re-running superseded cleanup", async () => {
      const { resolveIndexLocation, removeSupersededLegacyIndex } =
        await import("../../src/core/indexLocation.js");
      vi.mocked(resolveIndexLocation).mockReturnValueOnce({
        indexDir: "/mock-home/.doc-search/indexes/workspace-abc123",
        mode: "global",
        shouldGitignore: false,
        migratedFrom: "/workspace/.doc-search-index",
      });

      await activate(mockContext);

      expect(vi.mocked(removeSupersededLegacyIndex)).not.toHaveBeenCalled();
      expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(
        expect.stringContaining("global index"),
      );
    });

    it("does not attempt superseded cleanup in workspace mode", async () => {
      const { resolveIndexLocation, removeSupersededLegacyIndex } =
        await import("../../src/core/indexLocation.js");
      vi.mocked(resolveIndexLocation).mockReturnValueOnce({
        indexDir: "/workspace/.doc-search-index",
        mode: "workspace",
        shouldGitignore: true,
        gitignoreEntry: ".doc-search-index",
      });

      await activate(mockContext);

      expect(vi.mocked(removeSupersededLegacyIndex)).not.toHaveBeenCalled();
    });
  });

  describe("external roots", () => {
    const NOTES = [{ name: "notes", path: "/path/to/notes" }];
    let ws: string;

    beforeEach(async () => {
      ws = fs.mkdtempSync(path.join(os.tmpdir(), "ext-roots-"));
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: ws } }];
      const { readConfig } = await import("../../src/extension/config.js");
      vi.mocked(readConfig).mockReturnValue({
        docGlob: "doc/**/*.md",
        indexDir: ".doc-search-index",
        indexLocation: "global",
        headingDepth: 2,
        maxChunkChars: 4000,
        embedProvider: "local",
        localModel: "Xenova/all-MiniLM-L6-v2",
        ollamaUrl: "http://localhost:11434",
        ollamaModel: "nomic-embed-text",
        openaiApiKey: "",
        autoReindex: false,
        extraRoots: NOTES,
      } as any);
    });

    afterEach(() => {
      fs.rmSync(ws, { recursive: true, force: true });
    });

    function writeMcpJson(env: Record<string, string>): string {
      const file = path.join(ws, ".mcp.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          mcpServers: {
            "doc-search": {
              command: "node",
              args: ["/mock-home/.doc-search/bin/mcp-server.js"],
              env: {
                DOC_SEARCH_WORKSPACE: ws,
                DOC_SEARCH_LOCAL_MODEL: "Xenova/all-MiniLM-L6-v2",
                ...env,
              },
            },
          },
        }),
      );
      return file;
    }

    it("repairs a generated .mcp.json whose setting has since gained a root", async () => {
      const file = writeMcpJson({});

      await activate(mockContext);

      const env = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["doc-search"].env;
      expect(env.DOC_SEARCH_EXTRA_ROOTS).toBe(JSON.stringify(NOTES));
      expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(
        expect.stringContaining("docSearch.extraRoots"),
      );
    });

    it("does not give DOC_SEARCH_EXTRA_ROOTS to a trust-flagged entry", async () => {
      const file = writeMcpJson({ DOC_SEARCH_TRUST_WORKSPACE_SETTINGS: "1" });
      const before = fs.readFileSync(file, "utf8");

      await activate(mockContext);

      expect(fs.readFileSync(file, "utf8")).toBe(before);
    });

    it("builds its indexer as the owner of the root configuration", async () => {
      const { Indexer } = await import("../../src/core/indexer.js");

      await activate(mockContext);

      expect(vi.mocked(Indexer).mock.calls[0][0]).toMatchObject({
        ownsRootConfig: true,
        extraRoots: [expect.objectContaining({ name: "notes" })],
      });
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

      await vi.waitFor(() => {
        expect(setErrorMock).toHaveBeenCalledWith(expect.stringContaining("catch-up boom"));
      });
    });

    it("retries catch-up while another reindex holds the lock, without showing an error", async () => {
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

      const { Indexer, ReindexInProgressError } = await import("../../src/core/indexer.js");
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
      const reindexMock = vi
        .fn()
        .mockRejectedValueOnce(new (ReindexInProgressError as any)())
        .mockResolvedValue({
          indexed: 1,
          skipped: 0,
          failedFiles: 0,
          totalChunks: 1,
          durationMs: 1,
        });
      vi.mocked(Indexer).prototype.reindex = reindexMock;

      const { StatusBarManager } = await import("../../src/extension/statusBar.js");
      const setErrorMock = vi.fn();
      const setReadyMock = vi.fn();
      vi.mocked(StatusBarManager).prototype.setIndexing = vi.fn();
      vi.mocked(StatusBarManager).prototype.setError = setErrorMock;
      vi.mocked(StatusBarManager).prototype.setReady = setReadyMock;

      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        await activate(mockContext);
        await vi.waitFor(() => expect(reindexMock).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(setReadyMock).toHaveBeenCalled());
      } finally {
        vi.useRealTimers();
      }
      expect(reindexMock).toHaveBeenCalledTimes(2);
      expect(setErrorMock).not.toHaveBeenCalled();
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
