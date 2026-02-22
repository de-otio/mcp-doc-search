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

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("docSearch");
  return {
    docGlob: cfg.get("docGlob", "doc/**/*.md"),
    indexDir: cfg.get("indexDir", ".claude/doc-index"),
    headingDepth: cfg.get("headingDepth", 2) as 1 | 2,
    maxChunkChars: cfg.get("maxChunkChars", 4000),
    embedProvider: cfg.get("embedProvider", "local") as
      | "local"
      | "ollama"
      | "openai",
    ollamaUrl: cfg.get("ollamaUrl", "http://localhost:11434"),
    ollamaModel: cfg.get("ollamaModel", "nomic-embed-text"),
    openaiApiKey: cfg.get("openaiApiKey", ""),
    autoReindex: cfg.get("autoReindex", true),
  };
}
