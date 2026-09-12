/**
 * Hybrid search: vector similarity + full-text (BM25) candidates, fused with
 * reciprocal rank fusion (RRF).
 *
 * Each query contributes two ranked candidate lists — the top vector
 * neighbours and the top full-text matches — and every list feeds the same
 * RRF sum, so a chunk the embedding misses but the literal terms hit is still
 * recovered, and a chunk both sides agree on rises to the top.
 */

import type { EmbedProvider, SearchResult } from "./types.js";
import type { FtsQueryResult, LanceVectorStore, VectorQueryResult } from "./vectorstore.js";
import type { Indexer } from "./indexer.js";

/** RRF smoothing constant; 60 is the value from the original Cormack et al. paper. */
export const RRF_K = 60;

/** Upper bound on distinct queries fused in one call (the primary query included). */
export const MAX_QUERIES = 5;

/** Hard cap on vector candidates fetched per query. */
const MAX_VECTOR_FETCH = 300;

/**
 * Extract search terms from a query, splitting on word boundaries and
 * camelCase/PascalCase.
 *
 * Example: "PostGeoIndex" -> {"post", "geo", "index", "postgeoindex"}
 */
export function tokenizeQuery(query: string): Set<string> {
  const rawTokens = query.split(/\W+/);
  const terms = new Set<string>();

  for (const token of rawTokens) {
    if (!token) continue;

    // Split camelCase/PascalCase: "PostGeoIndex" -> ["Post", "Geo", "Index"]
    const parts = token.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length >= 3) {
        terms.add(lower);
      }
    }

    // Also keep the full token for compound word matching
    if (token.length >= 3) {
      terms.add(token.toLowerCase());
    }
  }

  return terms;
}

/** Cosine similarity of two vectors; 0 when either has zero magnitude. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Clamp a similarity into [0, 1] and round to 3 decimals. */
function normalizeScore(similarity: number): number {
  const clamped = Math.max(0, Math.min(1, similarity));
  return Math.round(clamped * 1000) / 1000;
}

/** One ranked candidate list feeding the fusion. */
export interface RankedList<T> {
  side: "vector" | "fts";
  items: T[];
}

/** A candidate after fusion, with the best rank it reached on each side. */
export interface FusedCandidate<T> {
  item: T;
  rrfScore: number;
  vectorRank: number | null;
  ftsRank: number | null;
}

/**
 * Reciprocal rank fusion: every list contributes 1 / (k + rank) for each of
 * its items; the sum orders the result. Pure — exported for tests.
 *
 * @param lists - ranked lists, best first
 * @param keyOf - identity of an item across lists (same chunk => same key)
 * @param k - smoothing constant (RRF_K)
 */
export function rrfFuse<T>(
  lists: Array<RankedList<T>>,
  keyOf: (item: T) => string,
  k = RRF_K,
): Array<FusedCandidate<T>> {
  const fused = new Map<string, FusedCandidate<T>>();

  for (const list of lists) {
    list.items.forEach((item, index) => {
      const rank = index + 1;
      const key = keyOf(item);
      let entry = fused.get(key);
      if (!entry) {
        entry = { item, rrfScore: 0, vectorRank: null, ftsRank: null };
        fused.set(key, entry);
      }
      entry.rrfScore += 1 / (k + rank);
      if (list.side === "vector") {
        entry.vectorRank = entry.vectorRank === null ? rank : Math.min(entry.vectorRank, rank);
      } else {
        entry.ftsRank = entry.ftsRank === null ? rank : Math.min(entry.ftsRank, rank);
      }
    });
  }

  return Array.from(fused.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

export interface SearchOptions {
  /** Include detailed score breakdown in results (default: false) */
  explain?: boolean;
  /**
   * Additional phrasings fused into the same ranking (at most MAX_QUERIES
   * distinct queries in total, the primary `query` included; extras beyond
   * that are ignored). Empty strings and duplicates are dropped.
   */
  queries?: string[];
}

/** Common shape of a candidate from either side. */
interface Candidate {
  file: string;
  heading: string;
  lineStart: number;
  text: string;
  docid: string;
  /** Best cosine similarity to any of the queries. */
  similarity: number;
}

/** Chunk identity across the two sides (chunk ids are derived from file:lineStart). */
function candidateKey(c: { file: string; lineStart: number }): string {
  return `${c.lineStart}:${c.file}`;
}

/** Deduplicate and cap the query list; the primary query always comes first. */
export function normalizeQueries(query: string, extra?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [query, ...(extra ?? [])]) {
    const q = typeof raw === "string" ? raw.trim() : "";
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= MAX_QUERIES) break;
  }
  return out;
}

/**
 * Hybrid search: embed every query, run the vector top-(3n, cap 300) and the
 * full-text top-(3n) in parallel per query, fuse all lists with RRF and
 * return the top n.
 *
 * `score` on each result is the chunk's cosine similarity to the query (best
 * across queries) in [0, 1]; the *order* is the RRF order. When the store has
 * no full-text index yet (or it is stale mid-reindex) the full-text side is
 * skipped and the ranking degrades to vector-only.
 *
 * @param indexer - Optional Indexer instance; when provided, prepends
 *   `[Context: <text>] ` to excerpts when a path-context entry matches.
 */
export async function search(
  query: string,
  n: number,
  store: LanceVectorStore,
  embedder: EmbedProvider,
  options?: SearchOptions,
  indexer?: Indexer,
): Promise<SearchResult[]> {
  if (n <= 0) return [];

  const queries = normalizeQueries(query, options?.queries);
  if (queries.length === 0) return [];

  const totalCount = await store.count();
  if (totalCount === 0) return [];

  const explain = options?.explain ?? false;

  // Embed all queries in one batch (search_query prefix for providers that use task prefixes)
  const queryVectors = await embedder.embed(queries, "search_query: ");

  // Over-fetch on both sides so fusion has room to reorder; vector fetch is
  // capped for performance, the full-text side is cheap.
  const vectorFetch = Math.min(n * 3, MAX_VECTOR_FETCH, totalCount);
  const ftsFetch = n * 3;

  const vectorLists = queries.map((_, i) => store.query(queryVectors[i], vectorFetch));
  const ftsLists = queries.map((q) =>
    store.fullTextQuery(q, ftsFetch).catch((err: unknown) => {
      // No index yet (pre-0.8 index, or nothing reindexed since upgrading) or
      // a stale index mid-reindex: degrade to vector-only rather than fail.
      console.warn(
        `search: full-text side unavailable, using vector ranking only: ${
          err instanceof Error ? err.message.split("\n")[0] : String(err)
        }`,
      );
      return [] as FtsQueryResult[];
    }),
  );
  const [vectorResults, ftsResults] = await Promise.all([
    Promise.all(vectorLists),
    Promise.all(ftsLists),
  ]);

  // Build one candidate record per chunk, remembering the best similarity.
  const candidates = new Map<string, Candidate>();
  const remember = (c: Omit<Candidate, "similarity">, similarity: number): void => {
    const key = candidateKey(c);
    const existing = candidates.get(key);
    if (existing) {
      if (similarity > existing.similarity) existing.similarity = similarity;
      return;
    }
    candidates.set(key, { ...c, similarity });
  };

  const lists: Array<RankedList<{ file: string; lineStart: number }>> = [];
  vectorResults.forEach((rows: VectorQueryResult[]) => {
    rows.forEach((r) => remember(r, 1 - r._distance));
    lists.push({ side: "vector", items: rows });
  });
  ftsResults.forEach((rows: FtsQueryResult[], i) => {
    rows.forEach((r) => remember(r, cosineSimilarity(queryVectors[i], r.vector)));
    lists.push({ side: "fts", items: rows });
  });

  const fused = rrfFuse(lists, candidateKey);
  // Deterministic tie-break on similarity, then key, so equal RRF sums do not
  // reorder between runs.
  fused.sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    const sa = candidates.get(candidateKey(a.item))?.similarity ?? 0;
    const sb = candidates.get(candidateKey(b.item))?.similarity ?? 0;
    if (sb !== sa) return sb - sa;
    return candidateKey(a.item).localeCompare(candidateKey(b.item));
  });

  const queryTerms = explain ? tokenizeQuery(queries.join(" ")) : new Set<string>();

  return fused.slice(0, n).map((f, index) => {
    const c = candidates.get(candidateKey(f.item))!;
    const score = normalizeScore(c.similarity);

    const rawExcerpt = c.text.slice(0, 600);
    const contextText = indexer ? indexer.getContextFor(c.file) : "";
    const excerpt = contextText ? `[Context: ${contextText}] ${rawExcerpt}` : rawExcerpt;

    const result: SearchResult = {
      file: c.file,
      heading: c.heading,
      excerpt,
      score,
      lineStart: c.lineStart,
      docid: c.docid ?? "",
    };

    if (explain) {
      const docLower = c.text.toLowerCase();
      const keywordTermsMatched: string[] = [];
      for (const term of queryTerms) {
        if (docLower.includes(term)) keywordTermsMatched.push(term);
      }
      result.explanation = {
        vectorScore: score,
        vectorRank: f.vectorRank,
        ftsRank: f.ftsRank,
        rrfScore: Math.round(f.rrfScore * 1e6) / 1e6,
        keywordTermsMatched,
        finalScore: score,
        rank: index + 1,
      };
    }

    return result;
  });
}
