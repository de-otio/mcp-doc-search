import { describe, it, expect, vi } from "vitest";
import { tokenizeQuery, keywordBoost, search } from "../../src/core/searcher.js";
import type { EmbedProvider } from "../../src/core/types.js";
import type { LanceVectorStore, VectorQueryResult } from "../../src/core/vectorstore.js";
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
    // "PostGeoIndex" → parts "post","geo","index" + full "postgeoindex"
    const result = tokenizeQuery("PostGeoIndex");

    expect(result.has("post")).toBe(true);
    expect(result.has("geo")).toBe(true);
    expect(result.has("index")).toBe(true);
    expect(result.has("postgeoindex")).toBe(true);
  });

  it("splits PascalCase into parts and keeps the full token", () => {
    // "MapView" → parts "map","view" + full "mapview"
    const result = tokenizeQuery("MapView");

    expect(result.has("map")).toBe(true);
    expect(result.has("view")).toBe(true);
    expect(result.has("mapview")).toBe(true);
  });

  it("filters out short words with fewer than 3 characters", () => {
    // "a", "of", "in", "the" are all < 3 chars; only "map" passes
    const result = tokenizeQuery("a of in the map");

    expect(result.has("map")).toBe(true);
    expect(result.has("a")).toBe(false);
    expect(result.has("of")).toBe(false);
    expect(result.has("in")).toBe(false);
    // "the" is exactly 3 chars — should be included
    expect(result.has("the")).toBe(true);
    // Verify size to ensure no unexpected tokens sneak through
    expect(result.size).toBe(2); // "map" + "the"
  });

  it("returns an empty set for an empty query string", () => {
    const result = tokenizeQuery("");
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// keywordBoost
// ---------------------------------------------------------------------------

describe("keywordBoost", () => {
  it("returns 0.06 when all query terms are present in the document", () => {
    const doc = "The map view renders the post geo index on screen.";
    const boost = keywordBoost("map view", doc);

    expect(boost).toBe(0.06);
  });

  it("returns 0.03 when only one of three query terms is present", () => {
    const doc = "The map renders everything on a canvas.";
    const boost = keywordBoost("map view feed", doc);

    expect(boost).toBe(0.03);
  });

  it("returns 0.0 when no query terms appear in the document", () => {
    const doc = "Completely unrelated content about databases and schemas.";
    const boost = keywordBoost("xyz abc", doc);

    expect(boost).toBe(0.0);
  });

  it("returns 0.0 for an empty query string", () => {
    const doc = "Some document text that has lots of words in it.";
    const boost = keywordBoost("", doc);

    expect(boost).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// search (hybrid search function)
// ---------------------------------------------------------------------------

/** Create a mock EmbedProvider that returns a fixed vector. */
function mockEmbedder(vector: number[]): EmbedProvider {
  return {
    embed: vi.fn(async () => [vector]),
  };
}

/** Create a mock LanceVectorStore with configurable count and query results. */
function mockStore(totalCount: number, queryResults: VectorQueryResult[]): LanceVectorStore {
  return {
    count: vi.fn(async () => totalCount),
    query: vi.fn(async () => queryResults),
  } as unknown as LanceVectorStore;
}

describe("search", () => {
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
  });

  it("returns results with scores computed from vector distance + keyword boost", async () => {
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/guide.md",
        heading: "Map View",
        lineStart: 10,
        text: "The map view component renders feeds on a map.",
        _distance: 0.2,
      },
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 5, store, embedder);

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.86);
    expect(results[0].file).toBe("doc/guide.md");
    expect(results[0].heading).toBe("Map View");
    expect(results[0].lineStart).toBe(10);
  });

  it("re-ranks results so keyword-boosted items can jump ahead", async () => {
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/general.md",
        heading: "Introduction",
        lineStart: 0,
        text: "A general introduction to the system architecture and design.",
        _distance: 0.15,
      },
      {
        file: "doc/mapview.md",
        heading: "MapView Component",
        lineStart: 5,
        text: "The MapView component shows feed items on a map view.",
        _distance: 0.2,
      },
    ];
    const store = mockStore(2, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 2, store, embedder);

    expect(results[0].file).toBe("doc/mapview.md");
    expect(results[1].file).toBe("doc/general.md");
  });

  it("truncates excerpt to 600 chars", async () => {
    const longText = "x".repeat(1000);
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/long.md",
        heading: "Long Section",
        lineStart: 0,
        text: longText,
        _distance: 0.1,
      },
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("test", 1, store, embedder);
    expect(results[0].excerpt.length).toBe(600);
  });

  it("limits results to n even when more candidates exist", async () => {
    const candidates: VectorQueryResult[] = Array.from({ length: 9 }, (_, i) => ({
      file: `doc/file${i}.md`,
      heading: `Section ${i}`,
      lineStart: i * 10,
      text: `Content for section ${i}`,
      _distance: 0.1 + i * 0.05,
    }));
    const store = mockStore(9, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("content", 3, store, embedder);
    expect(results).toHaveLength(3);
  });

  it("passes search_query prefix to the embedder", async () => {
    const store = mockStore(1, [
      {
        file: "doc/test.md",
        heading: "Test",
        lineStart: 0,
        text: "test content",
        _distance: 0.1,
      },
    ]);
    const embedder = mockEmbedder([0.1]);

    await search("test query", 5, store, embedder);

    expect(embedder.embed).toHaveBeenCalledWith(["test query"], "search_query: ");
  });

  // ---------------------------------------------------------------------------
  // search with explain option (Phase 8)
  // ---------------------------------------------------------------------------

  it("does not include explanation when explain: false (default)", async () => {
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/guide.md",
        heading: "Map View",
        lineStart: 10,
        text: "The map view component renders feeds on a map.",
        _distance: 0.2,
      },
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 5, store, embedder, { explain: false });

    expect(results).toHaveLength(1);
    expect(results[0].explanation).toBeUndefined();
  });

  it("includes explanation when explain: true", async () => {
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/guide.md",
        heading: "Map View",
        lineStart: 10,
        text: "The map view component renders feeds on a map.",
        _distance: 0.2,
      },
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 5, store, embedder, { explain: true });

    expect(results).toHaveLength(1);
    expect(results[0].explanation).toBeDefined();
    expect(results[0].explanation!.vectorScore).toBe(0.8);
    expect(results[0].explanation!.keywordBonus).toBe(0.06);
    expect(results[0].explanation!.finalScore).toBe(0.86);
    expect(results[0].explanation!.rank).toBe(1);
  });

  it("populates keywordTermsMatched with terms that appear in the text", async () => {
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/guide.md",
        heading: "Map View",
        lineStart: 10,
        text: "The map view component renders feeds on a map.",
        _distance: 0.2,
      },
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

  it("sets correct rank values after sorting", async () => {
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/a.md",
        heading: "First",
        lineStart: 0,
        text: "general intro architecture design",
        _distance: 0.15,
      },
      {
        file: "doc/b.md",
        heading: "Second",
        lineStart: 5,
        text: "map view component renders map view",
        _distance: 0.2,
      },
      {
        file: "doc/c.md",
        heading: "Third",
        lineStart: 15,
        text: "feed display list items",
        _distance: 0.25,
      },
    ];
    const store = mockStore(3, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view feed", 3, store, embedder, { explain: true });

    expect(results[0].file).toBe("doc/b.md");
    expect(results[0].explanation!.rank).toBe(1);

    expect(results[1].file).toBe("doc/a.md");
    expect(results[1].explanation!.rank).toBe(2);

    expect(results[2].file).toBe("doc/c.md");
    expect(results[2].explanation!.rank).toBe(3);
  });

  it("vectorScore + keywordBonus ≈ finalScore (within float precision)", async () => {
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/test.md",
        heading: "Test",
        lineStart: 0,
        text: "map view component map view rendering",
        _distance: 0.123,
      },
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("map view", 1, store, embedder, { explain: true });

    const exp = results[0].explanation!;
    const computed = Math.round((exp.vectorScore + exp.keywordBonus) * 1000) / 1000;
    expect(computed).toBe(exp.finalScore);
  });

  // ---------------------------------------------------------------------------
  // search with path-context indexer (Phase 4)
  // ---------------------------------------------------------------------------

  it("prepends [Context: ...] to excerpt when indexer has a matching context", async () => {
    const candidates: VectorQueryResult[] = [
      {
        file: "doc/01-business/spec.md",
        heading: "Overview",
        lineStart: 0,
        text: "Product specification content.",
        _distance: 0.1,
      },
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
      {
        file: "doc/no-context/page.md",
        heading: "Section",
        lineStart: 0,
        text: "Some content here.",
        _distance: 0.1,
      },
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
      {
        file: "doc/plain.md",
        heading: "Plain",
        lineStart: 0,
        text: "Plain content.",
        _distance: 0.1,
      },
    ];
    const store = mockStore(1, candidates);
    const embedder = mockEmbedder([0.1]);

    const results = await search("plain", 5, store, embedder);

    expect(results[0].excerpt).toBe("Plain content.");
  });
});
