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
      const { readFileSync } = await import("node:fs");
      const { connect } = await import("@lancedb/lancedb");

      process.env.DOC_SEARCH_WORKSPACE = "/custom/workspace";
      vi.mocked(readFileSync).mockReturnValue("{}");
      vi.mocked(connect).mockResolvedValue({
        openTable: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      await createEngineFromEnv();

      expect(readFileSync).toHaveBeenCalledWith(
        expect.stringContaining("/custom/workspace"),
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
  });
});
