import * as vscode from "vscode";

export interface ExtensionConfig {
  docGlob: string;
  indexDir: string;
  headingDepth: 1 | 2;
  maxChunkChars: number;
  embedProvider: "local" | "ollama" | "openai";
  ollamaUrl: string;
  ollamaModel: string;
  openaiApiKey: string;
  autoReindex: boolean;
}

export function readConfig(apiKey = ""): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("docSearch");
  return {
    docGlob: cfg.get("docGlob", "doc/**/*.md"),
    indexDir: cfg.get("indexDir", ".doc-search-index"),
    headingDepth: cfg.get("headingDepth", 2) as 1 | 2,
    maxChunkChars: cfg.get("maxChunkChars", 4000),
    embedProvider: cfg.get("embedProvider", "local") as "local" | "ollama" | "openai",
    ollamaUrl: cfg.get("ollamaUrl", "http://localhost:11434"),
    ollamaModel: cfg.get("ollamaModel", "nomic-embed-text"),
    openaiApiKey: apiKey || cfg.get("openaiApiKey", ""),
    autoReindex: cfg.get("autoReindex", true),
  };
}

/**
 * Read OpenAI API key from secure storage with fallback to settings.
 * On first activation, migrate from settings to secrets if key exists.
 */
export async function readOpenAIApiKey(secrets: vscode.SecretStorage): Promise<string> {
  const secretKey = "docSearch.openaiApiKey";

  // Try to read from secure storage first
  const storedKey = await secrets.get(secretKey);
  if (storedKey) {
    return storedKey;
  }

  // Fallback: try to migrate from settings
  const cfg = vscode.workspace.getConfiguration("docSearch");
  const settingKey = cfg.get("openaiApiKey", "");
  if (settingKey) {
    // Migrate to secure storage and clear setting
    await secrets.store(secretKey, settingKey);
    await cfg.update("openaiApiKey", undefined, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(
      "Doc Search: API key migrated to secure storage for better security.",
    );
    return settingKey;
  }

  return "";
}
