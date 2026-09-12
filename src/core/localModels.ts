/**
 * Registry of the models the built-in (transformers.js) embedder can run,
 * and the chunk-budget arithmetic derived from them.
 *
 * Pure data and arithmetic — no loader, no I/O — so config validation can
 * depend on it without pulling the ONNX runtime into every import.
 */

import type { EmbedProvider } from "./types.js";

/** transformers.js weight variants (the library picks the file suffix). */
export type LocalModelDtype = "fp32" | "q8" | "q4";

export interface LocalModelSpec {
  /** Hugging Face repo id, as passed to transformers.js. */
  id: string;
  /** Short name for pickers. */
  label: string;
  /** Vector dimension. */
  dim: number;
  /**
   * Tokens the model is documented to attend to. Drives the model-derived
   * chunk budget (see defaultMaxChunkChars): the tokenizer truncates silently
   * past this point, so any chunk text beyond it never reaches the vector.
   */
  ctxTokens: number;
  /** Prefix the model was trained to expect on query-side text ("" = none). */
  queryPrefix: string;
  /** Prefix the model was trained to expect on document-side text ("" = none). */
  docPrefix: string;
  /** Weight variant to download; undefined = the transformers.js default (fp32 on Node). */
  dtype?: LocalModelDtype;
  /** Human-readable language coverage, for pickers. */
  languages: string;
  /** Approximate one-time download for `dtype`, in MB, for pickers. */
  downloadMb: number;
  /**
   * How the ONNX graph is driven. `feature-extraction`: the graph returns
   * token states and the pipeline mean-pools them. `sentence-embedding`: the
   * graph pools itself and returns `sentence_embedding` (EmbeddingGemma).
   */
  runner: "feature-extraction" | "sentence-embedding";
}

export const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Every entry was checked on 2026-09-12 against its Hugging Face model card
 * and the repo's `onnx/` file listing (transformers.js 3.8.1 installed):
 *
 * - Xenova/all-MiniLM-L6-v2: card shows 384-dim output, mean pooling, no task
 *   prefixes; the upstream sentence-transformers card states "input text
 *   longer than 256 word pieces is truncated". onnx/model.onnx 86 MB (fp32,
 *   what the Node default loads), model_quantized.onnx 22 MB.
 * - Xenova/multilingual-e5-small (upstream intfloat card): 384-dim, 512
 *   tokens, mean pooling, prefixes "query: " / "passage: ", ~95 languages
 *   including de/en. onnx/model.onnx 470 MB, model_quantized.onnx 118 MB.
 * - nomic-ai/nomic-embed-text-v1.5: 768-dim (Matryoshka 512/256/128/64),
 *   8192 tokens, prefixes "search_query: " / "search_document: ", English;
 *   the card's transformers.js example uses this repo id with mean pooling.
 *   onnx/model.onnx 522 MB, model_quantized.onnx 131 MB.
 * - onnx-community/embeddinggemma-300m-ONNX: 768-dim (MRL 512/256/128),
 *   2048 tokens, 100+ languages, prompts "task: search result | query: " and
 *   "title: none | text: ", dtypes fp32/q8/q4 only ("activations do not
 *   support fp16"). The card drives it with AutoModel and reads
 *   `sentence_embedding` — the graph pools itself, hence the runner kind.
 *   onnx/model_quantized 309 MB, model_q4 188 MB, model 1.2 GB.
 */
export const LOCAL_MODELS: Record<string, LocalModelSpec> = {
  "Xenova/all-MiniLM-L6-v2": {
    id: "Xenova/all-MiniLM-L6-v2",
    label: "all-MiniLM-L6-v2",
    dim: 384,
    ctxTokens: 256,
    queryPrefix: "",
    docPrefix: "",
    languages: "English",
    downloadMb: 90,
    runner: "feature-extraction",
  },
  "Xenova/multilingual-e5-small": {
    id: "Xenova/multilingual-e5-small",
    label: "multilingual-e5-small",
    dim: 384,
    ctxTokens: 512,
    queryPrefix: "query: ",
    docPrefix: "passage: ",
    dtype: "q8",
    languages: "~95 languages incl. German",
    downloadMb: 118,
    runner: "feature-extraction",
  },
  "nomic-ai/nomic-embed-text-v1.5": {
    id: "nomic-ai/nomic-embed-text-v1.5",
    label: "nomic-embed-text-v1.5",
    dim: 768,
    ctxTokens: 8192,
    queryPrefix: "search_query: ",
    docPrefix: "search_document: ",
    dtype: "q8",
    languages: "English",
    downloadMb: 131,
    runner: "feature-extraction",
  },
  "onnx-community/embeddinggemma-300m-ONNX": {
    id: "onnx-community/embeddinggemma-300m-ONNX",
    label: "EmbeddingGemma 300m",
    dim: 768,
    ctxTokens: 2048,
    queryPrefix: "task: search result | query: ",
    docPrefix: "title: none | text: ",
    dtype: "q8",
    languages: "100+ languages",
    downloadMb: 310,
    runner: "sentence-embedding",
  },
};

/** Chunk budget when the model's window is unknown (Ollama, OpenAI). */
export const LEGACY_MAX_CHUNK_CHARS = 4000;
const MIN_AUTO_CHUNK_CHARS = 800;
const MAX_AUTO_CHUNK_CHARS = 8000;
/** Rough characters per token for markdown prose under WordPiece/SentencePiece. */
const CHARS_PER_TOKEN = 3;

/**
 * Resolve a registry id (or blank for the default) to its spec.
 * Throws on an unknown id: a typo must surface at startup, not as an index
 * silently built with a different model than the one configured.
 */
export function resolveLocalModel(id?: string): LocalModelSpec {
  const key = id?.trim() || DEFAULT_LOCAL_MODEL;
  const spec = LOCAL_MODELS[key];
  if (!spec) {
    throw new Error(
      `Unknown local embedding model "${key}". Known models: ${Object.keys(LOCAL_MODELS).join(", ")}`,
    );
  }
  return spec;
}

/**
 * Chunk budget that fits the model's window: ctxTokens × 3 chars, clamped to
 * [800, 8000]. MiniLM's 256 tokens give 800; the previous fixed 4000 meant
 * the second half of every large chunk contributed nothing to its vector.
 */
export function defaultMaxChunkChars(spec: LocalModelSpec): number {
  return Math.max(
    MIN_AUTO_CHUNK_CHARS,
    Math.min(MAX_AUTO_CHUNK_CHARS, spec.ctxTokens * CHARS_PER_TOKEN),
  );
}

/**
 * An explicit positive value wins (clamped to 100–50000). Anything else —
 * 0, unset, non-numeric — is "auto": model-derived for a registry model,
 * the legacy 4000 for Ollama/OpenAI or a provider that reports no identity.
 */
export function resolveMaxChunkChars(raw: unknown, provider: EmbedProvider | undefined): number {
  const explicit = Number(raw);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(100, Math.min(50_000, explicit));
  }
  const identity = provider?.identity?.();
  const spec = identity?.provider === "local" ? LOCAL_MODELS[identity.model] : undefined;
  return spec ? defaultMaxChunkChars(spec) : LEGACY_MAX_CHUNK_CHARS;
}
