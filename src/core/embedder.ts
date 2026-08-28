/**
 * Embedding providers: Local (Transformers.js), Ollama, OpenAI.
 * All implement the EmbedProvider interface.
 */

import { createRequire } from "node:module";
import type { EmbedFailureKind, EmbedProvider, EmbedderPipeline, HealthResult } from "./types.js";

// WHY require() (not dynamic import()):
//   The published VSIX ships only @huggingface/transformers/dist/transformers.node.cjs;
//   the .mjs is stripped in .vscodeignore to keep the bundle small. The package's
//   exports map routes `import()` to .mjs and `require()` to .cjs, so using
//   `await import(...)` resolves to the missing .mjs and crashes at runtime.
//   Wrapped in an indirection so tests can swap it out without fighting
//   vitest's module resolver.
const requireCjs = createRequire(__filename);
export function loadTransformers(): typeof import("@huggingface/transformers") {
  return requireCjs("@huggingface/transformers");
}

/**
 * An embedding failed in a way the caller can act on.
 *
 * `kind` carries the *lifetime* of the failure so the indexer can tell a
 * whole-run condition (dead daemon, missing model, bad key) from a per-file
 * one, instead of rediscovering it once per file.
 */
export class EmbedError extends Error {
  readonly kind: EmbedFailureKind;
  readonly hint?: string;
  /** The request was aborted by its own timeout rather than answered. */
  readonly timedOut: boolean;

  constructor(
    message: string,
    kind: EmbedFailureKind = "unknown",
    options: { hint?: string; timedOut?: boolean } = {},
  ) {
    super(message);
    this.name = "EmbedError";
    this.kind = kind;
    this.hint = options.hint;
    this.timedOut = options.timedOut ?? false;
  }
}

/** Kinds where every subsequent file would fail the same way — abort the run. */
const FATAL_EMBED_KINDS: ReadonlySet<EmbedFailureKind> = new Set<EmbedFailureKind>([
  "unreachable",
  "model-missing",
  "runner-load-failed",
  "auth",
]);

export function isFatalEmbedKind(kind: EmbedFailureKind): boolean {
  return FATAL_EMBED_KINDS.has(kind);
}

/**
 * Thrown when a run is abandoned because the embedding provider is unusable.
 *
 * Distinct from EmbedError: that describes one failed request, this describes
 * a run that stopped because continuing could not help. It is thrown rather
 * than reported in IndexStats so a dead embedder can never be mistaken for a
 * successful reindex by a caller that forgot to check a field.
 */
export class EmbedderUnavailableError extends Error {
  readonly kind: EmbedFailureKind;
  readonly hint?: string;
  /** Files successfully indexed before the run was abandoned. */
  readonly indexed: number;

  constructor(
    message: string,
    kind: EmbedFailureKind,
    options: { hint?: string; indexed?: number },
  ) {
    super(message);
    this.name = "EmbedderUnavailableError";
    this.kind = kind;
    this.hint = options.hint;
    this.indexed = options.indexed ?? 0;
  }
}

/** True when a fetch rejection is our own AbortController firing (i.e. a timeout). */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Node surfaces connection failures as `TypeError: fetch failed` with a `cause`. */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EAI_AGAIN",
]);

function isConnectionError(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  return typeof cause?.code === "string" && CONNECTION_ERROR_CODES.has(cause.code);
}

/**
 * Fetch with timeout and a single retry on *connection* errors.
 * Does not retry on 4xx/5xx HTTP errors.
 *
 * WHY timeouts are not retried: the retry exists for a connection that was
 * refused or reset in transit, which a 100ms backoff can genuinely fix. A
 * request that went unanswered for the full timeout will not answer after
 * 100ms — retrying it only doubles the stall, which is precisely what made a
 * broken local daemon look like a hang rather than a failure.
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
      if (isTimeoutError(err)) {
        // Left as "unknown" on purpose: what a timeout *means* is
        // provider-specific, so the caller reclassifies it.
        throw new EmbedError(`Request to ${url} timed out after ${timeoutMs}ms`, "unknown", {
          timedOut: true,
        });
      }
      if (attempt === 0) {
        // Wait briefly before retrying a transient connection error
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (isConnectionError(lastError)) {
    throw new EmbedError(`Cannot reach ${url}: ${lastError?.message}`, "unreachable");
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
  private loader: typeof loadTransformers;

  constructor(options?: { modelPath?: string; loader?: typeof loadTransformers }) {
    this.modelPath = options?.modelPath;
    this.loader = options?.loader ?? loadTransformers;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.pipeline) {
      const { pipeline, env } = this.loader();
      if (this.modelPath) {
        env.localModelPath = this.modelPath;
      }
      this.pipeline = (await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
      )) as unknown as EmbedderPipeline;
    }

    const pipe = this.pipeline;
    const results: number[][] = [];
    for (const text of texts) {
      const output = await pipe(text, {
        pooling: "mean",
        normalize: true,
      });
      results.push(Array.from(output.data as Float32Array));
    }
    return results;
  }

  /**
   * Loading the pipeline *is* the probe: the first call downloads the ONNX
   * model, and a failed download would otherwise fail every file in turn.
   */
  async healthCheck(): Promise<HealthResult> {
    try {
      await this.embed(["ok"]);
      return { ok: true, detail: "Built-in model (all-MiniLM-L6-v2)" };
    } catch (err) {
      return {
        ok: false,
        kind: "unknown",
        detail: err instanceof Error ? err.message : String(err),
        hint: "The built-in model is downloaded on first use — check network access.",
      };
    }
  }

  /**
   * Release the cached pipeline so the next embed() call will reload it.
   * Useful in long-lived HTTP daemon mode to free memory during idle periods.
   */
  dispose(): void {
    this.pipeline = null;
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
  private probeTimeoutMs: number;

  /** Max halvings when the model rejects a prompt for exceeding its context window. */
  private static readonly MAX_CONTEXT_HALVINGS = 3;

  /** `/api/version` needs no model loaded, so a healthy daemon answers immediately. */
  private static readonly VERSION_TIMEOUT_MS = 3_000;

  constructor(
    model = "nomic-embed-text",
    baseUrl = "http://127.0.0.1:11434",
    options: { probeTimeoutMs?: number } = {},
  ) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.probeTimeoutMs = options.probeTimeoutMs ?? 30_000;
  }

  async embed(texts: string[], prefix = ""): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embedOne(text, prefix));
    }
    return results;
  }

  /**
   * Distinguish "daemon down" from "daemon up but cannot load the model".
   *
   * WHY the two-step probe: `/api/version` is served without touching a model,
   * so it answers even when the runner is broken (e.g. a daemon left running
   * across an upgrade spawns a newer runner binary with flags it does not
   * accept — every load then fails while the HTTP request simply hangs). The
   * pair "version responds, embed times out" identifies that class of fault
   * over HTTP alone, with no CLI or shell access required.
   */
  async healthCheck(): Promise<HealthResult> {
    let version = "unknown";
    try {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/api/version`,
        { method: "GET" },
        OllamaEmbedder.VERSION_TIMEOUT_MS,
      );
      if (!response.ok) {
        return {
          ok: false,
          kind: "http-error",
          detail: `Ollama at ${this.baseUrl} returned ${response.status} for /api/version`,
          hint: "Check that the URL points at an Ollama server.",
        };
      }
      const data = (await response.json()) as { version?: string };
      if (data.version) version = data.version;
    } catch {
      return {
        ok: false,
        kind: "unreachable",
        detail: `No Ollama server responding at ${this.baseUrl}`,
        hint: "Start Ollama (`ollama serve`), or switch the provider to the built-in model.",
      };
    }

    try {
      await this.embedOne("ok", "", this.probeTimeoutMs);
      return { ok: true, detail: `Ollama ${version}, model "${this.model}"` };
    } catch (err) {
      if (err instanceof EmbedError && err.timedOut) {
        return {
          ok: false,
          kind: "runner-load-failed",
          detail:
            `Ollama ${version} is running but did not load "${this.model}" ` +
            `within ${Math.round(this.probeTimeoutMs / 1000)}s`,
          hint:
            "Restart Ollama — a daemon left running across an upgrade cannot start " +
            "its model runner. Check the Ollama server log if a restart does not help.",
        };
      }
      if (err instanceof EmbedError) {
        return { ok: false, kind: err.kind, detail: err.message, hint: err.hint };
      }
      return {
        ok: false,
        kind: "unknown",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Ollama's 500 body when the tokenized prompt exceeds the model's num_ctx. */
  private static isContextLengthError(body: string): boolean {
    return body.includes("exceeds the context length");
  }

  private async embedOne(text: string, prefix: string, timeoutMs?: number): Promise<number[]> {
    // The chunker budgets CHARACTERS but the model budgets TOKENS, so dense
    // content (config dumps, tables, base64) can overflow the context window
    // from within the char budget. Recover by halving the text and retrying:
    // an embedding of the chunk's head keeps the file retrievable, where a
    // hard failure would drop it from the index entirely.
    let attempt = text;
    for (let halvings = 0; ; halvings++) {
      const prompt = prefix ? `${prefix}${attempt}` : attempt;
      const response = await fetchWithTimeout(
        `${this.baseUrl}/api/embeddings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, prompt }),
        },
        timeoutMs,
      );
      if (response.ok) {
        if (halvings > 0) {
          console.warn(
            `[doc-search] chunk exceeded the embedding model's context window; ` +
              `embedded its first ${attempt.length} of ${text.length} chars instead`,
          );
        }
        const data = (await response.json()) as { embedding: number[] };
        return data.embedding;
      }
      const body = await response.text();
      if (response.status === 404 && body.includes("not found")) {
        throw new EmbedError(
          `Ollama model "${this.model}" is required but has not been downloaded yet. ` +
            `Open a terminal and run: ollama pull ${this.model}\n` +
            `Once the download completes, try again.`,
          "model-missing",
          { hint: `Run: ollama pull ${this.model}` },
        );
      }
      if (
        OllamaEmbedder.isContextLengthError(body) &&
        halvings < OllamaEmbedder.MAX_CONTEXT_HALVINGS
      ) {
        attempt = attempt.slice(0, Math.ceil(attempt.length / 2));
        continue;
      }
      throw new EmbedError(
        `Ollama embedding failed (${response.status}): ${body}`,
        response.status === 401 || response.status === 403 ? "auth" : "http-error",
      );
    }
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
      const status = response.status;
      throw new EmbedError(
        `OpenAI embedding failed (${status}): ${await response.text()}`,
        status === 401 || status === 403 ? "auth" : "http-error",
        status === 401 || status === 403
          ? { hint: "Check the OpenAI API key in Doc Search settings." }
          : {},
      );
    }
    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data.map((r) => r.embedding);
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      await this.embed(["ok"]);
      return { ok: true, detail: `OpenAI model "${this.model}"` };
    } catch (err) {
      if (err instanceof EmbedError) {
        // A network blip is not a reason to abandon a whole reindex, so a
        // timeout here stays non-fatal (unlike a local daemon that hangs).
        return {
          ok: false,
          kind: err.timedOut ? "unknown" : err.kind,
          detail: err.message,
          hint: err.hint,
        };
      }
      return {
        ok: false,
        kind: "unknown",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
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
