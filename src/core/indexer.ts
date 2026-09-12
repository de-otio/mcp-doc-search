/**
 * Documentation indexer: crawl, chunk, embed, and upsert into vector store.
 * Supports incremental indexing via mtime cache.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { chunkMarkdown, computeDocid } from "./chunker.js";
import { EmbedError, EmbedderUnavailableError, isFatalEmbedKind } from "./embedder.js";
import { EXT_REF_SCHEME, extKey, parseExtKey } from "./extraRoots.js";
import { PathTraversalError, resolveSafePath, resolveWithinBase } from "./safePath.js";
import type {
  CompactStats,
  EmbedFailureKind,
  EmbedIdentity,
  IndexerConfig,
  IndexMeta,
  IndexStats,
  IndexStatus,
  PathContext,
} from "./types.js";
import { COMPACT_VERSION_THRESHOLD } from "./vectorstore.js";
import type { LanceVectorStore, VectorRecord } from "./vectorstore.js";

/**
 * Layout version of the on-disk index. Bump when the LanceDB table schema or
 * the meaning of index-meta.json changes; every older index is then rebuilt
 * once on its next reindex.
 *
 * 1: no metadata file, `file` column only.
 * 2: index-meta.json + `fileHash` column (delete-by-hash).
 */
export const INDEX_SCHEMA_VERSION = 2;

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

/**
 * Thrown when reindex() finds another reindex holding the index lock.
 *
 * Three writers can share one index directory — the extension's file watcher,
 * a CLI `reindex`, an MCP `reindex_docs` — and two of them interleaving
 * deletes, upserts and cache writes leaves duplicated or missing chunks.
 * The message is complete on its own so CLI and MCP callers can surface it
 * verbatim.
 */
export class ReindexInProgressError extends Error {
  readonly pid: number;
  readonly startedAt: string;

  constructor(pid: number, startedAt: string) {
    super(
      `Another reindex is already running (pid ${pid}, started ${startedAt}). ` +
        `Wait for it to finish and try again.`,
    );
    this.name = "ReindexInProgressError";
    this.pid = pid;
    this.startedAt = startedAt;
  }
}

/** Contents of reindex.lock. */
interface LockHolder {
  pid: number;
  startedAt: string;
}

function readLockHolder(lockPath: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? "unknown") };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Write JSON via a temp file + rename so a reader never sees a half-written
 * file and a crash mid-write leaves the previous version intact.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

/** The metadata this run would write, before the vector dimension is known. */
type ExpectedMeta = Omit<IndexMeta, "dim" | "createdAt"> & { dim?: number };

/**
 * Explain why the on-disk index cannot be incrementally updated by a run
 * with `expected` settings, or null when it can.
 *
 * A missing metadata file on a non-empty index is a schema-1 index: its
 * `file`-only table cannot be deleted from by hash, so it is rebuilt too.
 * The dimension is only compared when the provider knows it up front; a
 * provider that learns it on the first embed is checked then (see reindex).
 */
function describeMetaMismatch(
  onDisk: IndexMeta | null,
  expected: ExpectedMeta,
  indexNonEmpty: boolean,
): string | null {
  if (!onDisk) {
    return indexNonEmpty
      ? `index predates metadata (schema v1); rebuilding as schema v${expected.schemaVersion}`
      : null;
  }
  const diffs: string[] = [];
  if (onDisk.schemaVersion !== expected.schemaVersion) {
    diffs.push(`schema v${onDisk.schemaVersion} → v${expected.schemaVersion}`);
  }
  if (onDisk.provider !== expected.provider) {
    diffs.push(`provider ${onDisk.provider} → ${expected.provider}`);
  }
  if (onDisk.model !== expected.model) {
    diffs.push(`model ${onDisk.model} → ${expected.model}`);
  }
  if (expected.dim !== undefined && onDisk.dim !== expected.dim) {
    diffs.push(`vector dimension ${onDisk.dim} → ${expected.dim}`);
  }
  if (onDisk.maxChunkChars !== expected.maxChunkChars) {
    diffs.push(`maxChunkChars ${onDisk.maxChunkChars} → ${expected.maxChunkChars}`);
  }
  if (onDisk.headingDepth !== expected.headingDepth) {
    diffs.push(`headingDepth ${onDisk.headingDepth} → ${expected.headingDepth}`);
  }
  return diffs.length > 0 ? diffs.join(", ") : null;
}

export class Indexer {
  private config: IndexerConfig;
  private store: LanceVectorStore;
  private _contextCache: PathContext | null = null;

  /**
   * Consecutive per-file embed failures tolerated before abandoning the run.
   * Non-fatal errors can be genuinely file-specific, so allow a few; a longer
   * streak means the provider itself is broken.
   */
  private static readonly MAX_CONSECUTIVE_EMBED_FAILURES = 3;

  /** Below this many files to index, skip the preflight probe (see reindex). */
  private static readonly MIN_FILES_FOR_PREFLIGHT = 5;

  constructor(config: IndexerConfig, store: LanceVectorStore) {
    // Normalize: callers constructing a config by hand may omit extraRoots.
    this.config = { ...config, extraRoots: config.extraRoots ?? [] };
    this.store = store;
  }

  /** Returns the absolute workspace root path. */
  getWorkspaceRoot(): string {
    return this.config.workspaceRoot;
  }

  /**
   * Map an absolute file path back to its index key: an `ext://<name>/<rel>`
   * key when the path lives under a configured external root, otherwise the
   * workspace-relative path. Used for display in tool responses.
   */
  keyForAbsPath(absPath: string): string {
    const abs = path.resolve(absPath);
    for (const root of this.config.extraRoots) {
      const base = path.resolve(root.path);
      const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
      if (abs.startsWith(baseWithSep)) {
        return extKey(root.name, path.relative(base, abs));
      }
    }
    return path.relative(this.config.workspaceRoot, abs).replace(/\\/g, "/");
  }

  /**
   * Enumerate every file the index should contain, as { absPath, key } pairs:
   * workspace files keyed by workspace-relative path, external-root files
   * keyed as `ext://<name>/<rel>`.
   *
   * A configured root whose directory is missing (unmounted disk, not yet
   * cloned) is skipped for scanning AND excluded from pruning — its existing
   * index entries survive until the root reappears or is unconfigured.
   */
  private async scanFiles(): Promise<{
    entries: Array<{ absPath: string; key: string }>;
    missingRootPrefixes: string[];
  }> {
    const entries: Array<{ absPath: string; key: string }> = [];

    const mdFiles = await glob(this.config.docGlob, {
      cwd: this.config.workspaceRoot,
      absolute: true,
      ignore: ["**/node_modules/**"],
    });
    mdFiles.sort();
    for (const filePath of mdFiles) {
      const rel = path.relative(this.config.workspaceRoot, filePath).replace(/\\/g, "/");
      // Path traversal validation
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        console.warn(`Path traversal blocked: ${filePath} is outside workspace`);
        continue;
      }
      entries.push({ absPath: filePath, key: rel });
    }

    const missingRootPrefixes: string[] = [];
    for (const root of this.config.extraRoots) {
      if (!existsSync(root.path)) {
        missingRootPrefixes.push(`${EXT_REF_SCHEME}${root.name}/`);
        console.warn(
          `Extra root "${root.name}" not found on disk; keeping its existing index entries`,
        );
        continue;
      }
      const rootFiles = await glob(root.glob, {
        cwd: root.path,
        absolute: true,
        ignore: ["**/node_modules/**"],
        nodir: true,
      });
      rootFiles.sort();
      for (const filePath of rootFiles) {
        const rel = path.relative(root.path, filePath).replace(/\\/g, "/");
        if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
        entries.push({ absPath: filePath, key: extKey(root.name, rel) });
      }
    }

    return { entries, missingRootPrefixes };
  }

  /**
   * Crawl doc files, embed changed files, upsert into vector store.
   * Returns stats: { indexed, skipped, totalChunks, durationMs, pruned }
   *
   * Holds `<indexDir>/reindex.lock` for the whole run (compaction included);
   * a concurrent reindex from another process throws ReindexInProgressError.
   *
   * Throws EmbedderUnavailableError when the embedding provider is unusable —
   * either at preflight or after repeated failures mid-run.
   *
   * @param force - Re-index all files even if unchanged
   * @param onProgress - Optional callback invoked after each file is processed.
   *   Receives (processedCount, totalToProcess, currentFile, phase) where
   *   phase is "scanning" before the loop starts, "loading" while the provider
   *   is being probed, "indexing" after a file is stored, or "failed" after a
   *   file could not be embedded.
   */
  async reindex(
    force = false,
    onProgress?: (
      processed: number,
      total: number,
      file: string,
      phase: "scanning" | "loading" | "indexing" | "failed",
    ) => void,
  ): Promise<IndexStats> {
    const releaseLock = this.acquireReindexLock();
    try {
      return await this.reindexLocked(force, onProgress);
    } finally {
      releaseLock();
    }
  }

  private async reindexLocked(
    force: boolean,
    onProgress?: (
      processed: number,
      total: number,
      file: string,
      phase: "scanning" | "loading" | "indexing" | "failed",
    ) => void,
  ): Promise<IndexStats> {
    const t0 = Date.now();
    // Always load real cache for prune sweep; force only clears the embed decision
    let cache: MtimeCache = this.loadMtimeCache();
    let newCache: MtimeCache = {};

    onProgress?.(0, 0, "", "scanning");

    const { entries, missingRootPrefixes } = await this.scanFiles();

    // Index metadata: vectors from a different model, or chunks cut with
    // different settings, cannot be mixed into the existing table. Decide up
    // front whether this run patches the index or replaces it.
    const identity = this.config.embedProvider.identity?.();
    const expectedMeta = this.expectedMeta(identity);
    const onDiskMeta = this.loadIndexMeta();
    let rebuiltReason: string | undefined;
    let staleKeys: string[] = [];

    // Drop everything: table, mtime cache, prune list. Every file is then
    // re-embedded, which is the only way the index and the cache stay in step
    // — merging the old cache back in is exactly what used to lose files.
    const beginRebuild = async (reason: string): Promise<void> => {
      rebuiltReason = reason;
      console.warn(`Rebuilding index: ${reason}`);
      await this.store.dropTable();
      cache = {};
      newCache = {};
      staleKeys = [];
    };

    const mismatch = describeMetaMismatch(onDiskMeta, expectedMeta, (await this.store.count()) > 0);
    if (mismatch) {
      await beginRebuild(mismatch);
    } else {
      // Prune: remove vector store entries for files no longer on disk / in glob.
      // Keys under a currently-missing external root are kept, not pruned.
      const currentSet = new Set(entries.map((e) => e.key));
      staleKeys = Object.keys(cache).filter(
        (rel) => !currentSet.has(rel) && !missingRootPrefixes.some((p) => rel.startsWith(p)),
      );
      for (const rel of staleKeys) {
        try {
          await this.store.deleteByFile(rel);
        } catch (err) {
          console.warn(
            `Prune: failed to delete chunks for ${rel}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    // Files that actually need indexing (skipped ones don't count for progress)
    const needsIndexing = ({ absPath, key }: { absPath: string; key: string }): boolean => {
      const entry = cache[key];
      const mtime = entry ? normalizeCacheEntry(entry).mtime : undefined;
      return mtime !== String(statSync(absPath).mtimeMs);
    };
    let toIndex = force || rebuiltReason !== undefined ? entries : entries.filter(needsIndexing);

    let indexed = 0;
    let skipped = 0;
    let failedFiles = 0;
    let totalChunks = 0;
    let firstEmbed = true;
    let firstError: string | undefined;
    let consecutiveFailures = 0;
    let metaWritten = false;

    // Persist whatever has been indexed so far. Called on the normal path and
    // before an abort: the successful files' vectors are already in the store,
    // so dropping their cache entries would force a pointless re-embed.
    const persistCache = (): void => {
      const staleSet = new Set(staleKeys);
      const mergedCache: MtimeCache = {};
      for (const [k, v] of Object.entries(cache)) {
        if (!staleSet.has(k)) mergedCache[k] = v;
      }
      for (const [k, v] of Object.entries(newCache)) {
        mergedCache[k] = v;
      }
      this.saveMtimeCache(mergedCache);
    };

    const abort = (message: string, kind: EmbedFailureKind, hint?: string): never => {
      persistCache();
      throw new EmbedderUnavailableError(message, kind, { hint, indexed });
    };

    const reportFailure = (rel: string, what: string, err: unknown): void => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: ${what} for ${rel}: ${msg}`);
      if (firstError === undefined) firstError = msg;
      failedFiles++;
      // Report the failure so callers keep showing progress. Without this the
      // UI stays frozen on whatever phase preceded it while the run grinds on.
      onProgress?.(indexed, toIndex.length, rel, "failed");
    };

    // Preflight: a broken provider fails every file identically, so probe once
    // here rather than rediscovering it one timeout at a time across the corpus.
    //
    // Skipped for very small runs. The probe costs a round trip (and, on a paid
    // provider, a request) and its whole value is avoiding N failures on a large
    // corpus — with a handful of files the first real embed surfaces the problem
    // just as fast. This keeps save-triggered incremental reindexes cheap.
    if (
      toIndex.length >= Indexer.MIN_FILES_FOR_PREFLIGHT &&
      this.config.embedProvider.healthCheck
    ) {
      onProgress?.(0, toIndex.length, "", "loading");
      firstEmbed = false;
      const health = await this.config.embedProvider.healthCheck();
      if (!health.ok) {
        abort(
          health.detail ?? "The embedding provider is not available.",
          health.kind ?? "unknown",
          health.hint,
        );
      }
    }

    // Index-based loop so a rebuild discovered mid-run (see the dimension
    // check below) can restart from the first file.
    for (let i = 0; i < entries.length; i++) {
      const { absPath: filePath, key: rel } = entries[i];
      const mtime = String(statSync(filePath).mtimeMs);
      const existingEntry = cache[rel] ? normalizeCacheEntry(cache[rel]) : undefined;

      if (!force && rebuiltReason === undefined && existingEntry?.mtime === mtime) {
        skipped++;
        newCache[rel] = existingEntry;
        continue;
      }

      const chunks = chunkMarkdown(
        filePath,
        this.config.workspaceRoot,
        this.config.maxChunkChars,
        this.config.headingDepth,
        rel,
      );

      // Compute docid from file content (or reuse from chunks if available)
      const fileContent = readFileSync(filePath, "utf8");
      const docid = computeDocid(fileContent);

      if (chunks.length === 0) {
        newCache[rel] = { mtime, docid };
        continue;
      }

      // Delete old chunks for this file (fixes stale chunk accumulation). A
      // failed delete means the new chunks would duplicate the old ones, so
      // the file counts as failed and keeps its old cache entry out.
      try {
        await this.store.deleteByFile(rel);
      } catch (err) {
        reportFailure(rel, "could not replace stale chunks", err);
        continue;
      }

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
        reportFailure(rel, "embedding failed", err);
        consecutiveFailures++;

        if (err instanceof EmbedError && isFatalEmbedKind(err.kind)) {
          abort(`${rel}: ${msg}`, err.kind, err.hint);
        }
        if (consecutiveFailures >= Indexer.MAX_CONSECUTIVE_EMBED_FAILURES) {
          abort(
            `Embedding failed for ${consecutiveFailures} files in a row; last error — ${rel}: ${msg}`,
            err instanceof EmbedError ? err.kind : "unknown",
            err instanceof EmbedError ? err.hint : undefined,
          );
        }
        continue;
      }
      consecutiveFailures = 0;
      const dim = embeddings[0].length;

      // A provider that only learns its dimension by embedding (Ollama) is
      // checked here, at the first embed, and the run restarts as a rebuild if
      // it differs from what the index holds. Nothing has been upserted yet.
      if (!metaWritten) {
        if (rebuiltReason === undefined && onDiskMeta && onDiskMeta.dim !== dim) {
          await beginRebuild(`vector dimension ${onDiskMeta.dim} → ${dim}`);
          toIndex = entries;
          indexed = 0;
          skipped = 0;
          failedFiles = 0;
          totalChunks = 0;
          firstError = undefined;
          i = -1;
          continue;
        }
        if (onDiskMeta === null || rebuiltReason !== undefined) {
          this.saveIndexMeta({ ...expectedMeta, dim, createdAt: new Date().toISOString() });
        }
        metaWritten = true;
      }

      // Ensure table exists with the correct vector dimension
      await this.store.ensureTable(dim);

      const records: VectorRecord[] = chunks.map((c, j) => ({
        id: c.id,
        vector: embeddings[j],
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
    persistCache();

    // Every write above left a table version behind; reclaim them once enough
    // have piled up. Checked regardless of whether this run wrote anything so
    // a backlog from before compaction existed is cleared on the next run.
    let compacted: CompactStats | undefined;
    if (this.store.retainedVersions() >= COMPACT_VERSION_THRESHOLD) {
      try {
        compacted = (await this.store.compact()) ?? undefined;
      } catch (err) {
        console.warn(`Compact: failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    return {
      indexed,
      skipped,
      failedFiles,
      totalChunks,
      durationMs: Date.now() - t0,
      pruned: staleKeys.length,
      firstError,
      compacted,
      rebuiltReason,
    };
  }

  /** Compute the current index health without modifying anything. */
  async getStatus(): Promise<IndexStatus> {
    const cache = this.loadMtimeCache();
    const { entries, missingRootPrefixes } = await this.scanFiles();

    const fileSet = new Set(entries.map((e) => e.key));

    let changedFiles = 0;
    let newFiles = 0;
    for (const { absPath, key } of entries) {
      if (!(key in cache)) {
        newFiles++;
      } else {
        const entry = normalizeCacheEntry(cache[key]);
        if (entry.mtime !== String(statSync(absPath).mtimeMs)) {
          changedFiles++;
        }
      }
    }

    const deletedFiles = Object.keys(cache).filter(
      (rel) => !fileSet.has(rel) && !missingRootPrefixes.some((p) => rel.startsWith(p)),
    ).length;

    const cachePath = this.mtimeCachePath();
    const lastIndexed = existsSync(cachePath) ? new Date(statSync(cachePath).mtimeMs) : null;

    const chunkCount = await this.store.count();

    return {
      totalFiles: entries.length,
      cachedFiles: Object.keys(cache).length,
      changedFiles,
      newFiles,
      deletedFiles,
      chunkCount,
      lastIndexed,
      needsReindex: changedFiles > 0 || newFiles > 0 || deletedFiles > 0,
      docGlob: this.config.docGlob,
      extraRootNames: this.config.extraRoots.map((r) => r.name),
      meta: this.loadIndexMeta() ?? undefined,
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
    writeJsonAtomic(this.contextPath(), ctx);
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
    writeJsonAtomic(this.mtimeCachePath(), cache);
  }

  // ---------------------------------------------------------------------------
  // Index metadata
  // ---------------------------------------------------------------------------

  private indexMetaPath(): string {
    return path.join(this.config.indexDir, "index-meta.json");
  }

  /** The on-disk metadata, or null when absent or unreadable. */
  private loadIndexMeta(): IndexMeta | null {
    const metaPath = this.indexMetaPath();
    if (!existsSync(metaPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<IndexMeta>;
      if (typeof parsed.schemaVersion !== "number") return null;
      return {
        schemaVersion: parsed.schemaVersion,
        provider: String(parsed.provider ?? "unknown"),
        model: String(parsed.model ?? "unknown"),
        dim: Number(parsed.dim ?? 0),
        maxChunkChars: Number(parsed.maxChunkChars ?? 0),
        headingDepth: Number(parsed.headingDepth ?? 0),
        createdAt: String(parsed.createdAt ?? ""),
      };
    } catch {
      return null;
    }
  }

  private saveIndexMeta(meta: IndexMeta): void {
    writeJsonAtomic(this.indexMetaPath(), meta);
  }

  /** What this run would record, given the live config and provider. */
  private expectedMeta(identity: EmbedIdentity | undefined): ExpectedMeta {
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      provider: identity?.provider ?? "unknown",
      model: identity?.model ?? "unknown",
      dim: identity?.dim,
      maxChunkChars: this.config.maxChunkChars,
      headingDepth: this.config.headingDepth,
    };
  }

  // ---------------------------------------------------------------------------
  // Reindex lock
  // ---------------------------------------------------------------------------

  private lockPath(): string {
    return path.join(this.config.indexDir, "reindex.lock");
  }

  /**
   * Take `<indexDir>/reindex.lock` exclusively (O_EXCL create) and return the
   * release function. A lock whose recorded pid is no longer running is
   * stale — left by a crashed run — and is replaced; a live holder throws
   * ReindexInProgressError.
   */
  private acquireReindexLock(): () => void {
    mkdirSync(this.config.indexDir, { recursive: true });
    const lockPath = this.lockPath();
    const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString() };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, "wx");
        try {
          writeSync(fd, JSON.stringify(holder));
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // Already removed (e.g. a stale-lock sweep by another process).
          }
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const existing = readLockHolder(lockPath);
        if (existing && isProcessAlive(existing.pid)) {
          throw new ReindexInProgressError(existing.pid, existing.startedAt);
        }
        // Stale (dead pid) or unreadable: remove it and try once more.
        try {
          unlinkSync(lockPath);
        } catch {
          // Someone else cleaned it up first; the retry decides.
        }
      }
    }
    throw new Error("Could not acquire the reindex lock: another process keeps recreating it");
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
   * Resolve an `ext://<name>/<rel>` key to { file, docid } or { error }.
   * The relative part is re-contained against the realpath of the named
   * root — a key can never read outside the directory the root declares.
   */
  private resolveExtKey(key: string): { file: string; docid: string } | { error: string } {
    const parsed = parseExtKey(key);
    if (!parsed) {
      return { error: `Malformed external ref: ${key}` };
    }
    const root = this.config.extraRoots.find((r) => r.name === parsed.name);
    if (!root) {
      return { error: `Unknown external root: ${parsed.name}` };
    }
    // Canonicalize the root first so a symlinked root cannot redirect the
    // containment check (see resolveWithinBase docs).
    let base: string;
    try {
      base = realpathSync(root.path);
    } catch {
      return { error: `External root "${parsed.name}" is not available` };
    }
    let absPath: string;
    try {
      absPath = resolveWithinBase(base, parsed.rel);
    } catch (err) {
      if (err instanceof PathTraversalError) return { error: err.message };
      throw err;
    }
    if (!existsSync(absPath)) {
      return { error: `File not found: ${key}` };
    }
    const cache = this.loadMtimeCache();
    const entry = cache[key] ? normalizeCacheEntry(cache[key]) : undefined;
    let docid = entry?.docid ?? "";
    if (!docid) {
      try {
        docid = computeDocid(readFileSync(absPath, "utf8"));
      } catch {
        docid = "";
      }
    }
    return { file: absPath, docid };
  }

  /**
   * Resolve a ref to { file: absolutePath, docid } or { error }.
   *
   * Accepted ref forms:
   *   - "#abc123" — docid with leading hash
   *   - "abc123"  — bare 6-char hex docid (all hex chars, exactly 6)
   *   - "doc/foo.md" — relative path from workspace root
   *   - "ext://<root>/<path>" — file under a configured external root
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
      if (rel.startsWith(EXT_REF_SCHEME)) {
        const resolved = this.resolveExtKey(rel);
        if ("error" in resolved) return resolved;
        return { file: resolved.file, docid };
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

    // External-root ref
    if (trimmed.startsWith(EXT_REF_SCHEME)) {
      return this.resolveExtKey(trimmed);
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
