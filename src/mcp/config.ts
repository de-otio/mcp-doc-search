import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { LanceVectorStore } from "../core/vectorstore.js";
import { Indexer } from "../core/indexer.js";
import { LocalEmbedder, OllamaEmbedder, OpenAIEmbedder } from "../core/embedder.js";
import type { EmbedProvider } from "../core/types.js";
import { validateConfig } from "../core/types.js";
import { ensureGitignored } from "../core/gitignore.js";
import { PathTraversalError, isSafeRelativeRef, resolveSafePath } from "../core/safePath.js";

const DEFAULT_DOC_GLOB = "doc/**/*.md";
const DEFAULT_INDEX_DIR = ".doc-search-index";

export interface EngineDeps {
  store: LanceVectorStore;
  indexer: Indexer;
  embedProvider: EmbedProvider;
}

/**
 * Read VS Code workspace settings from .vscode/settings.json.
 * Properly parses JSONC (JSON with comments) format.
 * Returns the parsed object, or {} if the file doesn't exist or can't be parsed.
 */
function readWorkspaceSettings(workspaceRoot: string): Record<string, any> {
  const settingsPath = path.join(workspaceRoot, ".vscode", "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    const raw = readFileSync(settingsPath, "utf8");
    return parse(raw) as Record<string, any>;
  } catch {
    return {};
  }
}

export async function createEngineFromEnv(): Promise<EngineDeps> {
  const workspaceRoot = process.env.DOC_SEARCH_WORKSPACE ?? process.cwd();
  const settings = readWorkspaceSettings(workspaceRoot);

  // Settings cascade: env vars → .vscode/settings.json → defaults
  // Env vars take priority since they represent explicit MCP server configuration.
  // L2: reject globs that escape the workspace; the glob is not a path, so we
  // validate it as a syntactically-safe relative ref rather than resolving it.
  const rawGlob = process.env.DOC_SEARCH_GLOB ?? settings["docSearch.docGlob"] ?? DEFAULT_DOC_GLOB;
  let docGlob: string;
  if (isSafeRelativeRef(rawGlob)) {
    docGlob = rawGlob;
  } else {
    process.stderr.write(
      `mcp-doc-search: rejecting unsafe docGlob "${rawGlob}" (absolute or contains ..); ` +
        `falling back to "${DEFAULT_DOC_GLOB}"\n`,
    );
    docGlob = DEFAULT_DOC_GLOB;
  }

  // M4: indexDir must resolve inside the workspace. A configured value that
  // escapes via absolute path or .. is replaced with the default, with a
  // warning to stderr (visible to whoever runs the MCP server).
  const rawIndexDir =
    process.env.DOC_SEARCH_INDEX_DIR ?? settings["docSearch.indexDir"] ?? DEFAULT_INDEX_DIR;
  let indexDirRelative = rawIndexDir;
  let indexDir: string;
  try {
    indexDir = resolveSafePath(workspaceRoot, rawIndexDir);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      process.stderr.write(
        `mcp-doc-search: rejecting unsafe indexDir "${rawIndexDir}" ` +
          `(${err.message}); falling back to "${DEFAULT_INDEX_DIR}"\n`,
      );
      indexDirRelative = DEFAULT_INDEX_DIR;
      indexDir = path.join(workspaceRoot, DEFAULT_INDEX_DIR);
    } else {
      throw err;
    }
  }
  ensureGitignored(workspaceRoot, indexDirRelative);
  const maxChunkChars = settings["docSearch.maxChunkChars"] ?? 4000;
  const headingDepth = settings["docSearch.headingDepth"] ?? 2;

  // Embedding provider: env vars → settings.json → local
  const providerName =
    (process.env.USE_OPENAI === "1" ? "openai" : undefined) ??
    (process.env.OLLAMA_URL ? "ollama" : undefined) ??
    settings["docSearch.embedProvider"] ??
    "local";

  let embedProvider: EmbedProvider;
  if (providerName === "openai") {
    // M1: never read the OpenAI key from settings.json. The extension stores
    // it in VS Code's SecretStorage (per-machine, encrypted). For the MCP
    // server and CLI the only supported source is the OPENAI_API_KEY env var,
    // set by the user in .mcp.json or their shell. Reading settings.json
    // here exposed the key in plaintext via JSONC parsing of a file that
    // is commonly committed to repos.
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    embedProvider = new OpenAIEmbedder(apiKey);
  } else if (providerName === "ollama") {
    const ollamaModel =
      settings["docSearch.ollamaModel"] ?? process.env.OLLAMA_MODEL ?? "nomic-embed-text";
    const ollamaUrl =
      settings["docSearch.ollamaUrl"] ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
    embedProvider = new OllamaEmbedder(ollamaModel, ollamaUrl);
  } else {
    embedProvider = new LocalEmbedder();
  }

  const store = new LanceVectorStore(indexDir);
  await store.open();

  const config = validateConfig(
    {
      workspaceRoot,
      docGlob,
      indexDir,
      maxChunkChars,
      headingDepth: headingDepth as 1 | 2,
    },
    embedProvider,
  );

  const indexer = new Indexer(config, store);

  return { store, indexer, embedProvider };
}
