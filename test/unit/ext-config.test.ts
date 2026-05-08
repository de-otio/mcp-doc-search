import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { readConfig, readOpenAIApiKey } from "../../src/extension/config.js";

describe("Extension Config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readConfig", () => {
    it("should read configuration with defaults", () => {
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
      };

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockCfg as any);

      const config = readConfig();

      expect(config.docGlob).toBe("doc/**/*.md");
      expect(config.embedProvider).toBe("local");
      expect(config.autoReindex).toBe(true);
    });

    it("should accept custom API key parameter", () => {
      const mockCfg = {
        get: vi.fn(() => "default"),
      };

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockCfg as any);

      const config = readConfig("custom-key");

      expect(config.openaiApiKey).toBe("custom-key");
    });

    it("should read all 8 settings", () => {
      const mockCfg = {
        get: vi.fn((key: string, defaultValue: any) => defaultValue),
      };

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockCfg as any);

      const config = readConfig();

      expect(config).toHaveProperty("docGlob");
      expect(config).toHaveProperty("indexDir");
      expect(config).toHaveProperty("headingDepth");
      expect(config).toHaveProperty("maxChunkChars");
      expect(config).toHaveProperty("embedProvider");
      expect(config).toHaveProperty("ollamaUrl");
      expect(config).toHaveProperty("ollamaModel");
      expect(config).toHaveProperty("openaiApiKey");
      expect(config).toHaveProperty("autoReindex");
    });
  });

  describe("readOpenAIApiKey", () => {
    it("should read from secure storage if available", async () => {
      const mockSecrets = {
        get: vi.fn().mockResolvedValue("secret-key"),
        store: vi.fn(),
        delete: vi.fn(),
      };

      const key = await readOpenAIApiKey(mockSecrets as any);

      expect(key).toBe("secret-key");
      expect(mockSecrets.get).toHaveBeenCalledWith("docSearch.openaiApiKey");
    });

    it("should migrate from settings to secrets", async () => {
      const mockSecrets = {
        get: vi.fn().mockResolvedValue(null),
        store: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
      };

      const mockCfg = {
        get: vi.fn().mockReturnValue("old-key"),
        update: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockCfg as any);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as any);

      const key = await readOpenAIApiKey(mockSecrets as any);

      expect(key).toBe("old-key");
      expect(mockSecrets.store).toHaveBeenCalledWith("docSearch.openaiApiKey", "old-key");
      expect(mockCfg.update).toHaveBeenCalled();
    });

    it("should return empty string when no key found", async () => {
      const mockSecrets = {
        get: vi.fn().mockResolvedValue(null),
        store: vi.fn(),
        delete: vi.fn(),
      };

      const mockCfg = {
        get: vi.fn().mockReturnValue(""),
        update: vi.fn(),
      };

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockCfg as any);

      const key = await readOpenAIApiKey(mockSecrets as any);

      expect(key).toBe("");
    });
  });
});
