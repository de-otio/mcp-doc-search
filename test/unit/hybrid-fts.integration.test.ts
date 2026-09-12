/**
 * Real-LanceDB integration test for the full-text side of hybrid search.
 *
 * No mocks around the store: a temp-dir table, a deterministic fake embedder
 * that places the target chunk far away from every query vector, and the
 * assertions the unit tests cannot make — that the chunk is unreachable via
 * the vector query and comes back only once the full-text index exists, and
 * that the index survives the delete-before-add reindex pattern and
 * compaction (both verified to break a stale index on LanceDB 0.13).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LanceVectorStore, type VectorRecord } from "../../src/core/vectorstore.js";
import { Indexer } from "../../src/core/indexer.js";
import { search } from "../../src/core/searcher.js";
import type { EmbedProvider } from "../../src/core/types.js";

const DIM = 4;
const TARGET_TOKEN = "ClusterIssuer";

/**
 * Deterministic embedder: every query maps to the x-axis; documents that
 * contain TARGET_TOKEN map (almost) to the w-axis, every other document to a
 * slightly perturbed x-axis. So the target is the *last* vector neighbour of
 * any query, while the fillers crowd the top.
 */
function fakeEmbedder(): EmbedProvider {
  let fillerCount = 0;
  return {
    embed: vi.fn(async (texts: string[], prefix?: string) =>
      texts.map((t) => {
        if (prefix?.startsWith("search_query")) return [1, 0, 0, 0];
        if (t.includes(TARGET_TOKEN)) return [0.05, 0, 0, 1];
        fillerCount++;
        return [1, 0.01 * fillerCount, 0, 0];
      }),
    ),
  };
}

function record(id: string, file: string, text: string, vector: number[]): VectorRecord {
  return {
    id,
    vector,
    file,
    heading: id,
    lineStart: 0,
    text,
    docid: id.padEnd(6, "0").slice(0, 6),
  };
}

describe("hybrid search with a real LanceDB full-text index", () => {
  let dir: string;
  let store: LanceVectorStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hybrid-fts-"));
    store = new LanceVectorStore(path.join(dir, "index"));
    await store.open();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedCorpus(): Promise<EmbedProvider> {
    const embedder = fakeEmbedder();
    const fillers = Array.from({ length: 6 }, (_, i) => ({
      id: `filler${i}`,
      file: `doc/filler${i}.md`,
      text: `Ingress controller notes ${i}: certificates, renewal, and the load balancer.`,
    }));
    const target = {
      id: "target",
      file: "doc/cert-manager.md",
      text: `cert-manager reports ${TARGET_TOKEN} not found when the issuer is missing.`,
    };
    const all = [...fillers, target];
    const vectors = await embedder.embed(
      all.map((d) => d.text),
      "search_document: ",
    );
    await store.ensureTable(DIM);
    await store.upsert(all.map((d, i) => record(d.id, d.file, d.text, vectors[i])));
    return embedder;
  }

  it("recovers through the full-text side a chunk the vector query cannot reach", async () => {
    const embedder = await seedCorpus();
    const query = `${TARGET_TOKEN} not found`;

    // Without an FTS index the target is invisible: it is the 7th nearest of 7
    // and the vector side fetches 3n = 6. The FTS side rejects (no index) and
    // search degrades to vector-only with a warning.
    expect(await store.hasFtsIndex()).toBe(false);
    const before = await search(query, 2, store, embedder, { explain: true });
    expect(before.map((r) => r.file)).not.toContain("doc/cert-manager.md");
    expect(before.every((r) => r.explanation!.ftsRank === null)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0][0])).toContain("full-text side unavailable");

    expect(await store.ensureFtsIndex(false)).toBe(true);
    expect(await store.hasFtsIndex()).toBe(true);
    // Idempotent when an index exists and no rebuild is requested.
    expect(await store.ensureFtsIndex(false)).toBe(false);

    warnSpy.mockClear();
    const after = await search(query, 2, store, embedder, { explain: true });
    expect(warnSpy).not.toHaveBeenCalled();

    const hit = after.find((r) => r.file === "doc/cert-manager.md");
    expect(hit).toBeDefined();
    expect(hit!.explanation!.ftsRank).toBe(1);
    expect(hit!.explanation!.vectorRank).toBeNull();
    // Cosine of the far-away vector: small but a valid score in [0, 1].
    expect(hit!.score).toBeGreaterThanOrEqual(0);
    expect(hit!.score).toBeLessThan(0.2);
    for (const r of after) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("matches literally: case-insensitive, punctuation-split, no hit for absent terms", async () => {
    await seedCorpus();
    await store.ensureFtsIndex(false);

    const lower = await store.fullTextQuery(TARGET_TOKEN.toLowerCase(), 5);
    expect(lower.map((r) => r.file)).toEqual(["doc/cert-manager.md"]);
    expect(lower[0].vector).toHaveLength(DIM);
    expect(lower[0]._score).toBeGreaterThan(0);

    const hyphenated = await store.fullTextQuery("cert-manager", 5);
    expect(hyphenated.map((r) => r.file)).toEqual(["doc/cert-manager.md"]);

    expect(await store.fullTextQuery("nonexistenttoken", 5)).toEqual([]);
    expect(await store.fullTextQuery("   ", 5)).toEqual([]);
  });

  it("survives the delete-before-add reindex pattern once rebuilt", async () => {
    await seedCorpus();
    await store.ensureFtsIndex(false);

    // Replace the target file's chunk (what Indexer.reindex does per file).
    await store.deleteByFile("doc/cert-manager.md");
    await store.upsert([
      record(
        "target2",
        "doc/cert-manager.md",
        `revised: ${TARGET_TOKEN} is referenced but missing`,
        [0.05, 0, 0, 1],
      ),
    ]);

    // Stale postings: the only row holding "reports" is deleted. On 0.13 this
    // query panics inside Lance and rejects; either outcome is acceptable
    // before the rebuild, but it must never return the deleted row.
    const stale = await store.fullTextQuery("reports", 5).catch(() => "rejected" as const);
    if (stale !== "rejected") expect(stale).toEqual([]);

    await store.ensureFtsIndex(true);

    expect((await store.fullTextQuery("reports", 5)).map((r) => r.file)).toEqual([]);
    const revised = await store.fullTextQuery("revised", 5);
    expect(revised).toHaveLength(1);
    expect(revised[0].text).toContain("revised");
    expect((await store.fullTextQuery(TARGET_TOKEN, 5)).map((r) => r.text)).toEqual([
      revised[0].text,
    ]);
  });

  it("keeps full-text hits pointing at the right rows across compaction", async () => {
    await seedCorpus();
    await store.ensureFtsIndex(false);

    // A few write cycles so optimize() has fragments to merge.
    for (let i = 0; i < 4; i++) {
      await store.deleteByFile("doc/filler0.md");
      await store.upsert([
        record("filler0", "doc/filler0.md", `cycle ${i} ingress notes`, [1, 0.5, 0, 0]),
      ]);
      await store.ensureFtsIndex(true);
    }

    const stats = await store.compact();
    expect(stats).not.toBeNull();
    expect(stats!.fragmentsRemoved).toBeGreaterThan(0);

    // compact() rebuilds the index, so hits still resolve to the correct rows.
    const hits = await store.fullTextQuery(TARGET_TOKEN, 5);
    expect(hits.map((r) => r.file)).toEqual(["doc/cert-manager.md"]);
    const cycle = await store.fullTextQuery("cycle", 5);
    expect(cycle.map((r) => r.text)).toEqual(["cycle 3 ingress notes"]);
  });

  it("Indexer.reindex builds the index and rebuilds only after writes", async () => {
    const workspace = path.join(dir, "ws");
    mkdirSync(path.join(workspace, "doc"), { recursive: true });
    writeFileSync(path.join(workspace, "doc", "a.md"), "# Ingress\n\nCertificates and renewal.\n");
    writeFileSync(
      path.join(workspace, "doc", "b.md"),
      `# Issuers\n\ncert-manager reports ${TARGET_TOKEN} not found.\n`,
    );
    const embedder = fakeEmbedder();
    const indexer = new Indexer(
      {
        workspaceRoot: workspace,
        docGlob: "doc/**/*.md",
        indexDir: path.join(dir, "index"),
        maxChunkChars: 4000,
        headingDepth: 2,
        embedProvider: embedder,
        extraRoots: [],
      },
      store,
    );
    const ensureSpy = vi.spyOn(store, "ensureFtsIndex");

    const first = await indexer.reindex();
    expect(first.indexed).toBe(2);
    expect(ensureSpy).toHaveBeenLastCalledWith(true);
    expect(await store.hasFtsIndex()).toBe(true);

    const second = await indexer.reindex();
    expect(second.indexed).toBe(0);
    expect(ensureSpy).toHaveBeenLastCalledWith(false);

    const results = await search(TARGET_TOKEN, 5, store, embedder, { explain: true });
    const hit = results.find((r) => r.file === "doc/b.md");
    expect(hit).toBeDefined();
    expect(hit!.explanation!.ftsRank).toBe(1);
  });
});
