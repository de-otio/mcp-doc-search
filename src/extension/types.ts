/**
 * Webview message protocol types for extension panels
 */

/**
 * Search panel message types
 */
export type SearchMessage =
  | { type: "search"; query: string }
  | { type: "openResult"; file: string; line: number };

export type SearchResultMessage =
  | {
      type: "searching";
    }
  | {
      type: "results";
      query: string;
      results: Array<{
        file: string;
        heading: string;
        excerpt: string;
        score: number;
        lineStart: number;
      }>;
      error?: string;
    };

/**
 * Settings panel message types
 */
export type SettingsMessage =
  | { type: "ready" }
  | {
      type: "saveConfig";
      config: {
        docGlob: string;
        indexDir: string;
        headingDepth: 1 | 2;
        maxChunkChars: number;
        embedProvider: string;
        ollamaUrl: string;
        ollamaModel: string;
        autoReindex: boolean;
      };
    }
  | {
      type: "testConnection";
      provider: "ollama" | "openai";
      ollamaUrl?: string;
      apiKey?: string;
    }
  | { type: "checkOllama"; ollamaUrl: string };

export type SettingsResultMessage =
  | {
      type: "config";
      config: {
        docGlob: string;
        indexDir: string;
        headingDepth: 1 | 2;
        maxChunkChars: number;
        embedProvider: string;
        ollamaUrl: string;
        ollamaModel: string;
        autoReindex: boolean;
      };
    }
  | { type: "saveResult"; ok: boolean }
  | { type: "testResult"; ok: boolean }
  | { type: "ollamaStatus"; installed: boolean; running: boolean };

/**
 * Index status panel message types
 */
export type IndexStatusMessage = { type: "ready" } | { type: "reindex" };

export type IndexStatusResultMessage = {
  type: "status" | "progress";
  status?: {
    totalFiles: number;
    cachedFiles: number;
    changedFiles: number;
    newFiles: number;
    deletedFiles: number;
    chunkCount: number;
    lastIndexed: string | null;
    needsReindex: boolean;
  };
  progress?: {
    processed: number;
    total: number;
    file: string;
    phase: string;
  };
};

/**
 * MCP setup panel message types
 */
export type McpSetupMessage = { type: "copy" };

export type McpSetupResultMessage =
  | { type: "copyResult"; ok: boolean }
  | { type: "copyResultError"; error: string };
