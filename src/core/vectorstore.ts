/**
 * LanceDB vector store wrapper.
 * File-backed, embedded, no server process needed.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import type { LanceTable, LanceConnection, CompactStats } from "./types.js";

/**
 * Retained table versions at which the indexer compacts the store.
 * LanceDB's own guidance is to optimize after ~20 data modifications.
 */
export const COMPACT_VERSION_THRESHOLD = 20;

/** Longest index key accepted; anything past this is a bug upstream, not a path. */
const MAX_FILE_KEY_LENGTH = 2048;

/**
 * Key under which a file's chunks are found for deletion: the SHA-256 hex of
 * its index key.
 *
 * WHY hash instead of filtering on `file` directly: the filter is a SQL
 * string, and index keys are arbitrary text — `ext://<root>/<rel>` keys,
 * spaces, `@`, `%`, non-ASCII. The previous approach allow-listed characters
 * and threw on everything else, which turned every external-root delete into
 * a silent no-op (duplicated chunks on reindex, undeletable pruned files).
 * Hex needs no escaping, so nothing about the key can break the filter.
 */
export function fileHashKey(file: string): string {
  if (file.length > MAX_FILE_KEY_LENGTH) {
    throw new Error(`File key too long (max ${MAX_FILE_KEY_LENGTH} chars): ${file.slice(0, 80)}…`);
  }
  return createHash("sha256").update(file).digest("hex");
}

/**
 * Filter expression selecting a file's rows. The column name is backtick
 * quoted because Lance's SQL planner lower-cases bare identifiers and reads
 * double-quoted ones as string literals.
 */
function fileFilter(file: string): string {
  return `\`fileHash\` = '${fileHashKey(file)}'`;
}

/** Record stored in LanceDB. */
export interface VectorRecord {
  id: string;
  vector: number[];
  file: string;
  /** sha256 hex of `file`; filled in by upsert(), see fileHashKey. */
  fileHash?: string;
  heading: string;
  lineStart: number;
  text: string;
  /** Stable docid: first 6 chars of SHA-256 hex of file content */
  docid: string;
}

/** Result from a vector query (before keyword re-ranking). */
export interface VectorQueryResult {
  file: string;
  heading: string;
  lineStart: number;
  text: string;
  /** Distance from query vector (lower = more similar for cosine). */
  _distance: number;
  /** Stable docid: first 6 chars of SHA-256 hex of file content */
  docid: string;
}

export class LanceVectorStore {
  private db: LanceConnection | null = null;
  private table: LanceTable | null = null;
  private indexDir: string;
  private tableName: string;

  constructor(indexDir: string, tableName = "doc_chunks") {
    this.indexDir = indexDir;
    this.tableName = tableName;
  }

  async open(): Promise<void> {
    mkdirSync(this.indexDir, { recursive: true });
    const lancedb = await import("@lancedb/lancedb");
    this.db = (await lancedb.connect(this.indexDir)) as unknown as LanceConnection;

    try {
      this.table = await this.db.openTable(this.tableName);
    } catch {
      // Table doesn't exist yet — will be created on first upsert
      this.table = null;
    }
  }

  async ensureTable(vectorDim: number): Promise<void> {
    if (!this.db) throw new Error("Store not opened. Call open() first.");

    // If table exists, verify the vector dimension matches
    if (this.table) {
      const schema = await this.table.schema();
      const vectorField = schema.fields.find((f) => f.name === "vector");
      const existingDim = vectorField?.type?.listSize;
      if (existingDim && existingDim !== vectorDim) {
        // Dimension mismatch — drop and recreate the table
        await this.db.dropTable(this.tableName);
        this.table = null;
      } else {
        return;
      }
    }

    // Create table with a seed record that we immediately delete
    const seedRecord: VectorRecord = {
      id: "__seed__",
      vector: new Array(vectorDim).fill(0),
      file: "",
      fileHash: "",
      heading: "",
      lineStart: 0,
      text: "",
      docid: "",
    };
    this.table = await this.db.createTable(this.tableName, [seedRecord], {
      mode: "overwrite",
    });
    await this.table.delete('id = "__seed__"');
  }

  /**
   * Drop the whole table so the next ensureTable() starts from scratch.
   * Used for a full rebuild (model/chunking change). No-op without a table.
   */
  async dropTable(): Promise<void> {
    if (!this.db || !this.table) return;
    await this.db.dropTable(this.tableName);
    this.table = null;
  }

  /**
   * Remove every chunk of one file.
   *
   * Errors are logged and rethrown, never swallowed: a delete that fails
   * silently leaves stale chunks that the next upsert duplicates, so the
   * caller must treat the file as failed rather than proceed.
   */
  async deleteByFile(file: string): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.delete(fileFilter(file));
    } catch (err) {
      console.warn(
        `Vector store: failed to delete chunks for ${file}: ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (!this.table) {
      throw new Error("Table not initialized. Call ensureTable() first.");
    }
    if (records.length === 0) return;
    await this.table.add(records.map((r) => ({ ...r, fileHash: fileHashKey(r.file) })));
  }

  async query(queryVector: number[], n: number): Promise<VectorQueryResult[]> {
    if (!this.table) return [];

    const results = await this.table.search(queryVector).distanceType("cosine").limit(n).toArray();

    return results.map((row) => {
      const r = row as {
        file: string;
        heading: string;
        lineStart: number;
        text: string;
        _distance?: number;
        docid?: string;
      };
      return {
        file: r.file,
        heading: r.heading,
        lineStart: r.lineStart,
        text: r.text,
        _distance: r._distance ?? 0,
        docid: r.docid ?? "",
      };
    });
  }

  async listFiles(): Promise<Array<{ file: string; title: string }>> {
    if (!this.table) return [];

    const results = await this.table.query().toArray();
    const seen = new Map<string, string>();
    for (const row of results) {
      const r = row as { file: string; heading: string };
      if (!seen.has(r.file)) {
        seen.set(r.file, r.heading);
      }
    }

    return Array.from(seen.entries())
      .map(([file, title]) => ({ file, title }))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  async count(): Promise<number> {
    if (!this.table) return 0;
    const rows = await this.table.countRows();
    return rows;
  }

  /**
   * Number of table versions currently retained on disk.
   *
   * LanceDB writes a new manifest on every add/delete and never prunes them
   * on its own, so a corpus reindexed file-by-file on save accumulates
   * thousands of versions (one index reached 6 GB of stale versions over
   * 250 MB of live data). Counted from disk because the installed LanceDB
   * exposes no listVersions().
   */
  retainedVersions(): number {
    const versionsDir = path.join(this.indexDir, `${this.tableName}.lance`, "_versions");
    try {
      return readdirSync(versionsDir).filter((f) => f.endsWith(".manifest")).length;
    } catch {
      return 0;
    }
  }

  /**
   * Merge data fragments and drop every table version but the current one.
   * Sub-second in steady state; minutes when thousands of versions have
   * piled up. Returns null when there is no table yet.
   */
  async compact(): Promise<CompactStats | null> {
    if (!this.table) return null;
    const stats = await this.table.optimize({ cleanupOlderThan: new Date() });
    return {
      versionsRemoved: stats.prune.oldVersionsRemoved,
      bytesRemoved: stats.prune.bytesRemoved,
      fragmentsRemoved: stats.compaction.fragmentsRemoved,
    };
  }

  isOpen(): boolean {
    return this.db != null;
  }

  hasTable(): boolean {
    return this.table !== null;
  }

  async close(): Promise<void> {
    this.table = null;
    this.db = null;
  }
}
