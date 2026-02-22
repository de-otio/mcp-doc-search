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
  totalChunks: number;
  durationMs: number;
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
