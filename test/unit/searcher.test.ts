import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_QUERIES,
  RRF_K,
  cosineSimilarity,
  normalizeQueries,
  rrfFuse,
  search,
  tokenizeQuery,
} from "../../src/core/searcher.js";
import type { EmbedProvider } from "../../src/core/types.js";
import type {
  FtsQueryResult,
  LanceVectorStore,
  VectorQueryResult,
} from "../../src/core/vectorstore.js";
import type { Indexer } from "../../src/core/indexer.js";

// ---------------------------------------------------------------------------
// tokenizeQuery
// ---------------------------------------------------------------------------

describe("tokenizeQuery", () => {
  it("tokenizes simple whitespace-separated words", () => {
    const result = tokenizeQuery("map view feed");

    expect(result.has("map")).toBe(true);
    expect(result.has("view")).toBe(true);
    expect(result.has("feed")).toBe(true);
  });

  it("splits camelCase into parts and keeps the full token", () => {
    const result = tokenizeQuery("PostGeoIndex");

    expect(result.has("post")).toBe(true);
    expect(result.has("geo")).toBe(true);
    expect(result.has("index")).toBe(true);
    expect(result.has("postgeoindex")).toBe(true);
  });

  it("splits PascalCase into parts and keeps the full token", () => {
    const result = tokenizeQuery("MapView");

    expect(result.has("map")).toBe(true);
    expect(result.has("view")).toBe(true);
    expect(result.has("mapview")).toBe(true);
  });

  it("filters out short words with fewer than 3 characters", () => {
    const result = tokenizeQuery("a of in the map");

    expect(result.has("map")).toBe(true);
    expect(result.has("a")).toBe(false);
    expect(result.has("of")).toBe(false);
    expect(result.has("in")).toBe(false);
    expect(result.has("the")).toBe(true);
    expect(result.size).toBe(2);
  });

  it("returns an empty set for an empty query string", () => {
    const result = tokenizeQuery("");
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("is 1 for parallel, 0 for orthogonal and -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("is 0 when either vector is empty or all zeros", () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rrfFuse (pure)
// ---------------------------------------------------------------------------

describe("rrfFuse", () => {
  const key = (s: string) => s;

  it("sums 1/(k + rank) across lists and orders by the sum", () => {
    const fused = rrfFuse(
      [
        { side: "vector", items: ["a", "b", "c"] },
        { side: "fts", items: ["c", "a"] },
      ],
      key,
    );

    // a: 1/(k+1) + 1/(k+2); c: 1/(k+3) + 1/(k+1); b: 1/(k+2)
    expect(fused.map((f) => f.item)).toEqual(["a", "c", "b"]);
    expect(fused[0].rrfScore).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 10);
    expect(fused[2].rrfScore).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it("records the best rank per side and null for a side that never saw the item", () => {
    const fused = rrfFuse(
      [
        { side: "vector", items: ["a", "b"] },
        { side: "vector", items: ["b", "a"] },
        { side: "fts", items: ["b"] },
      ],
      key,
    );

    const a = fused.find((f) => f.item === "a")!;
    const b = fused.find((f) => f.item === "b")!;
    expect(a.vectorRank).toBe(1);
    expect(a.ftsRank).toBeNull();
    expect(b.vectorRank).toBe(1);
    expect(b.ftsRank).toBe(1);
  });

  it("an item present in two lists outranks an item that is first in only one", () => {
    const fused = rrfFuse(
      [
        { side: "vector", items: ["solo", "both"] },
        { side: "fts", items: ["other", "both"] },
      ],
      key,
    );

    expect(fused[0].item).toBe("both");
  });

  it("returns an empty array for no lists", () => {
    expect(rrfFuse([], key)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeQueries
// ---------------------------------------------------------------------------

describe("normalizeQueries", () => {
  it("keeps the primary query first and drops blanks and duplicates", () => {
    expect(normalizeQueries("  alpha ", ["beta", "", "alpha", "   ", "beta", "gamma"])).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("caps the total at MAX_QUERIES", () => {
    const extra = Array.from({ length: 10 }, (_, i) => `q${i}`);
    const out = normalizeQueries("primary", extra);
    expect(out).toHaveLength(MAX_QUERIES);
    expect(out[0]).toBe("primary");
  });

  it("returns an empty list when nothing is left", () => {
    expect(normalizeQueries("   ", [""])).toEqual([]);
  });

  it("ignores non-string entries", () => {
    expect(normalizeQueries("a", [42 as unknown as string, null as unknown as string])).toEqual([
      "a",
    ]);
  });
});

// ---------------------------------------------------------------------------
// search (hybrid search function)
// ---------------------------------------------------------------------------

function mockEmbedder(vector: number[]): EmbedProvider {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => vector)),
  };
}

interface StoreMock extends LanceVectorStore {
  count: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  fullTextQuery: ReturnType<typeof vi.fn>;
}

function mockStore(
  totalCount: number,
  queryResults: VectorQueryResult[],
  ftsResults: FtsQueryResult[] | Error = [],
): StoreMock {
  return {
    count: vi.fn(async () => totalCount),
    query: vi.fn(async () => queryResults),
    fullTextQuery: vi.fn(async () => {
      if (ftsResults instanceof Error) throw ftsResults;
      return ftsResults;
    }),
  } as unknown as StoreMock;
}

/** Build a VectorQueryResult with optional docid. */
function makeCandidate(
  overrides: Partial<VectorQueryResult> & Pick<VectorQueryResult, "file" | "heading">,
): VectorQueryResult {
  return {
    lineStart: 0,
    text: "default text",
    _distance: 0.2,
    docid: "",
    ...overrides,
  };
}

/** Build an FtsQueryResult; the stored vector defaults to the unit x-axis. */
function makeFtsHit(
  overrides: Partial<FtsQueryResult> & Pick<FtsQueryResult, "file" | "heading">,
): FtsQueryResult {
  return {
    lineStart: 0,
    text: "default text",
    docid: "",
    vector: [1, 0],
    _score: 1,
    ...overrides,
  };
}

describe("search", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns empty array when n <= 0", async () => {
    const store = mockStore(10, []);
    const embedder = mockEmbedder([0.1, 0.2]);
    const results = await search("test", 0, store, embedder);
    expect(results).toEqual([]);
  });

  it("returns empty array when store is empty", async () => {
    const store = mockStore(0, []);
    const embedder = mockEmbedder([0.1, 0.2]);
    const results = await search("test", 5, store, embedder);
    expect(results).toEqual([]);
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it("returns empty array for a blank query without hitting the store", async () => {
    const store = mockStore(10, []);
    const embedder = mockEmbedder([0.1, 0.2]);
    const results = await search("   ", 5, store, embedder);
    expect(results).toEqual([]);
    expect(store.count).not.toHaveBeenCalled();
  });

  it("reports cosine similarity (1 - distance) as score, without any keyword bonus", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({
        file: "doc/guide.md",
        heading: "Map View",
        lineStart: 10,
        text: "The map view component renders feeds on a map.",
        _distance: 0.2,
      }),
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 5, store, embedder);

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.8);
    expect(results[0].file).toBe("doc/guide.md");
    expect(results[0].heading).toBe("Map View");
    expect(results[0].lineStart).toBe(10);
  });

  it("keeps the vector order when the full-text side returns nothing", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({ file: "doc/general.md", heading: "Introduction", _distance: 0.15 }),
      makeCandidate({ file: "doc/mapview.md", heading: "MapView", lineStart: 5, _distance: 0.2 }),
    ];
    const store = mockStore(2, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 2, store, embedder);

    expect(results.map((r) => r.file)).toEqual(["doc/general.md", "doc/mapview.md"]);
  });

  it("recovers a chunk the vector query missed through the full-text side", async () => {
    const vectorHits: VectorQueryResult[] = [
      makeCandidate({ file: "doc/a.md", heading: "A", text: "a", _distance: 0.1 }),
      makeCandidate({ file: "doc/b.md", heading: "B", text: "b", _distance: 0.2 }),
    ];
    const ftsHits: FtsQueryResult[] = [
      makeFtsHit({
        file: "doc/literal.md",
        heading: "Literal",
        text: "ClusterIssuer",
        vector: [0, 1],
      }),
    ];
    const store = mockStore(3, vectorHits, ftsHits);
    const embedder = mockEmbedder([1, 0]);

    const results = await search("ClusterIssuer", 3, store, embedder, { explain: true });

    const literal = results.find((r) => r.file === "doc/literal.md");
    expect(literal).toBeDefined();
    // Orthogonal to the query: cosine 0, but still ranked because FTS found it.
    expect(literal!.score).toBe(0);
    expect(literal!.explanation!.ftsRank).toBe(1);
    expect(literal!.explanation!.vectorRank).toBeNull();
  });

  it("ranks a chunk found by both sides above one found by a single side", async () => {
    const vectorHits: VectorQueryResult[] = [
      makeCandidate({ file: "doc/vector-only.md", heading: "V", _distance: 0.05 }),
      makeCandidate({ file: "doc/both.md", heading: "Both", lineStart: 7, _distance: 0.3 }),
    ];
    // The stored vector of the shared chunk has cosine 0.7 to the query [1, 0],
    // matching the 0.3 distance the vector side reports for it.
    const ftsHits: FtsQueryResult[] = [
      makeFtsHit({ file: "doc/fts-only.md", heading: "F", _score: 9 }),
      makeFtsHit({
        file: "doc/both.md",
        heading: "Both",
        lineStart: 7,
        _score: 8,
        vector: [0.7, Math.sqrt(1 - 0.49)],
      }),
    ];
    const store = mockStore(3, vectorHits, ftsHits);
    const embedder = mockEmbedder([1, 0]);

    const results = await search("both", 3, store, embedder, { explain: true });

    expect(results[0].file).toBe("doc/both.md");
    // The winner does not have the highest cosine score — ordering is by RRF.
    expect(results[0].score).toBe(0.7);
    expect(results[0].explanation!.vectorRank).toBe(2);
    expect(results[0].explanation!.ftsRank).toBe(2);
    expect(results[0].explanation!.rrfScore).toBeCloseTo(2 / (RRF_K + 2), 6);
    expect(results[1].explanation!.rrfScore).toBeLessThan(results[0].explanation!.rrfScore);
  });

  it("identifies the same chunk across sides by file and lineStart", async () => {
    const vectorHits: VectorQueryResult[] = [
      makeCandidate({ file: "doc/x.md", heading: "X", lineStart: 3, _distance: 0.4 }),
    ];
    const ftsHits: FtsQueryResult[] = [
      makeFtsHit({ file: "doc/x.md", heading: "X", lineStart: 3 }),
      makeFtsHit({ file: "doc/x.md", heading: "X other section", lineStart: 40 }),
    ];
    const store = mockStore(2, vectorHits, ftsHits);
    const embedder = mockEmbedder([1, 0]);

    const results = await search("x", 5, store, embedder);

    expect(results).toHaveLength(2);
    expect(results[0].lineStart).toBe(3);
  });

  it("falls back to vector-only ranking and warns when the full-text query rejects", async () => {
    const vectorHits: VectorQueryResult[] = [
      makeCandidate({ file: "doc/a.md", heading: "A", _distance: 0.1 }),
    ];
    const store = mockStore(
      1,
      vectorHits,
      new Error("Cannot perform full text search unless an INVERTED index has been created"),
    );
    const embedder = mockEmbedder([1, 0]);

    const results = await search("a", 5, store, embedder, { explain: true });

    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("doc/a.md");
    expect(results[0].explanation!.ftsRank).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("full-text side unavailable");
  });

  it("clamps score into [0, 1] for anti-correlated vectors", async () => {
    const vectorHits: VectorQueryResult[] = [
      makeCandidate({ file: "doc/far.md", heading: "Far", _distance: 1.7 }),
    ];
    const ftsHits: FtsQueryResult[] = [
      makeFtsHit({ file: "doc/opposite.md", heading: "Opp", vector: [-1, 0] }),
    ];
    const store = mockStore(2, vectorHits, ftsHits);
    const embedder = mockEmbedder([1, 0]);

    const results = await search("far", 5, store, embedder);

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("over-fetches 3n on both sides, capping the vector side at 300 and the row count", async () => {
    const store = mockStore(1000, []);
    const embedder = mockEmbedder([0.1]);

    await search("q", 5, store, embedder);
    expect(store.query).toHaveBeenCalledWith([0.1], 15);
    expect(store.fullTextQuery).toHaveBeenCalledWith("q", 15);

    await search("q", 150, store, embedder);
    expect(store.query).toHaveBeenLastCalledWith([0.1], 300);
    expect(store.fullTextQuery).toHaveBeenLastCalledWith("q", 450);

    const small = mockStore(4, []);
    await search("q", 5, small, embedder);
    expect(small.query).toHaveBeenCalledWith([0.1], 4);
  });

  it("truncates excerpt to 600 chars", async () => {
    const longText = "x".repeat(1000);
    const candidates: VectorQueryResult[] = [
      makeCandidate({
        file: "doc/long.md",
        heading: "Long Section",
        text: longText,
        _distance: 0.1,
      }),
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("test", 1, store, embedder);
    expect(results[0].excerpt.length).toBe(600);
  });

  it("limits results to n even when more candidates exist", async () => {
    const candidates: VectorQueryResult[] = Array.from({ length: 9 }, (_, i) =>
      makeCandidate({
        file: `doc/file${i}.md`,
        heading: `Section ${i}`,
        lineStart: i * 10,
        text: `Content for section ${i}`,
        _distance: 0.1 + i * 0.05,
      }),
    );
    const store = mockStore(9, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("content", 3, store, embedder);
    expect(results).toHaveLength(3);
  });

  it("passes search_query prefix to the embedder", async () => {
    const store = mockStore(1, [
      makeCandidate({ file: "doc/test.md", heading: "Test", text: "test content", _distance: 0.1 }),
    ]);
    const embedder = mockEmbedder([0.1]);

    await search("test query", 5, store, embedder);

    expect(embedder.embed).toHaveBeenCalledWith(["test query"], "search_query: ");
  });

  // ---------------------------------------------------------------------------
  // multi-query
  // ---------------------------------------------------------------------------

  describe("queries option", () => {
    it("embeds all distinct queries in one batch and runs both sides per query", async () => {
      const store = mockStore(10, []);
      const embedder = mockEmbedder([0.1]);

      await search("alpha", 5, store, embedder, { queries: ["beta", "alpha", " ", "gamma"] });

      expect(embedder.embed).toHaveBeenCalledTimes(1);
      expect(embedder.embed).toHaveBeenCalledWith(["alpha", "beta", "gamma"], "search_query: ");
      expect(store.query).toHaveBeenCalledTimes(3);
      expect(store.fullTextQuery).toHaveBeenCalledTimes(3);
      expect(store.fullTextQuery).toHaveBeenCalledWith("beta", 15);
    });

    it("ignores extra queries beyond MAX_QUERIES", async () => {
      const store = mockStore(10, []);
      const embedder = mockEmbedder([0.1]);
      const extra = Array.from({ length: 12 }, (_, i) => `q${i}`);

      await search("primary", 5, store, embedder, { queries: extra });

      const embedded = (embedder.embed as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(embedded).toHaveLength(MAX_QUERIES);
      expect(embedded[0]).toBe("primary");
      expect(store.query).toHaveBeenCalledTimes(MAX_QUERIES);
    });

    it("lets a second phrasing recover a chunk the first one misses", async () => {
      const byQuery: Record<string, FtsQueryResult[]> = {
        "map view": [],
        Kartenansicht: [
          makeFtsHit({ file: "doc/de.md", heading: "Kartenansicht", text: "Kartenansicht" }),
        ],
      };
      const store = mockStore(5, [
        makeCandidate({ file: "doc/en.md", heading: "Map", _distance: 0.2 }),
      ]);
      store.fullTextQuery.mockImplementation(async (q: string) => byQuery[q] ?? []);
      const embedder = mockEmbedder([1, 0]);

      const results = await search("map view", 5, store, embedder, {
        queries: ["Kartenansicht"],
        explain: true,
      });

      const de = results.find((r) => r.file === "doc/de.md");
      expect(de).toBeDefined();
      expect(de!.explanation!.ftsRank).toBe(1);
      // Both lists of the English query and the FTS list of the German one fed the same fusion.
      expect(results.find((r) => r.file === "doc/en.md")!.explanation!.vectorRank).toBe(1);
    });

    it("reports the best similarity across queries as score", async () => {
      const embedder: EmbedProvider = {
        embed: vi.fn(async (texts: string[]) => texts.map((t) => (t === "near" ? [1, 0] : [0, 1]))),
      };
      const hit = makeCandidate({ file: "doc/x.md", heading: "X", _distance: 0.5 });
      const store = mockStore(1, [hit]);
      // Vector side reports distance 0.5 for both queries; FTS side carries the
      // stored vector, from which the "near" query yields cosine 1.
      store.fullTextQuery.mockResolvedValue([
        makeFtsHit({ file: "doc/x.md", heading: "X", vector: [1, 0] }),
      ]);

      const results = await search("far", 1, store, embedder, { queries: ["near"] });

      expect(results[0].score).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // search with explain option
  // ---------------------------------------------------------------------------

  it("does not include explanation when explain: false (default)", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({ file: "doc/guide.md", heading: "Map View", lineStart: 10, _distance: 0.2 }),
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 5, store, embedder, { explain: false });

    expect(results).toHaveLength(1);
    expect(results[0].explanation).toBeUndefined();
  });

  it("includes the full explanation when explain: true", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({
        file: "doc/guide.md",
        heading: "Map View",
        lineStart: 10,
        text: "The map view component renders feeds on a map.",
        _distance: 0.2,
      }),
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 5, store, embedder, { explain: true });

    expect(results).toHaveLength(1);
    const exp = results[0].explanation!;
    expect(exp.vectorScore).toBe(0.8);
    expect(exp.finalScore).toBe(0.8);
    expect(exp.vectorRank).toBe(1);
    expect(exp.ftsRank).toBeNull();
    expect(exp.rrfScore).toBeCloseTo(1 / (RRF_K + 1), 6);
    expect(exp.rank).toBe(1);
    expect(exp).not.toHaveProperty("keywordBonus");
  });

  it("populates keywordTermsMatched with terms that appear in the text", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({
        file: "doc/guide.md",
        heading: "Map View",
        lineStart: 10,
        text: "The map view component renders feeds on a map.",
        _distance: 0.2,
      }),
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view feed xyz", 5, store, embedder, { explain: true });

    expect(results[0].explanation).toBeDefined();
    const matched = results[0].explanation!.keywordTermsMatched;
    expect(matched).toContain("map");
    expect(matched).toContain("view");
    expect(matched).toContain("feed");
    expect(matched).not.toContain("xyz");
  });

  it("sets rank values in result order", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({ file: "doc/a.md", heading: "First", _distance: 0.15 }),
      makeCandidate({ file: "doc/b.md", heading: "Second", lineStart: 5, _distance: 0.2 }),
      makeCandidate({ file: "doc/c.md", heading: "Third", lineStart: 15, _distance: 0.25 }),
    ];
    const store = mockStore(3, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view feed", 3, store, embedder, { explain: true });

    expect(results.map((r) => r.file)).toEqual(["doc/a.md", "doc/b.md", "doc/c.md"]);
    expect(results.map((r) => r.explanation!.rank)).toEqual([1, 2, 3]);
  });

  // ---------------------------------------------------------------------------
  // search with path-context indexer
  // ---------------------------------------------------------------------------

  it("prepends [Context: ...] to excerpt when indexer has a matching context", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({
        file: "doc/01-business/spec.md",
        heading: "Overview",
        text: "Product specification content.",
        _distance: 0.1,
      }),
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);
    const mockIndexer = {
      getContextFor: vi.fn().mockReturnValue("Product roadmap and feature specs"),
    } as unknown as Indexer;

    const results = await search("product specs", 5, store, embedder, undefined, mockIndexer);

    expect(results[0].excerpt).toMatch(/^\[Context: Product roadmap and feature specs\] /);
    expect(mockIndexer.getContextFor).toHaveBeenCalledWith("doc/01-business/spec.md");
  });

  it("does not prepend context prefix when indexer returns empty string", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({
        file: "doc/no-context/page.md",
        heading: "Section",
        text: "Some content here.",
        _distance: 0.1,
      }),
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);
    const mockIndexer = {
      getContextFor: vi.fn().mockReturnValue(""),
    } as unknown as Indexer;

    const results = await search("some content", 5, store, embedder, undefined, mockIndexer);

    expect(results[0].excerpt).not.toMatch(/^\[Context:/);
    expect(results[0].excerpt).toBe("Some content here.");
  });

  it("does not modify excerpt format when no indexer is provided", async () => {
    const candidates: VectorQueryResult[] = [
      makeCandidate({
        file: "doc/plain.md",
        heading: "Plain",
        text: "Plain content.",
        _distance: 0.1,
      }),
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("plain", 5, store, embedder);

    expect(results[0].excerpt).toBe("Plain content.");
  });

  // ---------------------------------------------------------------------------
  // search returns docid
  // ---------------------------------------------------------------------------

  it("includes docid from either side in search results", async () => {
    const store = mockStore(
      2,
      [makeCandidate({ file: "doc/guide.md", heading: "Guide", _distance: 0.1, docid: "abc123" })],
      [makeFtsHit({ file: "doc/fts.md", heading: "F", docid: "def456" })],
    );
    const embedder = mockEmbedder([1, 0]);

    const results = await search("guide", 2, store, embedder);

    expect(results.find((r) => r.file === "doc/guide.md")!.docid).toBe("abc123");
    expect(results.find((r) => r.file === "doc/fts.md")!.docid).toBe("def456");
  });

  it("returns empty docid when store record has no docid", async () => {
    const store = mockStore(1, [
      makeCandidate({ file: "doc/old.md", heading: "Old", _distance: 0.2, docid: "" }),
    ]);
    const embedder = mockEmbedder([0.1]);

    const results = await search("old", 1, store, embedder);

    expect(results[0].docid).toBe("");
  });
});
