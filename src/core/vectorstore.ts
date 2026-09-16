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

/**
 * How long a superseded table version survives compaction.
 *
 * Pruning to *now* deletes versions that live readers in OTHER processes are
 * still holding — LanceDB tracks no readers, so a handle opened before the
 * compaction dereferences a manifest that no longer exists and every read
 * through it fails. The recommended setup (editor extension + MCP server on
 * one index directory) makes that a routine collision, not a corner case.
 * An hour outlives any in-flight read; the cost is one extra generation of
 * superseded versions, reclaimed by the next compaction.
 *
 * This narrows the race; it does not close it. `withFreshTable` is what makes
 * losing it survivable.
 */
export const COMPACT_GRACE_MS = 60 * 60 * 1000;

/**
 * True for the error a read gets when the table version its handle is pinned to
 * has been compacted away by another process. Two forms, both observed:
 *
 *   Failed to execute query stream: GenericFailure, lance error:
 *   Not found: …/doc_chunks.lance/_versions/1352.manifest
 *
 *   Failed to get next batch from stream: lance error: LanceError(IO):
 *   … Not found: …/doc_chunks.lance/data/<uuid>.lance
 *
 * Which one surfaces depends on what the pinned version still needs off disk —
 * the manifest itself, or a data fragment the compaction rewrote. Matched on
 * text because `@lancedb/lancedb` reports both as `GenericFailure`/`LanceError`
 * with no structured code to switch on; requiring a path inside the table
 * directory keeps a plain "Not found" (a missing table, say) from being read as
 * a stale handle.
 */
export function isStaleHandleError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("Not found:")) return false;
  return msg.includes(".manifest") || msg.includes(".lance/");
}

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

/** Result from a full-text (BM25) query. */
export interface FtsQueryResult {
  file: string;
  heading: string;
  lineStart: number;
  text: string;
  /** Stable docid: first 6 chars of SHA-256 hex of file content */
  docid: string;
  /** Stored embedding, so the searcher can report a cosine score for FTS-only hits. */
  vector: number[];
  /** BM25 relevance (unbounded; only its rank order is used). */
  _score: number;
}

/** Result from a vector query (before rank fusion). */
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

  /**
   * Run a read against the current table, recovering once from a stale handle.
   *
   * `open()` pins the handle to one table version and nothing re-points it, so
   * a compaction in another process (the extension reindexing while an MCP
   * server is up) used to break every subsequent read in this process
   * permanently — the store had no path back to a live version short of a
   * reindex. One `checkoutLatest()` (or a reconnect where that is missing) and
   * a single retry is all it takes; a second failure is real and propagates.
   */
  private async withFreshTable<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (err) {
      if (!isStaleHandleError(err)) throw err;
      console.warn(
        `Vector store: table handle was pinned to a version that has been compacted ` +
          `away; re-opening and retrying once.`,
      );
      await this.refreshTable();
      if (!this.table) return fallback;
      return await read();
    }
  }

  /** Re-point `this.table` at the newest table version. */
  private async refreshTable(): Promise<void> {
    const table = this.table;
    if (table?.checkoutLatest) {
      try {
        await table.checkoutLatest();
        return;
      } catch {
        // Fall through: a full reopen also recovers a handle too stale to
        // check out (e.g. the table was dropped and recreated).
      }
    }
    await this.open();
  }

  async ensureTable(vectorDim: number): Promise<void> {
    if (!this.db) throw new Error("Store not opened. Call open() first.");

    // If table exists, verify the vector dimension matches
    if (this.table) {
      const schema = await this.table.schema();
      const vectorField = schema.fields.find((f) => f.name === "vector");
      const existingDim = vectorField?.type?.listSize;
      if (existingDim && existingDim !== vectorDim) {
        // Dimension mismatch. Every deliberate rebuild (Indexer sees the
        // provider/model/dim change in index-meta.json) drops the table before
        // it gets here, so reaching this branch with rows in the table means
        // the mismatch went undetected — dropping silently would destroy an
        // index nobody asked to rebuild. Refuse and name both sides instead;
        // an empty table carries no data, so that still recreates.
        const rows = await this.table.countRows();
        if (rows > 0) {
          throw new Error(
            `Refusing to rebuild the index at ${this.indexDir}: it holds ${rows} rows of ` +
              `${existingDim}-dimension vectors and this process embeds at ${vectorDim}. ` +
              `Two runners sharing one index resolved different embedding models — pin the ` +
              `provider so they agree (see doc/configuration.md), then reindex deliberately.`,
          );
        }
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
    return this.withFreshTable(async () => {
      const table = this.table;
      if (!table) return [];

      let results: unknown[];
      try {
        results = await table.search(queryVector).distanceType("cosine").limit(n).toArray();
      } catch (err) {
        throw (await this.explainDimMismatch(queryVector.length)) ?? err;
      }

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
    }, []);
  }

  /**
   * Turn a failed search into a message that names the actual problem when the
   * query vector and the stored vectors have different widths.
   *
   * This is what two runners that disagree about the embedding provider look
   * like from the read side: the index was built at one model's dimension and
   * this process embeds at another's. Lance reports it as an opaque planner
   * error, which cost an afternoon to diagnose once. Returns null when the
   * dimensions do agree, so the original error stands.
   */
  private async explainDimMismatch(queryDim: number): Promise<Error | null> {
    const table = this.table;
    if (!table) return null;
    let storedDim: number | undefined;
    try {
      const schema = await table.schema();
      storedDim = schema.fields.find((f) => f.name === "vector")?.type?.listSize;
    } catch {
      return null;
    }
    if (!storedDim || storedDim === queryDim) return null;
    return new Error(
      `Embedding dimension mismatch: the index at ${this.indexDir} holds ` +
        `${storedDim}-dimension vectors but this process embeds at ${queryDim}. ` +
        `Two runners sharing one index resolved different embedding models — pin the ` +
        `provider so they agree (see doc/configuration.md), then reindex.`,
    );
  }

  async listFiles(): Promise<Array<{ file: string; title: string }>> {
    return this.withFreshTable(async () => {
      const table = this.table;
      if (!table) return [];

      const results = await table.query().toArray();
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
    }, []);
  }

  async count(): Promise<number> {
    return this.withFreshTable(async () => {
      const table = this.table;
      if (!table) return 0;
      return await table.countRows();
    }, 0);
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
   * Merge data fragments and drop table versions older than COMPACT_GRACE_MS.
   * Sub-second in steady state; minutes when thousands of versions have
   * piled up. Returns null when there is no table yet.
   */
  async compact(): Promise<CompactStats | null> {
    if (!this.table) return null;
    const hadFts = await this.hasFtsIndex();
    const stats = await this.table.optimize({
      cleanupOlderThan: new Date(Date.now() - COMPACT_GRACE_MS),
    });
    // Compaction rewrites row addresses but LanceDB 0.13 does not remap the
    // inverted index, so full-text hits come back pointing at the wrong rows
    // afterwards (verified on 0.13: `needle` returned 1 of 21 rows, the wrong
    // one). Rebuilding here keeps that invariant inside the store.
    if (hadFts) await this.ensureFtsIndex(true);
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

  // ---------------------------------------------------------------------------
  // Full-text search (BM25 inverted index on `text`)
  // ---------------------------------------------------------------------------

  /** Name LanceDB assigns to the inverted index on the `text` column. */
  static readonly FTS_INDEX_NAME = "text_idx";

  /** True when the table carries a full-text index (any state, possibly stale). */
  async hasFtsIndex(): Promise<boolean> {
    if (!this.table) return false;
    const indices = await this.table.listIndices();
    return indices.some((i) => i.indexType === "FTS" && i.columns.includes("text"));
  }

  /**
   * Build (or rebuild) the full-text index on `text`.
   *
   * Behaviour verified on LanceDB 0.13: rows added after the index was built
   * are still found (the unindexed tail is scanned), but rows deleted since
   * the build leave stale postings behind — a query for a term whose only
   * posting was deleted panics inside Lance and the query rejects. Every
   * reindex deletes a file's old chunks before re-adding them, so the index
   * must be rebuilt after any run that wrote or pruned rows. Rebuilding also
   * keeps `optimize()` working: with unindexed rows carrying new tokens it
   * throws `token ... not found`.
   *
   * @param rebuild - when false, only create the index if none exists yet
   *   (first run after upgrading an existing index); when true, always
   *   replace it.
   * @returns true when an index was (re)built.
   */
  async ensureFtsIndex(rebuild: boolean): Promise<boolean> {
    if (!this.table) return false;
    if (!rebuild && (await this.hasFtsIndex())) return false;
    const lancedb = await import("@lancedb/lancedb");
    // Positions only serve phrase queries, which the searcher never issues;
    // dropping them makes the index smaller and faster to rebuild on save.
    await this.table.createIndex("text", {
      config: lancedb.Index.fts({ withPosition: false }),
      replace: true,
    });
    return true;
  }

  /**
   * Full-text (BM25) query over chunk text, best match first.
   *
   * Terms are matched literally after lowercasing; punctuation splits tokens
   * (`dot:workstream` matches `dot` and `workstream`), there is no stemming
   * and no stopword removal. An empty query yields no rows. Rejects when the
   * table has no full-text index yet or the index is stale after deletes —
   * callers fall back to vector-only ranking.
   */
  async fullTextQuery(query: string, n: number): Promise<FtsQueryResult[]> {
    if (!query.trim() || n <= 0) return [];

    return this.withFreshTable(async () => {
      const table = this.table;
      if (!table) return [];

      // No column projection: every stored column is needed here anyway, and a
      // table written before the `docid` column existed makes an explicit
      // select() fail with "Column docid does not exist".
      const rows = await table
        .query()
        .fullTextSearch(query, { columns: "text" })
        .limit(n)
        .toArray();

      return rows.map((row) => {
        const r = row as {
          file: string;
          heading: string;
          lineStart: number;
          text: string;
          docid?: string;
          vector?: ArrayLike<number>;
          _score?: number;
        };
        return {
          file: r.file,
          heading: r.heading,
          lineStart: r.lineStart,
          text: r.text,
          docid: r.docid ?? "",
          vector: r.vector ? Array.from(r.vector) : [],
          _score: r._score ?? 0,
        };
      });
    }, []);
  }
}
