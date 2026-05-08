/**
 * Hybrid search: vector similarity + keyword re-ranking.
 * Ported from scripts/mcp/indexer.py — _tokenize_query, _keyword_boost, search.
 */

import type { EmbedProvider, SearchResult } from "./types.js";
import type { LanceVectorStore } from "./vectorstore.js";

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

/**
 * Score bonus based on exact keyword matches in the document text.
 * Returns 0.03 per distinct query term found (case-insensitive).
 * This keeps vector similarity dominant while boosting exact-match results.
 */
export function keywordBoost(query: string, docText: string): number {
  const queryTerms = tokenizeQuery(query);
  if (queryTerms.size === 0) return 0;

  const docLower = docText.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    if (docLower.includes(term)) {
      hits++;
    }
  }
  return hits * 0.03;
}

export interface SearchOptions {
  /** Include detailed score breakdown in results (default: false) */
  explain?: boolean;
}

/**
 * Hybrid search: embed query, over-fetch 3x from vector store,
 * apply keyword boost, re-sort, return top n.
 */
export async function search(
  query: string,
  n: number,
  store: LanceVectorStore,
  embedder: EmbedProvider,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  if (n <= 0) return [];

  const totalCount = await store.count();
  if (totalCount === 0) return [];

  const explain = options?.explain ?? false;

  // Embed query with search_query prefix (for providers that use task prefixes)
  const [queryVector] = await embedder.embed([query], "search_query: ");

  // Over-fetch 3x candidates for keyword re-ranking, cap at 300 for performance
  const fetchN = Math.min(n * 3, 300, totalCount);
  const candidates = await store.query(queryVector, fetchN);

  // Extract query terms for explanation
  const queryTerms = explain ? tokenizeQuery(query) : new Set<string>();

  // Apply keyword boost and compute final scores
  const scored: SearchResult[] = candidates.map((c) => {
    const vectorScore = 1 - c._distance;
    const boost = keywordBoost(query, c.text);
    const finalScore = Math.round((vectorScore + boost) * 1000) / 1000;

    const result: SearchResult = {
      file: c.file,
      heading: c.heading,
      excerpt: c.text.slice(0, 600),
      score: finalScore,
      lineStart: c.lineStart,
    };

    // Add explanation if requested
    if (explain) {
      const docLower = c.text.toLowerCase();
      const keywordTermsMatched: string[] = [];
      for (const term of queryTerms) {
        if (docLower.includes(term)) {
          keywordTermsMatched.push(term);
        }
      }

      result.explanation = {
        vectorScore: Math.round(vectorScore * 1000) / 1000,
        keywordTermsMatched,
        keywordBonus: boost,
        finalScore,
        rank: 0, // Will be set after sorting
      };
    }

    return result;
  });

  // Re-sort by boosted score (descending) and return top n
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, n);

  // Update rank after sorting if explain was requested
  if (explain) {
    results.forEach((result, index) => {
      if (result.explanation) {
        result.explanation.rank = index + 1;
      }
    });
  }

  return results;
}
