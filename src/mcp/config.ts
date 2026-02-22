import path from "node:path";
import { LanceVectorStore } from "../core/vectorstore.js";
import { Indexer } from "../core/indexer.js";
import { LocalEmbedder, OllamaEmbedder, OpenAIEmbedder } from "../core/embedder.js";
import type { EmbedProvider } from "../core/types.js";

export interface EngineDeps {
  store: LanceVectorStore;
  indexer: Indexer;
  embedProvider: EmbedProvider;
}

export async function createEngineFromEnv(): Promise<EngineDeps> {
  const workspaceRoot = process.env.DOC_SEARCH_WORKSPACE ?? process.cwd();
  const docGlob = process.env.DOC_SEARCH_GLOB ?? "doc/**/*.md";
  const indexDir = path.join(workspaceRoot, process.env.DOC_SEARCH_INDEX_DIR ?? ".claude/doc-index");

  let embedProvider: EmbedProvider;
  if (process.env.USE_OPENAI === "1") {
    embedProvider = new OpenAIEmbedder(process.env.OPENAI_API_KEY ?? "");
  } else if (process.env.OLLAMA_URL) {
    embedProvider = new OllamaEmbedder(process.env.OLLAMA_MODEL ?? "nomic-embed-text", process.env.OLLAMA_URL);
  } else {
    embedProvider = new LocalEmbedder();
  }

  const store = new LanceVectorStore(indexDir);
  await store.open();

  const indexer = new Indexer({
    workspaceRoot,
    docGlob,
    indexDir,
    maxChunkChars: 4000,
    headingDepth: 2,
    embedProvider,
  }, store);

  return { store, indexer, embedProvider };
}
