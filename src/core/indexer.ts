/**
 * Documentation indexer: crawl, chunk, embed, and upsert into vector store.
 * Supports incremental indexing via mtime cache.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { chunkMarkdown, computeDocid } from "./chunker.js";
import { PathTraversalError, resolveSafePath } from "./safePath.js";
import type { IndexerConfig, IndexStats, IndexStatus, PathContext } from "./types.js";
import type { LanceVectorStore, VectorRecord } from "./vectorstore.js";

/** Per-file entry in the mtime cache. Supports both old (string) and new (object) formats. */
interface MtimeCacheEntry {
  mtime: string;
  docid: string;
}

interface MtimeCache {
  [relPath: string]: string | MtimeCacheEntry;
}

/** Normalize a cache entry to the new object format. */
function normalizeCacheEntry(entry: string | MtimeCacheEntry): MtimeCacheEntry {
  if (typeof entry === "string") {
    return { mtime: entry, docid: "" };
  }
  return entry;
}

export class Indexer {
  private config: IndexerConfig;
  private store: LanceVectorStore;
  private _contextCache: PathContext | null = null;

  constructor(config: IndexerConfig, store: LanceVectorStore) {
    this.config = config;
    this.store = store;
  }

  /** Returns the absolute workspace root path. */
  getWorkspaceRoot(): string {
    return this.config.workspaceRoot;
  }

  /**
   * Crawl doc files, embed changed files, upsert into vector store.
   * Returns stats: { indexed, skipped, totalChunks, durationMs, pruned }
   *
   * @param force - Re-index all files even if unchanged
   * @param onProgress - Optional callback invoked after each file is processed.
   *   Receives (processedCount, totalToProcess, currentFile, phase) where
   *   phase is "scanning" before the loop starts, "loading" on first embed,
   *   or "indexing" during the main loop.
   */
  async reindex(
    force = false,
    onProgress?: (
      processed: number,
      total: number,
      file: string,
      phase: "scanning" | "loading" | "indexing",
    ) => void,
  ): Promise<IndexStats> {
    const t0 = Date.now();
    // Always load real cache for prune sweep; force only clears the embed decision
    const cache: MtimeCache = this.loadMtimeCache();
    const newCache: MtimeCache = {};

    onProgress?.(0, 0, "", "scanning");

    const mdFiles = await glob(this.config.docGlob, {
      cwd: this.config.workspaceRoot,
      absolute: true,
      ignore: ["**/node_modules/**"],
    });
    mdFiles.sort();

    // Prune: remove vector store entries for files no longer on disk / in glob
    const currentSet = new Set(
      mdFiles.map((f) => path.relative(this.config.workspaceRoot, f).replace(/\\/g, "/")),
    );
    const staleKeys = Object.keys(cache).filter((rel) => !currentSet.has(rel));
    for (const rel of staleKeys) {
      try {
        await this.store.deleteByFile(rel);
      } catch (err) {
        console.warn(
          `Prune: failed to delete chunks for ${rel}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    const pruned = staleKeys.length;

    // Files that actually need indexing (skipped ones don't count for progress)
    const toIndex = force
      ? mdFiles
      : mdFiles.filter((f) => {
          const rel = path.relative(this.config.workspaceRoot, f).replace(/\\/g, "/");
          const entry = cache[rel];
          const mtime = entry ? normalizeCacheEntry(entry).mtime : undefined;
          return mtime !== String(statSync(f).mtimeMs);
        });

    let indexed = 0;
    let skipped = 0;
    let failedFiles = 0;
    let totalChunks = 0;
    let firstEmbed = true;
    let firstError: string | undefined;

    for (const filePath of mdFiles) {
      const rel = path.relative(this.config.workspaceRoot, filePath).replace(/\\/g, "/");

      // Path traversal validation
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        console.warn(`Path traversal blocked: ${filePath} is outside workspace`);
        continue;
      }

      const mtime = String(statSync(filePath).mtimeMs);
      const existingEntry = cache[rel] ? normalizeCacheEntry(cache[rel]) : undefined;

      if (!force && existingEntry?.mtime === mtime) {
        skipped++;
        newCache[rel] = existingEntry;
        continue;
      }

      const chunks = chunkMarkdown(
        filePath,
        this.config.workspaceRoot,
        this.config.maxChunkChars,
        this.config.headingDepth,
      );

      // Compute docid from file content (or reuse from chunks if available)
      const fileContent = readFileSync(filePath, "utf8");
      const docid = computeDocid(fileContent);

      if (chunks.length === 0) {
        newCache[rel] = { mtime, docid };
        continue;
      }

      // Delete old chunks for this file (fixes stale chunk accumulation)
      await this.store.deleteByFile(rel);

      // Batch embed all chunks
      const texts = chunks.map((c) => c.text);
      let embeddings: number[][];
      try {
        if (firstEmbed) {
          onProgress?.(0, toIndex.length, rel, "loading");
          firstEmbed = false;
        }
        embeddings = await this.config.embedProvider.embed(texts, "search_document: ");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: embedding failed for ${rel}: ${msg}`);
        if (firstError === undefined) firstError = msg;
        failedFiles++;
        continue;
      }

      // Ensure table exists with the correct vector dimension
      await this.store.ensureTable(embeddings[0].length);

      const records: VectorRecord[] = chunks.map((c, i) => ({
        id: c.id,
        vector: embeddings[i],
        file: c.file,
        heading: c.heading,
        lineStart: c.lineStart,
        text: c.text,
        docid,
      }));

      await this.store.upsert(records);
      newCache[rel] = { mtime, docid };
      indexed++;
      totalChunks += chunks.length;
      onProgress?.(indexed, toIndex.length, rel, "indexing");
    }

    // Merge new cache with unchanged entries from old cache, excluding pruned keys
    const staleSet = new Set(staleKeys);
    const mergedCache: MtimeCache = {};
    for (const [k, v] of Object.entries(cache)) {
      if (!staleSet.has(k)) mergedCache[k] = v;
    }
    for (const [k, v] of Object.entries(newCache)) {
      mergedCache[k] = v;
    }
    this.saveMtimeCache(mergedCache);

    return {
      indexed,
      skipped,
      failedFiles,
      totalChunks,
      durationMs: Date.now() - t0,
      pruned,
      firstError,
    };
  }

  /** Compute the current index health without modifying anything. */
  async getStatus(): Promise<IndexStatus> {
    const cache = this.loadMtimeCache();
    const mdFiles = await glob(this.config.docGlob, {
      cwd: this.config.workspaceRoot,
      absolute: true,
      ignore: ["**/node_modules/**"],
    });

    const fileSet = new Set(
      mdFiles.map((f) => path.relative(this.config.workspaceRoot, f).replace(/\\/g, "/")),
    );

    let changedFiles = 0;
    let newFiles = 0;
    for (const filePath of mdFiles) {
      const rel = path.relative(this.config.workspaceRoot, filePath).replace(/\\/g, "/");
      if (!(rel in cache)) {
        newFiles++;
      } else {
        const entry = normalizeCacheEntry(cache[rel]);
        if (entry.mtime !== String(statSync(filePath).mtimeMs)) {
          changedFiles++;
        }
      }
    }

    const deletedFiles = Object.keys(cache).filter((rel) => !fileSet.has(rel)).length;

    const cachePath = this.mtimeCachePath();
    const lastIndexed = existsSync(cachePath) ? new Date(statSync(cachePath).mtimeMs) : null;

    const chunkCount = await this.store.count();

    return {
      totalFiles: mdFiles.length,
      cachedFiles: Object.keys(cache).length,
      changedFiles,
      newFiles,
      deletedFiles,
      chunkCount,
      lastIndexed,
      needsReindex: changedFiles > 0 || newFiles > 0 || deletedFiles > 0,
      docGlob: this.config.docGlob,
    };
  }

  // ---------------------------------------------------------------------------
  // Path-context API
  // ---------------------------------------------------------------------------

  private contextPath(): string {
    return path.join(this.config.indexDir, "context.json");
  }

  private loadContextCache(): PathContext {
    if (this._contextCache !== null) {
      return this._contextCache;
    }
    const p = this.contextPath();
    if (existsSync(p)) {
      try {
        this._contextCache = JSON.parse(readFileSync(p, "utf8")) as PathContext;
      } catch {
        this._contextCache = {};
      }
    } else {
      this._contextCache = {};
    }
    return this._contextCache;
  }

  private saveContextCache(ctx: PathContext): void {
    mkdirSync(this.config.indexDir, { recursive: true });
    writeFileSync(this.contextPath(), JSON.stringify(ctx, null, 2));
    this._contextCache = ctx;
  }

  /**
   * Walk parent prefixes of relPath and return the most-specific context match.
   * Returns "" when no context entry exists for any ancestor.
   */
  getContextFor(relPath: string): string {
    const ctx = this.loadContextCache();
    // Normalize to POSIX forward slashes
    const normalized = relPath.replace(/\\/g, "/");

    // Build candidate prefixes from most-specific to least-specific
    const candidates: string[] = [];
    candidates.push(normalized); // exact file path
    let cur = normalized;
    for (;;) {
      const slash = cur.lastIndexOf("/");
      if (slash < 0) {
        // No more slashes: check the bare segment, then "" (root)
        candidates.push(cur.slice(0, slash < 0 ? cur.length : slash));
        break;
      }
      cur = cur.slice(0, slash);
      candidates.push(cur);
    }
    candidates.push(""); // root context

    for (const candidate of candidates) {
      if (Object.prototype.hasOwnProperty.call(ctx, candidate)) {
        return ctx[candidate];
      }
    }
    return "";
  }

  /**
   * Set a context description for a path prefix.
   * - Normalizes prefix to POSIX slashes.
   * - Throws if prefix contains ".." or is an absolute path.
   * - If text is empty after stripping whitespace, removes the entry instead.
   */
  setContext(prefix: string, text: string): void {
    const normalized = prefix.replace(/\\/g, "/");

    if (path.isAbsolute(normalized) || path.isAbsolute(prefix)) {
      throw new Error(`Context prefix must not be absolute: "${prefix}"`);
    }
    if (normalized.split("/").some((seg) => seg === "..")) {
      throw new Error(`Context prefix must not contain "..": "${prefix}"`);
    }

    const trimmed = text.trim();
    if (!trimmed) {
      this.removeContext(normalized);
      return;
    }

    // Reload from disk to avoid clobbering external edits
    this._contextCache = null;
    const ctx = { ...this.loadContextCache() };
    ctx[normalized] = trimmed;
    this.saveContextCache(ctx);
  }

  /**
   * Remove the context entry for a prefix.
   * Returns true if the entry existed, false otherwise.
   */
  removeContext(prefix: string): boolean {
    const normalized = prefix.replace(/\\/g, "/");
    // Reload from disk to pick up external edits
    this._contextCache = null;
    const ctx = { ...this.loadContextCache() };
    if (!Object.prototype.hasOwnProperty.call(ctx, normalized)) {
      return false;
    }
    delete ctx[normalized];
    this.saveContextCache(ctx);
    return true;
  }

  /**
   * Return a copy of the entire context map.
   */
  listContexts(): PathContext {
    return { ...this.loadContextCache() };
  }

  // ---------------------------------------------------------------------------
  // mtime-cache helpers
  // ---------------------------------------------------------------------------

  private mtimeCachePath(): string {
    return path.join(this.config.indexDir, "mtime_cache.json");
  }

  private loadMtimeCache(): MtimeCache {
    const cachePath = this.mtimeCachePath();
    if (existsSync(cachePath)) {
      try {
        return JSON.parse(readFileSync(cachePath, "utf8")) as MtimeCache;
      } catch {
        return {};
      }
    }
    return {};
  }

  private saveMtimeCache(cache: MtimeCache): void {
    mkdirSync(this.config.indexDir, { recursive: true });
    writeFileSync(this.mtimeCachePath(), JSON.stringify(cache, null, 2));
  }

  /**
   * Build a reverse map from docid -> relPath from the mtime cache.
   * Entries with empty or missing docid are skipped.
   */
  private buildDocidMap(): Map<string, string> {
    const cache = this.loadMtimeCache();
    const map = new Map<string, string>();
    for (const [rel, entry] of Object.entries(cache)) {
      const normalized = normalizeCacheEntry(entry);
      if (normalized.docid) {
        map.set(normalized.docid, rel);
      }
    }
    return map;
  }

  /**
   * Resolve a ref to { file: absolutePath, docid } or { error }.
   *
   * Accepted ref forms:
   *   - "#abc123" — docid with leading hash
   *   - "abc123"  — bare 6-char hex docid (all hex chars, exactly 6)
   *   - "doc/foo.md" — relative path from workspace root
   */
  resolveRef(ref: string): { file: string; docid: string } | { error: string } {
    const trimmed = ref.trim();

    // Determine if this looks like a docid reference
    const isHashRef = trimmed.startsWith("#");
    const bareId = isHashRef ? trimmed.slice(1) : trimmed;
    const isBareDocid = !isHashRef && /^[0-9a-f]{6}$/i.test(trimmed);

    if (isHashRef || isBareDocid) {
      const docid = bareId.toLowerCase();
      const docidMap = this.buildDocidMap();
      const rel = docidMap.get(docid);
      if (!rel) {
        return { error: `No file found for docid: ${docid}` };
      }
      let absPath: string;
      try {
        absPath = resolveSafePath(this.config.workspaceRoot, rel);
      } catch (err) {
        if (err instanceof PathTraversalError) return { error: err.message };
        throw err;
      }
      if (!existsSync(absPath)) {
        return { error: `File not found for docid: ${docid}` };
      }
      return { file: absPath, docid };
    }

    // Treat as a relative path.
    let absPath: string;
    try {
      absPath = resolveSafePath(this.config.workspaceRoot, trimmed);
    } catch (err) {
      if (err instanceof PathTraversalError) return { error: err.message };
      throw err;
    }
    const rel = path.relative(this.config.workspaceRoot, absPath).replace(/\\/g, "/");
    if (!existsSync(absPath)) {
      return { error: `File not found: ${rel}` };
    }
    // Look up docid from cache, or compute on the fly.
    const cache = this.loadMtimeCache();
    const entry = cache[rel] ? normalizeCacheEntry(cache[rel]) : undefined;
    let docid = entry?.docid ?? "";
    if (!docid) {
      try {
        const content = readFileSync(absPath, "utf8");
        docid = computeDocid(content);
      } catch {
        docid = "";
      }
    }
    return { file: absPath, docid };
  }
}
