/**
 * Documentation indexer: crawl, chunk, embed, and upsert into vector store.
 * Supports incremental indexing via mtime cache.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { chunkMarkdown } from "./chunker.js";
import type { IndexerConfig, IndexStats } from "./types.js";
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
   */
  async reindex(force = false): Promise<IndexStats> {
    const t0 = Date.now();
    const cache: MtimeCache = force ? {} : this.loadMtimeCache();
    const newCache: MtimeCache = {};

    const mdFiles = await glob(this.config.docGlob, {
      cwd: this.config.workspaceRoot,
      absolute: true,
    });
    mdFiles.sort();

    let indexed = 0;
    let skipped = 0;
    let totalChunks = 0;

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
