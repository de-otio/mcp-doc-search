/**
 * Documentation indexer: crawl, chunk, embed, and upsert into vector store.
 * Supports incremental indexing via mtime cache.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { chunkMarkdown } from "./chunker.js";
import type { IndexerConfig, IndexStats, IndexStatus } from "./types.js";
import type { LanceVectorStore, VectorRecord } from "./vectorstore.js";

interface MtimeCache {
  [relPath: string]: string;
}

export class Indexer {
  private config: IndexerConfig;
  private store: LanceVectorStore;

  constructor(config: IndexerConfig, store: LanceVectorStore) {
    this.config = config;
    this.store = store;
  }

  /**
   * Crawl doc files, embed changed files, upsert into vector store.
   * Returns stats: { indexed, skipped, totalChunks, durationMs }
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
    const cache: MtimeCache = force ? {} : this.loadMtimeCache();
    const newCache: MtimeCache = {};

    onProgress?.(0, 0, "", "scanning");

    const mdFiles = await glob(this.config.docGlob, {
      cwd: this.config.workspaceRoot,
      absolute: true,
    });
    mdFiles.sort();

    // Files that actually need indexing (skipped ones don't count for progress)
    const toIndex = force
      ? mdFiles
      : mdFiles.filter((f) => {
          const rel = path
            .relative(this.config.workspaceRoot, f)
            .replace(/\\/g, "/");
          return cache[rel] !== String(statSync(f).mtimeMs);
        });

    let indexed = 0;
    let skipped = 0;
    let totalChunks = 0;
    let firstEmbed = true;

    for (const filePath of mdFiles) {
      const rel = path
        .relative(this.config.workspaceRoot, filePath)
        .replace(/\\/g, "/");
      const mtime = String(statSync(filePath).mtimeMs);

      if (!force && cache[rel] === mtime) {
        skipped++;
        newCache[rel] = mtime;
        continue;
      }

      const chunks = chunkMarkdown(
        filePath,
        this.config.workspaceRoot,
        this.config.maxChunkChars,
        this.config.headingDepth,
      );

      if (chunks.length === 0) {
        newCache[rel] = mtime;
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
        embeddings = await this.config.embedProvider.embed(
          texts,
          "search_document: ",
        );
      } catch (err) {
        console.error(
          `Warning: embedding failed for ${rel}: ${err instanceof Error ? err.message : err}`,
        );
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
      }));

      await this.store.upsert(records);
      newCache[rel] = mtime;
      indexed++;
      totalChunks += chunks.length;
      onProgress?.(indexed, toIndex.length, rel, "indexing");
    }

    // Merge new cache with unchanged entries from old cache
    this.saveMtimeCache({ ...cache, ...newCache });

    return {
      indexed,
      skipped,
      totalChunks,
      durationMs: Date.now() - t0,
    };
  }

  /** Compute the current index health without modifying anything. */
  async getStatus(): Promise<IndexStatus> {
    const cache = this.loadMtimeCache();
    const mdFiles = await glob(this.config.docGlob, {
      cwd: this.config.workspaceRoot,
      absolute: true,
    });

    const fileSet = new Set(
      mdFiles.map((f) =>
        path.relative(this.config.workspaceRoot, f).replace(/\\/g, "/"),
      ),
    );

    let changedFiles = 0;
    let newFiles = 0;
    for (const filePath of mdFiles) {
      const rel = path
        .relative(this.config.workspaceRoot, filePath)
        .replace(/\\/g, "/");
      if (!(rel in cache)) {
        newFiles++;
      } else if (cache[rel] !== String(statSync(filePath).mtimeMs)) {
        changedFiles++;
      }
    }

    const deletedFiles = Object.keys(cache).filter(
      (rel) => !fileSet.has(rel),
    ).length;

    const cachePath = this.mtimeCachePath();
    const lastIndexed = existsSync(cachePath)
      ? new Date(statSync(cachePath).mtimeMs)
      : null;

    const chunkCount = await this.store.count();

    return {
      totalFiles: mdFiles.length,
      cachedFiles: Object.keys(cache).length,
      changedFiles,
      newFiles,
      deletedFiles,
      chunkCount,
      lastIndexed,
      needsReindex: changedFiles > 0 || newFiles > 0,
      docGlob: this.config.docGlob,
    };
  }

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
}
