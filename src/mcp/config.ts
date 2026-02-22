import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { LanceVectorStore } from "../core/vectorstore.js";
import { Indexer } from "../core/indexer.js";
import { LocalEmbedder, OllamaEmbedder, OpenAIEmbedder } from "../core/embedder.js";
import type { EmbedProvider } from "../core/types.js";

export interface EngineDeps {
  store: LanceVectorStore;
  indexer: Indexer;
  embedProvider: EmbedProvider;
}

/**
 * Read VS Code workspace settings from .vscode/settings.json.
 * Returns the parsed object, or {} if the file doesn't exist or can't be parsed.
 */
function readWorkspaceSettings(workspaceRoot: string): Record<string, any> {
  const settingsPath = path.join(workspaceRoot, ".vscode", "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    const raw = readFileSync(settingsPath, "utf8");
    // Strip single-line comments (VS Code settings.json allows them)
    const stripped = raw.replace(/\/\/.*$/gm, "");
    return JSON.parse(stripped);
  } catch {
    return {};
  }
}

export async function createEngineFromEnv(): Promise<EngineDeps> {
  const workspaceRoot = process.env.DOC_SEARCH_WORKSPACE ?? process.cwd();
  const settings = readWorkspaceSettings(workspaceRoot);

  // Settings cascade: .vscode/settings.json → env vars → defaults
  const docGlob =
    settings["docSearch.docGlob"] ??
    process.env.DOC_SEARCH_GLOB ??
    "doc/**/*.md";
  const indexDir = path.join(
    workspaceRoot,
    settings["docSearch.indexDir"] ??
      process.env.DOC_SEARCH_INDEX_DIR ??
      ".claude/doc-index",
  );
  const maxChunkChars = settings["docSearch.maxChunkChars"] ?? 4000;
  const headingDepth = settings["docSearch.headingDepth"] ?? 2;

  // Embedding provider: settings.json → env vars → local
  const providerName =
    settings["docSearch.embedProvider"] ??
    (process.env.USE_OPENAI === "1" ? "openai" : undefined) ??
    (process.env.OLLAMA_URL ? "ollama" : undefined) ??
    "local";

  let embedProvider: EmbedProvider;
  if (providerName === "openai") {
    const apiKey =
      settings["docSearch.openaiApiKey"] ??
      process.env.OPENAI_API_KEY ??
      "";
    embedProvider = new OpenAIEmbedder(apiKey);
  } else if (providerName === "ollama") {
    const ollamaModel =
      settings["docSearch.ollamaModel"] ??
      process.env.OLLAMA_MODEL ??
      "nomic-embed-text";
    const ollamaUrl =
      settings["docSearch.ollamaUrl"] ??
      process.env.OLLAMA_URL ??
      "http://localhost:11434";
    embedProvider = new OllamaEmbedder(ollamaModel, ollamaUrl);
  } else {
    embedProvider = new LocalEmbedder();
  }

  const store = new LanceVectorStore(indexDir);
  await store.open();

  const indexer = new Indexer({
    workspaceRoot,
    docGlob,
    indexDir,
    maxChunkChars,
    headingDepth: headingDepth as 1 | 2,
    embedProvider,
  }, store);

  return { store, indexer, embedProvider };
}
