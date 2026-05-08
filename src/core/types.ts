/**
 * Core type definitions for the doc-search engine.
 * No VS Code or MCP dependencies — pure TypeScript.
 */

export interface DocChunk {
  /** Stable ID: md5(file:lineStart) first 12 hex chars */
  id: string;
  /** [DocTitle]\n\n<section content>, truncated to maxChunkChars */
  text: string;
  /** Relative path from workspace root (forward slashes) */
  file: string;
  /** Section heading text (# stripped) */
  heading: string;
  /** Line number where section begins (0-based) */
  lineStart: number;
}

export interface SearchResult {
  file: string;
  heading: string;
  /** First 600 chars of chunk text */
  excerpt: string;
  /** vector_score + keyword_boost, rounded to 3 decimals */
  score: number;
  lineStart: number;
}

export interface IndexStats {
  indexed: number;
  skipped: number;
  failedFiles: number;
  totalChunks: number;
  durationMs: number;
  /** Files removed from vector store (deleted/renamed/glob-excluded) */
  pruned: number;
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
}

/**
 * LanceDB table interface (minimal shape for type safety)
 */
export interface LanceTable {
  schema(): Promise<{ fields: Array<{ name: string; type?: { listSize?: number } }> }>;
  search(vector: number[]): {
    distanceType(type: string): {
      limit(n: number): { toArray(): Promise<any[]> };
    };
  };
  delete(filter: string): Promise<void>;
  add(records: any[]): Promise<void>;
  query(): { toArray(): Promise<any[]> };
  countRows(): Promise<number>;
}

/**
 * LanceDB database connection interface (minimal shape for type safety)
 */
export interface LanceConnection {
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, records: any[], options?: any): Promise<LanceTable>;
  dropTable(name: string): Promise<void>;
}

/**
 * Embedder pipeline interface for local transformers
 */
export interface EmbedderPipeline {
  (
    text: string,
    options?: { pooling?: string; normalize?: boolean },
  ): Promise<{
    tolist(): number[];
    data: Float32Array;
  }>;
}

export interface EmbedProvider {
  /**
   * Generate embeddings for a batch of texts.
   * @param texts - Array of text strings to embed
   * @param prefix - Optional prefix for task-specific embedding (e.g. "search_document: ")
   */
  embed(texts: string[], prefix?: string): Promise<number[][]>;
}

export interface IndexerConfig {
  workspaceRoot: string;
  docGlob: string;
  indexDir: string;
  maxChunkChars: number;
  headingDepth: 1 | 2;
  embedProvider: EmbedProvider;
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
    maxChunkChars: Math.max(100, Math.min(50_000, Number(raw.maxChunkChars) || 4000)),
    embedProvider,
  };
}
