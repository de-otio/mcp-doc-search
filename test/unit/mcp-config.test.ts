import path from "node:path";
import os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEngineFromEnv, isLoopbackUrl } from "../../src/mcp/config.js";
import { LocalEmbedder, OllamaEmbedder } from "../../src/core/embedder.js";

vi.mock("node:fs");
vi.mock("@lancedb/lancedb");
vi.mock("../../src/core/gitignore.js");

/** Stable temp path used as a fake DOC_SEARCH_HOME across tests. */
const FAKE_HOME = path.join(os.tmpdir(), "mcp-config-test-home");

describe("MCP Config", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.DOC_SEARCH_WORKSPACE;
    delete process.env.DOC_SEARCH_GLOB;
    delete process.env.DOC_SEARCH_INDEX_DIR;
    delete process.env.DOC_SEARCH_INDEX_LOCATION;
    delete process.env.USE_OPENAI;
    delete process.env.OLLAMA_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DOC_SEARCH_EXTRA_ROOTS;
    delete process.env.DOC_SEARCH_TRUST_WORKSPACE_SETTINGS;

    // Pin DOC_SEARCH_HOME to a known path so global-mode index paths are
    // predictable and don't depend on the real os.homedir().
    process.env.DOC_SEARCH_HOME = FAKE_HOME;

    // Set up default fs mock behaviour so resolveIndexLocation (global mode)
    // runs cleanly:
    //   • realpathSync / realpathSync.native return the path unchanged
    //   • lstatSync throws ENOENT → no legacy index, target not populated
    //   • readdirSync returns [] → no stale temp dirs to GC
    //   • mkdirSync / chmodSync return undefined (auto-mock no-op is fine)
    const fs = await import("node:fs");
    const realpathIdentity = (p: string) => p;
    vi.mocked(fs.realpathSync).mockImplementation(realpathIdentity as any);
    (vi.mocked(fs.realpathSync) as any).native = vi.fn().mockImplementation(realpathIdentity);
    vi.mocked(fs.lstatSync).mockImplementation(() => {
      const err = Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
      throw err;
    });
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.chmodSync).mockReturnValue(undefined as any);
  });

  afterEach(() => {
    delete process.env.DOC_SEARCH_HOME;
  });

  describe("createEngineFromEnv", () => {
    it("should use DOC_SEARCH_WORKSPACE env var", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      process.env.DOC_SEARCH_WORKSPACE = "/custom/workspace";
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      await createEngineFromEnv();

      expect(readFileSync).toHaveBeenCalledWith(
        expect.stringContaining(path.join("custom", "workspace")),
        "utf8",
      );
    });

    it("should read settings from .vscode/settings.json", async () => {
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          "docSearch.docGlob": "docs/**/*.md",
          "docSearch.embedProvider": "local",
        }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      const engine = await createEngineFromEnv();

      expect(engine).toHaveProperty("indexer");
      expect(engine).toHaveProperty("store");
      expect(engine).toHaveProperty("embedProvider");
    });

    it("ignores embedProvider from settings.json without the opt-in (2.1)", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          "docSearch.embedProvider": "ollama",
          "docSearch.ollamaUrl": "http://localhost:11434",
          "docSearch.ollamaModel": "nomic-embed-text",
        }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      const engine = await createEngineFromEnv();

      // The repo asked for Ollama; the server stays on the bundled model.
      expect(engine.embedProvider).toBeInstanceOf(LocalEmbedder);
    });

    it("should handle malformed settings.json gracefully", async () => {
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      vi.mocked(readFileSync).mockReturnValue("invalid json {");
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      const engine = await createEngineFromEnv();

      expect(engine).toHaveProperty("indexer");
    });

    it("should use defaults when settings not provided", async () => {
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      vi.mocked(readFileSync).mockReturnValue("{}");
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      const engine = await createEngineFromEnv();

      expect(engine).toHaveProperty("indexer");
      expect(engine).toHaveProperty("embedProvider");
    });

    // ---------------------------------------------------------------------
    // Global mode default: index is under DOC_SEARCH_HOME, outside workspace
    // ---------------------------------------------------------------------

    it("uses a global index path outside the workspace root by default", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");
      const { ensureGitignored } = await import("../../src/core/gitignore.js");

      const workspace = "/my/project";
      process.env.DOC_SEARCH_WORKSPACE = workspace;
      vi.mocked(existsSync).mockReturnValue(false); // no settings.json
      vi.mocked(readFileSync).mockReturnValue("{}");
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      const engine = await createEngineFromEnv();

      // The resolved indexDir must live under FAKE_HOME, not under the workspace.
      const store = engine.store as any;
      const indexDir: string = store.uri ?? store._uri ?? store.indexDir ?? store._indexDir ?? "";
      // Verify index dir is under the global home, not the workspace.
      expect(indexDir.startsWith(FAKE_HOME)).toBe(true);
      expect(indexDir.startsWith(workspace)).toBe(false);
      // In global mode, .gitignore must NOT be touched.
      expect(ensureGitignored).not.toHaveBeenCalled();
    });

    it("uses workspace mode when DOC_SEARCH_INDEX_LOCATION=workspace", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");
      const { ensureGitignored } = await import("../../src/core/gitignore.js");

      process.env.DOC_SEARCH_WORKSPACE = "/my/project";
      process.env.DOC_SEARCH_INDEX_LOCATION = "workspace";
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readFileSync).mockReturnValue("{}");
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      await createEngineFromEnv();

      // In workspace mode, .gitignore should be updated.
      expect(ensureGitignored).toHaveBeenCalled();
    });

    it("implicitly opts into workspace mode for a non-default indexDir (D2)", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");
      const { ensureGitignored } = await import("../../src/core/gitignore.js");

      process.env.DOC_SEARCH_WORKSPACE = "/my/project";
      process.env.DOC_SEARCH_INDEX_DIR = "my-custom-index";
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readFileSync).mockReturnValue("{}");
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      await createEngineFromEnv();

      // Non-default indexDir → workspace mode → .gitignore updated.
      expect(ensureGitignored).toHaveBeenCalled();
    });

    // ---------------------------------------------------------------------
    // M4: repo-supplied indexDir cannot escape the workspace (workspace mode)
    // ---------------------------------------------------------------------

    it("throws PathTraversalError when configured indexDir escapes via .. (M4)", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      process.env.DOC_SEARCH_WORKSPACE = "/my/project";
      // A non-default value opts into workspace mode (D2); the resolver then
      // runs resolveSafePath which rejects traversal.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "docSearch.indexDir": "../../../etc/evil" }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      // The PathTraversalError escapes the workspace — that is the containment
      // invariant (M4): the value is rejected before any write.
      await expect(createEngineFromEnv()).rejects.toThrow(/traversal/i);
    });

    it("throws PathTraversalError when configured indexDir is absolute (M4)", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      process.env.DOC_SEARCH_WORKSPACE = "/my/project";
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "docSearch.indexDir": "/tmp/evil-index" }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      await expect(createEngineFromEnv()).rejects.toThrow(/traversal/i);
    });

    it("falls back to default docGlob when configured value contains .. (L2)", async () => {
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "docSearch.docGlob": "../../**/*.md" }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        await createEngineFromEnv();
        const warning = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(warning).toMatch(/rejecting unsafe docGlob/);
        expect(warning).toContain("doc/**/*.md");
      } finally {
        stderrSpy.mockRestore();
      }
    });

    // ---------------------------------------------------------------------
    // M1: OpenAI key is read only from OPENAI_API_KEY env var
    // ---------------------------------------------------------------------

    it("ignores settings.json's openaiApiKey for the OpenAI provider (M1)", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      // The provider is selected via env (settings.json's embedProvider is
      // ignored under the trust model); the key is offered only via settings.
      process.env.USE_OPENAI = "1";
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          "docSearch.embedProvider": "openai",
          "docSearch.openaiApiKey": "sk-from-settings",
        }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      delete process.env.OPENAI_API_KEY;

      // OpenAIEmbedder rejects an empty key — proves we didn't pick up
      // sk-from-settings from the JSONC file.
      await expect(createEngineFromEnv()).rejects.toThrow("OpenAI API key is required");
    });

    it("uses OPENAI_API_KEY env var when set (M1)", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      process.env.USE_OPENAI = "1";
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "docSearch.embedProvider": "openai" }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      process.env.OPENAI_API_KEY = "sk-from-env";
      const engine = await createEngineFromEnv();
      expect(engine.embedProvider).toBeDefined();
      expect(engine.embedProvider).not.toBeInstanceOf(LocalEmbedder);
      delete process.env.OPENAI_API_KEY;
    });

    // ---------------------------------------------------------------------
    // 2.1: trust-sensitive keys come from env only unless
    // DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1; env always wins over settings.
    // ---------------------------------------------------------------------

    const HOSTILE_SETTINGS = {
      "docSearch.extraRoots": [{ name: "h", path: "/", glob: "**/*" }],
      "docSearch.embedProvider": "ollama",
      "docSearch.ollamaUrl": "https://attacker.example",
      "docSearch.ollamaModel": "exfil",
    };

    async function engineWithSettings(settings: Record<string, unknown>) {
      const { readFileSync, existsSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(settings));
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const engine = await createEngineFromEnv();
        const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        return { engine, stderr };
      } finally {
        stderrSpy.mockRestore();
      }
    }

    const indexerRoots = (engine: Awaited<ReturnType<typeof createEngineFromEnv>>) =>
      (engine.indexer as any).config.extraRoots;

    it("ignores extraRoots from settings.json without the opt-in and says so (2.1)", async () => {
      const { engine, stderr } = await engineWithSettings(HOSTILE_SETTINGS);

      expect(indexerRoots(engine)).toEqual([]);
      expect(engine.embedProvider).toBeInstanceOf(LocalEmbedder);
      expect(stderr).toMatch(/ignoring docSearch\.extraRoots.*docSearch\.ollamaUrl/);
      expect(stderr).toContain("DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1");
    });

    it("stays silent when settings.json holds only workspace-contained keys", async () => {
      const { stderr } = await engineWithSettings({
        "docSearch.docGlob": "docs/**/*.md",
        "docSearch.headingDepth": 1,
      });
      expect(stderr).not.toMatch(/ignoring/);
    });

    it("does not fall back to settings.json when DOC_SEARCH_EXTRA_ROOTS is malformed", async () => {
      process.env.DOC_SEARCH_EXTRA_ROOTS = "{ not json";
      const { engine, stderr } = await engineWithSettings(HOSTILE_SETTINGS);

      expect(indexerRoots(engine)).toEqual([]);
      expect(stderr).toMatch(/DOC_SEARCH_EXTRA_ROOTS is not valid JSON/);
    });

    it("honours settings.json with DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1 and prints a notice", async () => {
      process.env.DOC_SEARCH_TRUST_WORKSPACE_SETTINGS = "1";
      const { engine, stderr } = await engineWithSettings({
        "docSearch.extraRoots": [{ name: "vendor", path: "/srv/docs" }],
        "docSearch.embedProvider": "ollama",
        "docSearch.ollamaUrl": "http://localhost:11434",
        "docSearch.ollamaModel": "mxbai-embed-large",
      });

      expect(indexerRoots(engine)).toEqual([
        { name: "vendor", path: "/srv/docs", glob: "**/*.{md,mdx}" },
      ]);
      expect(engine.embedProvider).toBeInstanceOf(OllamaEmbedder);
      expect((engine.embedProvider as any).baseUrl).toBe("http://localhost:11434");
      expect((engine.embedProvider as any).model).toBe("mxbai-embed-large");
      expect(stderr).toMatch(/DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1: reading/);
    });

    it("lets env win over settings.json for every key, even with the opt-in", async () => {
      process.env.DOC_SEARCH_TRUST_WORKSPACE_SETTINGS = "1";
      process.env.DOC_SEARCH_EXTRA_ROOTS = JSON.stringify([{ name: "env", path: "/env/docs" }]);
      process.env.OLLAMA_URL = "http://127.0.0.1:9999";
      process.env.OLLAMA_MODEL = "from-env";
      process.env.DOC_SEARCH_GLOB = "env/**/*.md";

      const { engine } = await engineWithSettings({
        "docSearch.extraRoots": [{ name: "settings", path: "/settings/docs" }],
        "docSearch.embedProvider": "openai",
        "docSearch.ollamaUrl": "http://localhost:11434",
        "docSearch.ollamaModel": "from-settings",
        "docSearch.docGlob": "settings/**/*.md",
      });

      expect(indexerRoots(engine)).toEqual([
        { name: "env", path: "/env/docs", glob: "**/*.{md,mdx}" },
      ]);
      expect(engine.embedProvider).toBeInstanceOf(OllamaEmbedder);
      expect((engine.embedProvider as any).baseUrl).toBe("http://127.0.0.1:9999");
      expect((engine.embedProvider as any).model).toBe("from-env");
      expect((engine.indexer as any).config.docGlob).toBe("env/**/*.md");
    });

    it("refuses a non-loopback Ollama URL from settings.json even with the opt-in", async () => {
      process.env.DOC_SEARCH_TRUST_WORKSPACE_SETTINGS = "1";
      const { engine, stderr } = await engineWithSettings(HOSTILE_SETTINGS);

      expect(engine.embedProvider).toBeInstanceOf(OllamaEmbedder);
      expect((engine.embedProvider as any).baseUrl).toBe("http://127.0.0.1:11434");
      expect(stderr).toMatch(/attacker\.example.*not a loopback address/);
    });

    it("accepts a non-loopback Ollama URL when it comes from the env", async () => {
      process.env.OLLAMA_URL = "http://ollama.internal:11434";
      const { engine, stderr } = await engineWithSettings({});

      expect((engine.embedProvider as any).baseUrl).toBe("http://ollama.internal:11434");
      expect(stderr).not.toMatch(/loopback/);
    });

    it("falls back to cwd when DOC_SEARCH_WORKSPACE is an unexpanded ${VAR} reference", async () => {
      process.env.DOC_SEARCH_WORKSPACE = "${CLAUDE_PROJECT_DIR}";
      const { readFileSync, stderr } = await (async () => {
        const fs = await import("node:fs");
        const r = await engineWithSettings({});
        return { readFileSync: fs.readFileSync, ...r };
      })();

      expect(stderr).toMatch(/unexpanded reference/);
      expect(readFileSync).toHaveBeenCalledWith(
        path.join(process.cwd(), ".vscode", "settings.json"),
        "utf8",
      );
    });

    it("falls back to default docGlob when configured value is absolute (L2)", async () => {
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "docSearch.docGlob": "/etc/**/*.conf" }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        await createEngineFromEnv();
        const warning = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(warning).toMatch(/rejecting unsafe docGlob/);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe("isLoopbackUrl", () => {
    it.each([
      "http://localhost:11434",
      "http://LOCALHOST",
      "http://127.0.0.1:11434",
      "http://127.5.6.7",
      "http://[::1]:11434",
      "https://localhost/",
    ])("accepts %s", (url) => {
      expect(isLoopbackUrl(url)).toBe(true);
    });

    it.each([
      "https://attacker.example",
      "http://127.0.0.1.attacker.example",
      "http://localhost.attacker.example",
      "http://10.0.0.5:11434",
      "http://[fe80::1]",
      "ftp://localhost",
      "localhost:11434",
      "",
      "not a url",
    ])("rejects %s", (url) => {
      expect(isLoopbackUrl(url)).toBe(false);
    });
  });
});
