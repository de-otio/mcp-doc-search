/**
 * LanceDB vector store wrapper.
 * File-backed, embedded, no server process needed.
 */

import { mkdirSync } from "node:fs";
import type { LanceTable, LanceConnection } from "./types.js";

/**
 * Validate and escape a file path for use in LanceDB SQL queries.
 * Rejects paths with suspicious characters (outside [a-zA-Z0-9_./-])
 * and enforces a maximum length of 2048 characters.
 */
function safeLanceFilter(file: string): string {
  if (file.length > 2048) {
    throw new Error(`File path too long (max 2048 chars): ${file}`);
  }
  if (!/^[a-zA-Z0-9_.\/-]+$/.test(file)) {
    throw new Error(
      `File path contains suspicious characters: ${file}. Allowed: [a-zA-Z0-9_./-]`,
    );
  }
  // Escape single quotes for SQL
  return file.replace(/'/g, "''");
}

/** Record stored in LanceDB. */
export interface VectorRecord {
  id: string;
  vector: number[];
  file: string;
  heading: string;
  lineStart: number;
  text: string;
}

/** Result from a vector query (before keyword re-ranking). */
export interface VectorQueryResult {
  file: string;
  heading: string;
  lineStart: number;
  text: string;
  /** Distance from query vector (lower = more similar for cosine). */
  _distance: number;
}

export class LanceVectorStore {
  private db: LanceConnection | null = null;
  private table: LanceTable | undefined;
  private indexDir: string;
  private tableName: string;

  constructor(indexDir: string, tableName = "doc_chunks") {
    this.indexDir = indexDir;
    this.tableName = tableName;
  }

  async open(): Promise<void> {
    mkdirSync(this.indexDir, { recursive: true });
    const lancedb = await import("@lancedb/lancedb");
    this.db = await lancedb.connect(this.indexDir);

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
      const vectorField = schema.fields.find((f: any) => f.name === "vector");
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
      heading: "",
      lineStart: 0,
      text: "",
    };
    this.table = await this.db.createTable(this.tableName, [seedRecord], {
      mode: "overwrite",
    });
    await this.table.delete('id = "__seed__"');
  }

  async deleteByFile(file: string): Promise<void> {
    if (!this.table) return;
    try {
      const escaped = safeLanceFilter(file);
      await this.table.delete(`file = '${escaped}'`);
    } catch {
      // Table may be empty or file not yet indexed
    }
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (!this.table) {
      throw new Error("Table not initialized. Call ensureTable() first.");
    }
    if (records.length === 0) return;
    await this.table.add(records);
  }

  async query(
    queryVector: number[],
    n: number,
  ): Promise<VectorQueryResult[]> {
    if (!this.table) return [];

    const results = await this.table
      .search(queryVector)
      .distanceType("cosine")
      .limit(n)
      .toArray();

    return results.map((r: any) => ({
      file: r.file,
      heading: r.heading,
      lineStart: r.lineStart,
      text: r.text,
      _distance: r._distance ?? 0,
    }));
  }

  async listFiles(): Promise<Array<{ file: string; title: string }>> {
    if (!this.table) return [];

    const results = await this.table.query().toArray();
    const seen = new Map<string, string>();
    for (const r of results) {
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

  isOpen(): boolean {
    return this.db !== null;
  }

  hasTable(): boolean {
    return this.table !== null;
  }

  async close(): Promise<void> {
    this.table = undefined;
    this.db = undefined;
  }
}
