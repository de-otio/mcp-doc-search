import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEngineFromEnv } from "../../src/mcp/config.js";

vi.mock("node:fs");
vi.mock("@lancedb/lancedb");
vi.mock("../../src/core/gitignore.js");

describe("MCP Config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DOC_SEARCH_WORKSPACE;
    delete process.env.DOC_SEARCH_GLOB;
    delete process.env.DOC_SEARCH_INDEX_DIR;
    delete process.env.USE_OPENAI;
    delete process.env.OLLAMA_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.OPENAI_API_KEY;
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

    it("should respect embedProvider selection from settings", async () => {
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

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

      expect(engine.embedProvider).toBeDefined();
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
    // M4 + L2: unsafe configuration is rejected with a stderr warning
    // ---------------------------------------------------------------------

    it("falls back to default indexDir when configured value escapes the workspace (M4)", async () => {
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "docSearch.indexDir": "../../../etc/evil" }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        await createEngineFromEnv();
        const warning = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(warning).toMatch(/rejecting unsafe indexDir/);
        expect(warning).toContain(".doc-search-index");
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("falls back to default indexDir when configured value is absolute (M4)", async () => {
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ "docSearch.indexDir": "/tmp/evil-index" }),
      );
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        await createEngineFromEnv();
        const warning = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(warning).toMatch(/rejecting unsafe indexDir/);
      } finally {
        stderrSpy.mockRestore();
      }
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
});
