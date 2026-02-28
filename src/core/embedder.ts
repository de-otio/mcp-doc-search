/**
 * Embedding providers: Local (Transformers.js), Ollama, OpenAI.
 * All implement the EmbedProvider interface.
 */

import type { EmbedProvider, EmbedderPipeline } from "./types.js";

/**
 * Fetch with timeout and single retry on network errors.
 * Does not retry on 4xx/5xx HTTP errors.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // On network error, only retry if not a 4xx/5xx (those won't change on retry)
      if (attempt === 0) {
        // Wait briefly before retry on network timeout/error
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Fetch failed after retries");
}

/**
 * Local embeddings using @huggingface/transformers with all-MiniLM-L6-v2.
 * Zero config, no server needed. Model is ~22MB ONNX, downloaded on first use.
 *
 * Note: all-MiniLM-L6-v2 does NOT use task prefixes — the prefix param is ignored.
 */
export class LocalEmbedder implements EmbedProvider {
  private pipeline: EmbedderPipeline | null = null;
  private modelPath: string | undefined;

  constructor(options?: { modelPath?: string }) {
    this.modelPath = options?.modelPath;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.pipeline) {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (this.modelPath) {
        env.localModelPath = this.modelPath;
      }
      this.pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    }

    const results: number[][] = [];
    for (const text of texts) {
      const output = await this.pipeline(text, {
        pooling: "mean",
        normalize: true,
      });
      results.push(Array.from(output.data as Float32Array));
    }
    return results;
  }
}

/**
 * Ollama embeddings via local HTTP API.
 * Uses nomic-embed-text by default (768-dim). Requires `ollama serve` running.
 * Applies search_document:/search_query: task prefixes for optimal retrieval.
 */
export class OllamaEmbedder implements EmbedProvider {
  private model: string;
  private baseUrl: string;

  constructor(model = "nomic-embed-text", baseUrl = "http://localhost:11434") {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async embed(texts: string[], prefix = ""): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const prompt = prefix ? `${prefix}${text}` : text;
      const response = await fetchWithTimeout(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt }),
      });
      if (!response.ok) {
        const body = await response.text();
        if (response.status === 404 && body.includes("not found")) {
          throw new Error(
            `Ollama model "${this.model}" is required but has not been downloaded yet. ` +
              `Open a terminal and run: ollama pull ${this.model}\n` +
              `Once the download completes, try again.`,
          );
        }
        throw new Error(`Ollama embedding failed (${response.status}): ${body}`);
      }
      const data = (await response.json()) as { embedding: number[] };
      results.push(data.embedding);
    }
    return results;
  }
}

/**
 * OpenAI embeddings via API. Uses text-embedding-3-small by default (1536-dim).
 * Supports batch embedding in a single API call.
 * Applies task prefixes when provided.
 */
export class OpenAIEmbedder implements EmbedProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = "text-embedding-3-small") {
    if (!apiKey) throw new Error("OpenAI API key is required");
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(texts: string[], prefix = ""): Promise<number[][]> {
    const input = prefix ? texts.map((t) => `${prefix}${t}`) : texts;
    const response = await fetchWithTimeout("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI embedding failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data.map((r) => r.embedding);
  }
}

/**
 * Factory to create the appropriate embed provider from config.
 */
export function createEmbedProvider(config: {
  embedProvider: "local" | "ollama" | "openai";
  ollamaUrl?: string;
  ollamaModel?: string;
  openaiApiKey?: string;
  modelPath?: string;
}): EmbedProvider {
  switch (config.embedProvider) {
    case "ollama":
      return new OllamaEmbedder(config.ollamaModel, config.ollamaUrl);
    case "openai":
      return new OpenAIEmbedder(config.openaiApiKey ?? "");
    default:
      return new LocalEmbedder({ modelPath: config.modelPath });
  }
}
