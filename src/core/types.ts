/**
 * Core type definitions for the doc-search engine.
 * No VS Code or MCP dependencies — pure TypeScript.
 */

import type { ExtraRoot } from "./extraRoots.js";
import { resolveMaxChunkChars } from "./localModels.js";

export interface DocChunk {
  /** Stable ID: md5(file:lineStart) first 12 hex chars */
  id: string;
  /** [path › H1 › H2]\n\n<section content>, at most maxChunkChars */
  text: string;
  /** Relative path from workspace root (forward slashes) */
  file: string;
  /** Section heading text (# stripped) */
  heading: string;
  /** Line number where section begins (0-based) */
  lineStart: number;
  /** Stable docid: first 6 chars of SHA-256 hex of the file's full content */
  docid: string;
}

export interface SearchExplanation {
  /** Cosine similarity between the query and the chunk (same as SearchResult.score) */
  vectorScore: number;
  /**
   * 1-indexed position in the vector candidate list, or null when the chunk
   * was recovered through the full-text side only. With several queries this
   * is the best rank across them.
   */
  vectorRank: number | null;
  /**
   * 1-indexed position in the full-text (BM25) candidate list, or null when
   * the chunk was not matched literally. Best rank across queries.
   */
  ftsRank: number | null;
  /** Reciprocal-rank-fusion score the ranking is sorted by (sum of 1/(60 + rank)). */
  rrfScore: number;
  /** Query terms (see tokenizeQuery) found as substrings of the chunk text */
  keywordTermsMatched: string[];
  /** Final score (same as SearchResult.score, for completeness) */
  finalScore: number;
  /** 1-indexed position in result list */
  rank: number;
}

export interface SearchResult {
  file: string;
  heading: string;
  /** First 600 chars of chunk text */
  excerpt: string;
  /**
   * Cosine similarity between query and chunk in [0, 1], rounded to 3
   * decimals. Results are ordered by reciprocal rank fusion of the vector and
   * full-text candidate lists, so `score` is not monotonic in rank.
   */
  score: number;
  lineStart: number;
  /** Stable docid: first 6 chars of SHA-256 hex of the file's full content */
  docid: string;
  /** Optional detailed score breakdown (only when explain: true) */
  explanation?: SearchExplanation;
}

export interface IndexStats {
  indexed: number;
  skipped: number;
  failedFiles: number;
  totalChunks: number;
  durationMs: number;
  /** Files removed from vector store (deleted/renamed/glob-excluded) */
  pruned: number;
  /** First error encountered (embedding/upsert) — surfaced so the UI can show why files failed. */
  firstError?: string;
  /** Set when this run compacted the vector store (see LanceVectorStore.compact). */
  compacted?: CompactStats;
  /**
   * Set when this run discarded the whole index and re-embedded every file
   * because the on-disk index metadata no longer matched the live
   * configuration (provider, model, dimension, chunking, schema version).
   */
  rebuiltReason?: string;
}

/**
 * What produced the index, persisted as `<indexDir>/index-meta.json`.
 *
 * Exists because vectors from two different models are not comparable and
 * chunks cut with different settings do not line up: any of these fields
 * changing means the whole index must be rebuilt, not incrementally patched.
 */
export interface IndexMeta {
  /** Layout of the LanceDB table and this file. 1 = pre-metadata indexes. */
  schemaVersion: number;
  provider: string;
  model: string;
  /** Vector dimension of the stored embeddings. */
  dim: number;
  maxChunkChars: number;
  headingDepth: number;
  /** ISO timestamp of when this index generation was created. */
  createdAt: string;
}

/** Outcome of a LanceDB compaction + old-version prune. */
export interface CompactStats {
  /** Old table versions dropped from disk. */
  versionsRemoved: number;
  /** Bytes reclaimed by dropping those versions. */
  bytesRemoved: number;
  /** Data fragments merged away. */
  fragmentsRemoved: number;
}

export interface IndexStatus {
  /** Files currently matching the docGlob pattern */
  totalFiles: number;
  /** Files recorded in the mtime cache (ever indexed) */
  cachedFiles: number;
  /** Files whose mtime differs from the cache */
  changedFiles: number;
  /** Files matching the glob that are absent from the cache */
  newFiles: number;
  /** Files in the cache that no longer match the glob */
  deletedFiles: number;
  /** Total vector chunks in the store */
  chunkCount: number;
  /** When the mtime cache was last written (null = never indexed) */
  lastIndexed: Date | null;
  /** True when any file needs re-embedding */
  needsReindex: boolean;
  /** The active docGlob pattern */
  docGlob: string;
  /** Names of configured external roots (empty when none) */
  extraRootNames: string[];
  /**
   * On-disk index metadata, when present. Absent on an empty index and on
   * indexes built before metadata existed (those are rebuilt on the next
   * reindex).
   */
  meta?: IndexMeta;
}

/**
 * Path-context map: keys are relative POSIX-style path prefixes,
 * values are short prose descriptions attached to that subtree.
 */
export type PathContext = Record<string, string>;

/**
 * LanceDB scan/full-text query builder (minimal shape for type safety)
 */
export interface LanceQuery {
  fullTextSearch(query: string, options?: { columns?: string | string[] }): LanceQuery;
  limit(n: number): LanceQuery;
  toArray(): Promise<unknown[]>;
}

/**
 * LanceDB table interface (minimal shape for type safety)
 */
export interface LanceTable {
  schema(): Promise<{ fields: Array<{ name: string; type?: { listSize?: number } }> }>;
  search(vector: number[]): {
    distanceType(type: string): {
      limit(n: number): { toArray(): Promise<unknown[]> };
    };
  };
  delete(filter: string): Promise<void>;
  add(records: unknown[]): Promise<void>;
  query(): LanceQuery;
  countRows(): Promise<number>;
  createIndex(column: string, options?: { config?: unknown; replace?: boolean }): Promise<void>;
  listIndices(): Promise<Array<{ name: string; indexType: string; columns: string[] }>>;
  optimize(options?: { cleanupOlderThan?: Date }): Promise<{
    compaction: { fragmentsRemoved: number; fragmentsAdded: number };
    prune: { bytesRemoved: number; oldVersionsRemoved: number };
  }>;
}

/**
 * LanceDB database connection interface (minimal shape for type safety)
 */
export interface LanceConnection {
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, records: unknown[], options?: { mode?: string }): Promise<LanceTable>;
  dropTable(name: string): Promise<void>;
}

/**
 * Why an embedding provider is unusable.
 *
 * The distinction that matters to callers is *lifetime*: `unreachable`,
 * `model-missing`, `runner-load-failed` and `auth` are whole-run conditions —
 * every file will fail identically, so retrying the next one is wasted work.
 * `http-error` and `unknown` may be transient or file-specific.
 */
export type EmbedFailureKind =
  "unreachable" | "model-missing" | "runner-load-failed" | "auth" | "http-error" | "unknown";

/** Outcome of an EmbedProvider health probe. */
export interface HealthResult {
  ok: boolean;
  /** Set when `ok` is false. */
  kind?: EmbedFailureKind;
  /** Operator-facing detail (versions, status codes). Never contains secrets. */
  detail?: string;
  /** One-line remediation shown to the user. */
  hint?: string;
}

/** Stable identity of the embedding model behind a provider. */
export interface EmbedIdentity {
  provider: "local" | "ollama" | "openai";
  model: string;
  /** Vector dimension when known ahead of the first embed call. */
  dim?: number;
}

export interface EmbedProvider {
  /**
   * Generate embeddings for a batch of texts.
   * @param texts - Array of text strings to embed
   * @param prefix - Optional prefix for task-specific embedding (e.g. "search_document: ")
   */
  embed(texts: string[], prefix?: string): Promise<number[][]>;

  /**
   * Optional: verify the provider can actually embed, before a run commits to it.
   *
   * Exists because a broken embedder fails every file identically: without a
   * preflight, a whole-corpus reindex discovers that one 30s timeout at a time.
   * Optional so hand-built and mock providers remain valid EmbedProviders.
   */
  healthCheck?(): Promise<HealthResult>;

  /**
   * Optional: which model this provider embeds with. Recorded in the index
   * metadata so a provider/model switch forces a rebuild instead of silently
   * mixing incomparable vectors. Optional so hand-built and mock providers
   * remain valid EmbedProviders.
   */
  identity?(): EmbedIdentity;

  /**
   * Optional: dispose of any cached model/pipeline resources.
   * After calling dispose(), the next embed() call will re-initialize.
   * Primarily used for idle-timeout cleanup in HTTP daemon mode.
   */
  dispose?(): void;
}

export interface IndexerConfig {
  workspaceRoot: string;
  docGlob: string;
  indexDir: string;
  maxChunkChars: number;
  headingDepth: 1 | 2;
  embedProvider: EmbedProvider;
  /** Validated external roots (see extraRoots.ts). Defaults to []. */
  extraRoots: ExtraRoot[];
}

/**
 * Validate and normalize configuration values.
 * Returns a valid IndexerConfig with sensible defaults and clamped values.
 */
export function validateConfig(
  raw: Partial<IndexerConfig>,
  embedProvider: EmbedProvider,
): IndexerConfig {
  return {
    workspaceRoot: raw.workspaceRoot || process.cwd(),
    docGlob: raw.docGlob && raw.docGlob.trim() ? raw.docGlob.trim() : "doc/**/*.md",
    indexDir: raw.indexDir && raw.indexDir.trim() ? raw.indexDir.trim() : ".doc-search-index",
    headingDepth: raw.headingDepth === 1 ? 1 : 2,
    maxChunkChars: resolveMaxChunkChars(raw.maxChunkChars, embedProvider),
    embedProvider,
    extraRoots: raw.extraRoots ?? [],
  };
}
