import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_LOCAL_MODEL,
  LOCAL_MODELS,
  LocalEmbedder,
  OllamaEmbedder,
  OpenAIEmbedder,
  createEmbedProvider,
  defaultMaxChunkChars,
  isFatalEmbedKind,
  resolveMaxChunkChars,
} from "../../src/core/embedder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Response-like object that fetch resolves to. */
function makeFakeResponse(body: unknown, status = 200): Response {
  const bodyText = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
    json: async () => body,
  } as unknown as Response;
}

/** What an AbortController firing looks like to fetch's caller. */
function makeAbortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

/** What Node surfaces for a refused/reset connection: TypeError with a cause. */
function makeConnectionError(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as unknown as { cause: { code: string } }).cause = { code };
  return err;
}

// ---------------------------------------------------------------------------
// OllamaEmbedder
// ---------------------------------------------------------------------------

describe("OllamaEmbedder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies the prefix to the prompt sent to the Ollama API", async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3];
    const capturedBodies: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBodies.push(JSON.parse(init?.body as string));
        return makeFakeResponse({ embedding: fakeEmbedding });
      }),
    );

    const embedder = new OllamaEmbedder("nomic-embed-text");
    const prefix = "search_document: ";
    const texts = ["hello world"];
    await embedder.embed(texts, prefix);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as { model: string; prompt: string };
    // The prompt must include the prefix prepended to the text
    expect(body.prompt).toBe(`${prefix}${texts[0]}`);
    expect(body.model).toBe("nomic-embed-text");
  });

  it("throws an error when the Ollama API returns a 500 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeFakeResponse("Internal Server Error", 500)),
    );

    const embedder = new OllamaEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow("500");
  });

  it("halves the text and retries when the model reports a context-length overflow", async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3];
    const prompts: string[] = [];
    const prefix = "search_document: ";
    // Dense text whose tokenization "overflows" until it has been halved twice
    const text = "x".repeat(4000);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { prompt: string };
        prompts.push(body.prompt);
        if (body.prompt.length - prefix.length > 1000) {
          return makeFakeResponse({ error: "the input length exceeds the context length" }, 500);
        }
        return makeFakeResponse({ embedding: fakeEmbedding });
      }),
    );

    const embedder = new OllamaEmbedder();
    const result = await embedder.embed([text], prefix);

    expect(result).toEqual([fakeEmbedding]);
    // 4000 → 2000 → 1000 chars: two rejections, then success
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toBe(`${prefix}${text}`);
    expect(prompts[1]).toBe(`${prefix}${"x".repeat(2000)}`);
    expect(prompts[2]).toBe(`${prefix}${"x".repeat(1000)}`);
  });

  it("gives up after bounded halvings when the overflow never clears", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push((JSON.parse(init?.body as string) as { prompt: string }).prompt);
        return makeFakeResponse({ error: "the input length exceeds the context length" }, 500);
      }),
    );

    const embedder = new OllamaEmbedder();
    await expect(embedder.embed(["y".repeat(4000)])).rejects.toThrow("exceeds the context length");
    // Initial attempt + 3 halvings, then give up
    expect(calls).toHaveLength(4);
  });

  it("does not retry a 500 that is not a context-length error", async () => {
    const fetchMock = vi.fn(async () => makeFakeResponse({ error: "model crashed" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new OllamaEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow("model crashed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a request that timed out", async () => {
    // A request left unanswered for the whole timeout will not answer 100ms
    // later; retrying only doubled every stall.
    const fetchMock = vi.fn(async () => {
      throw makeAbortError();
    });
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new OllamaEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a transient connection error once", async () => {
    const fetchMock = vi.fn(async () => {
      throw makeConnectionError("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new OllamaEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow(/Cannot reach/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// OllamaEmbedder.healthCheck — telling "daemon down" from "daemon broken"
// ---------------------------------------------------------------------------

describe("OllamaEmbedder.healthCheck", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unreachable when the daemon is not listening", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw makeConnectionError("ECONNREFUSED");
      }),
    );

    const health = await new OllamaEmbedder().healthCheck();

    expect(health.ok).toBe(false);
    expect(health.kind).toBe("unreachable");
    expect(isFatalEmbedKind(health.kind!)).toBe(true);
  });

  it("reports runner-load-failed when /api/version answers but embedding hangs", async () => {
    // Regression test for the real-world fault: an Ollama daemon left running
    // across an upgrade serves /api/version normally (no model needed) while
    // every model load fails and the embed request is never answered.
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/version")) {
        return makeFakeResponse({ version: "0.16.3" });
      }
      throw makeAbortError();
    });
    vi.stubGlobal("fetch", fetchMock);

    const health = await new OllamaEmbedder("nomic-embed-text", "http://127.0.0.1:11434", {
      probeTimeoutMs: 50,
    }).healthCheck();

    expect(health.ok).toBe(false);
    expect(health.kind).toBe("runner-load-failed");
    expect(health.detail).toContain("0.16.3");
    expect(health.hint).toMatch(/[Rr]estart Ollama/);
  });

  it("reports model-missing when the model has not been pulled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/api/version")
          ? makeFakeResponse({ version: "0.33.0" })
          : makeFakeResponse({ error: 'model "nomic-embed-text" not found' }, 404),
      ),
    );

    const health = await new OllamaEmbedder().healthCheck();

    expect(health.ok).toBe(false);
    expect(health.kind).toBe("model-missing");
    expect(health.hint).toContain("ollama pull");
  });

  it("reports ok when the daemon answers and the probe embeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/api/version")
          ? makeFakeResponse({ version: "0.33.0" })
          : makeFakeResponse({ embedding: [0.1, 0.2, 0.3] }),
      ),
    );

    const health = await new OllamaEmbedder().healthCheck();

    expect(health.ok).toBe(true);
    expect(health.detail).toContain("0.33.0");
  });
});

// ---------------------------------------------------------------------------
// OpenAIEmbedder
// ---------------------------------------------------------------------------

describe("OpenAIEmbedder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on construction when apiKey is an empty string", () => {
    expect(() => new OpenAIEmbedder("")).toThrow("OpenAI API key is required");
  });

  it("sends all texts as a single batched request", async () => {
    const fakeData = [
      { embedding: [0.1, 0.2] },
      { embedding: [0.3, 0.4] },
      { embedding: [0.5, 0.6] },
    ];
    const capturedBodies: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBodies.push(JSON.parse(init?.body as string));
        return makeFakeResponse({ data: fakeData });
      }),
    );

    const embedder = new OpenAIEmbedder("sk-test-key");
    const texts = ["alpha", "beta", "gamma"];
    const result = await embedder.embed(texts);

    // Only one fetch call should be made for the whole batch
    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as { input: string[]; model: string };
    expect(body.input).toEqual(texts);
    expect(result).toHaveLength(3);
  });

  it("applies the prefix to every input element in the batch", async () => {
    const capturedBodies: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBodies.push(JSON.parse(init?.body as string));
        return makeFakeResponse({
          data: [{ embedding: [0.1] }, { embedding: [0.2] }],
        });
      }),
    );

    const embedder = new OpenAIEmbedder("sk-test-key");
    const prefix = "search_document: ";
    const texts = ["foo", "bar"];
    await embedder.embed(texts, prefix);

    const body = capturedBodies[0] as { input: string[] };
    expect(body.input).toEqual([`${prefix}foo`, `${prefix}bar`]);
  });

  it("throws an error when the OpenAI API returns a 401 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeFakeResponse("Unauthorized", 401)),
    );

    const embedder = new OpenAIEmbedder("sk-bad-key");
    await expect(embedder.embed(["test"])).rejects.toThrow("401");
  });
});

// ---------------------------------------------------------------------------
// LocalEmbedder (mocked — avoids downloading the real ONNX model)
// ---------------------------------------------------------------------------

// We inject a fake `loader` so tests never actually require the real
// @huggingface/transformers package (which would download a model).

/** A fake transformers.js runtime that records calls and returns fixed vectors. */
function makeFakeRuntime() {
  const pipelineFn = vi.fn(async (texts: string[]) => ({
    tolist: () => texts.map(() => [0.1, 0.2, 0.3]),
  }));
  const pipelineFactory = vi.fn(async () => pipelineFn);
  const tokenizer = vi.fn(async (texts: string[]) => ({ texts }));
  const tokenizerFactory = vi.fn(async () => tokenizer);
  const modelFn = vi.fn(async (inputs: { texts: string[] }) => ({
    sentence_embedding: {
      normalize: () => ({ tolist: () => inputs.texts.map(() => [0.4, 0.5]) }),
    },
  }));
  const modelFactory = vi.fn(async () => modelFn);
  const env = { localModelPath: "" };
  const loader = () =>
    ({
      pipeline: pipelineFactory,
      env,
      AutoTokenizer: { from_pretrained: tokenizerFactory },
      AutoModel: { from_pretrained: modelFactory },
    }) as unknown as typeof import("@huggingface/transformers");
  return {
    pipelineFn,
    pipelineFactory,
    tokenizer,
    tokenizerFactory,
    modelFn,
    modelFactory,
    env,
    loader,
  };
}

describe("LocalEmbedder", () => {
  let rt: ReturnType<typeof makeFakeRuntime>;

  beforeEach(() => {
    rt = makeFakeRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the transformers pipeline and returns float arrays", async () => {
    const embedder = new LocalEmbedder({ loader: rt.loader });
    const result = await embedder.embed(["hello world"]);

    expect(result).toEqual([
      [expect.closeTo(0.1, 4), expect.closeTo(0.2, 4), expect.closeTo(0.3, 4)],
    ]);
  });

  it("drops the caller's role prefix for a model trained without prefixes (MiniLM)", async () => {
    const embedder = new LocalEmbedder({ loader: rt.loader });
    await embedder.embed(["test"], "search_document: ");

    expect(rt.pipelineFn).toHaveBeenCalledWith(["test"], { pooling: "mean", normalize: true });
  });

  it("translates role prefixes into the model's own (multilingual-e5-small)", async () => {
    const embedder = new LocalEmbedder({
      model: "Xenova/multilingual-e5-small",
      loader: rt.loader,
    });
    await embedder.embed(["frage"], "search_query: ");
    await embedder.embed(["absatz"], "search_document: ");
    await embedder.embed(["roh"]);

    const calls = rt.pipelineFn.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([["query: frage"], ["passage: absatz"], ["roh"]]);
  });

  it("loads the default model with no dtype and a registry model with its dtype", async () => {
    await new LocalEmbedder({ loader: rt.loader }).embed(["a"]);
    await new LocalEmbedder({ model: "nomic-ai/nomic-embed-text-v1.5", loader: rt.loader }).embed([
      "b",
    ]);

    expect(rt.pipelineFactory).toHaveBeenNthCalledWith(
      1,
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      {},
    );
    expect(rt.pipelineFactory).toHaveBeenNthCalledWith(
      2,
      "feature-extraction",
      "nomic-ai/nomic-embed-text-v1.5",
      { dtype: "q8" },
    );
  });

  it("batches model calls in groups of 32 and preserves order", async () => {
    const embedder = new LocalEmbedder({ loader: rt.loader });
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);

    const result = await embedder.embed(texts);

    expect(result).toHaveLength(70);
    expect(rt.pipelineFn.mock.calls.map((c) => c[0].length)).toEqual([32, 32, 6]);
    expect(rt.pipelineFn.mock.calls[2][0]).toEqual(["t64", "t65", "t66", "t67", "t68", "t69"]);
  });

  it("drives EmbeddingGemma through AutoModel and its sentence_embedding output", async () => {
    const embedder = new LocalEmbedder({
      model: "onnx-community/embeddinggemma-300m-ONNX",
      loader: rt.loader,
    });
    const result = await embedder.embed(["hello"], "search_query: ");

    expect(rt.pipelineFactory).not.toHaveBeenCalled();
    expect(rt.modelFactory).toHaveBeenCalledWith("onnx-community/embeddinggemma-300m-ONNX", {
      dtype: "q8",
    });
    expect(rt.tokenizer).toHaveBeenCalledWith(["task: search result | query: hello"], {
      padding: true,
      truncation: true,
    });
    expect(result).toEqual([[0.4, 0.5]]);
  });

  it("returns an empty result without loading anything for an empty batch", async () => {
    const embedder = new LocalEmbedder({ loader: rt.loader });

    expect(await embedder.embed([])).toEqual([]);
    expect(rt.pipelineFactory).not.toHaveBeenCalled();
  });

  it("sets localModelPath on env when modelPath is provided", async () => {
    const embedder = new LocalEmbedder({ modelPath: "/tmp/models", loader: rt.loader });
    await embedder.embed(["test"]);

    expect(rt.env.localModelPath).toBe("/tmp/models");
  });

  it("reuses the loaded model across multiple embed calls", async () => {
    const embedder = new LocalEmbedder({ loader: rt.loader });
    await embedder.embed(["first"]);
    await embedder.embed(["second"]);

    // model factory should only be called once (lazy init)
    expect(rt.pipelineFactory).toHaveBeenCalledTimes(1);
    // But the model itself is called for each batch
    expect(rt.pipelineFn).toHaveBeenCalledTimes(2);
  });

  it("reports its identity from the registry spec", () => {
    expect(new LocalEmbedder({ loader: rt.loader }).identity()).toEqual({
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      dim: 384,
    });
    expect(
      new LocalEmbedder({
        model: "onnx-community/embeddinggemma-300m-ONNX",
        loader: rt.loader,
      }).identity(),
    ).toEqual({ provider: "local", model: "onnx-community/embeddinggemma-300m-ONNX", dim: 768 });
  });

  it("rejects an unknown model id at construction, naming the known ones", () => {
    expect(() => new LocalEmbedder({ model: "Xenova/no-such-model", loader: rt.loader })).toThrow(
      /Unknown local embedding model "Xenova\/no-such-model".*all-MiniLM-L6-v2/,
    );
  });

  it("treats a blank model id as the default", () => {
    expect(new LocalEmbedder({ model: "  ", loader: rt.loader }).identity().model).toBe(
      DEFAULT_LOCAL_MODEL,
    );
  });
});

// ---------------------------------------------------------------------------
// LOCAL_MODELS registry and the chunk budget derived from it
// ---------------------------------------------------------------------------

describe("LOCAL_MODELS", () => {
  it("keeps all-MiniLM-L6-v2 as the default and lists the four supported models", () => {
    expect(DEFAULT_LOCAL_MODEL).toBe("Xenova/all-MiniLM-L6-v2");
    expect(Object.keys(LOCAL_MODELS).sort()).toEqual([
      "Xenova/all-MiniLM-L6-v2",
      "Xenova/multilingual-e5-small",
      "nomic-ai/nomic-embed-text-v1.5",
      "onnx-community/embeddinggemma-300m-ONNX",
    ]);
  });

  it("every spec is internally consistent", () => {
    for (const [key, spec] of Object.entries(LOCAL_MODELS)) {
      expect(spec.id).toBe(key);
      expect(spec.dim).toBeGreaterThan(0);
      expect(spec.ctxTokens).toBeGreaterThan(0);
      expect(spec.downloadMb).toBeGreaterThan(0);
      // A query prefix without a document prefix (or vice versa) is a typo.
      expect(spec.queryPrefix === "").toBe(spec.docPrefix === "");
    }
  });

  it("derives the chunk budget from the context window, clamped to [800, 8000]", () => {
    expect(defaultMaxChunkChars(LOCAL_MODELS["Xenova/all-MiniLM-L6-v2"])).toBe(800);
    expect(defaultMaxChunkChars(LOCAL_MODELS["Xenova/multilingual-e5-small"])).toBe(1536);
    expect(defaultMaxChunkChars(LOCAL_MODELS["onnx-community/embeddinggemma-300m-ONNX"])).toBe(
      6144,
    );
    expect(defaultMaxChunkChars(LOCAL_MODELS["nomic-ai/nomic-embed-text-v1.5"])).toBe(8000);
  });
});

describe("resolveMaxChunkChars", () => {
  const local = new LocalEmbedder({ loader: makeFakeRuntime().loader });

  it("lets an explicit value win, clamped to 100–50000", () => {
    expect(resolveMaxChunkChars(1200, local)).toBe(1200);
    expect(resolveMaxChunkChars("2500", local)).toBe(2500);
    expect(resolveMaxChunkChars(5, local)).toBe(100);
    expect(resolveMaxChunkChars(1e9, local)).toBe(50_000);
  });

  it("treats 0, unset and junk as auto: model-derived for the local provider", () => {
    expect(resolveMaxChunkChars(0, local)).toBe(800);
    expect(resolveMaxChunkChars(undefined, local)).toBe(800);
    expect(resolveMaxChunkChars("auto", local)).toBe(800);
    const e5 = new LocalEmbedder({
      model: "Xenova/multilingual-e5-small",
      loader: makeFakeRuntime().loader,
    });
    expect(resolveMaxChunkChars(0, e5)).toBe(1536);
  });

  it("keeps the legacy 4000 for Ollama, OpenAI and identity-less providers", () => {
    expect(resolveMaxChunkChars(0, new OllamaEmbedder())).toBe(4000);
    expect(resolveMaxChunkChars(0, new OpenAIEmbedder("sk-x"))).toBe(4000);
    expect(resolveMaxChunkChars(0, { embed: async () => [] })).toBe(4000);
    expect(resolveMaxChunkChars(0, undefined)).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// identity() on the remote providers
// ---------------------------------------------------------------------------

describe("identity()", () => {
  it("Ollama reports its model without a dimension", () => {
    expect(new OllamaEmbedder("mxbai-embed-large").identity()).toEqual({
      provider: "ollama",
      model: "mxbai-embed-large",
    });
  });

  it("OpenAI reports the dimension of known models only", () => {
    expect(new OpenAIEmbedder("sk-x").identity()).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dim: 1536,
    });
    expect(new OpenAIEmbedder("sk-x", "text-embedding-3-large").identity()).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
      dim: 3072,
    });
    expect(new OpenAIEmbedder("sk-x", "future-model").identity()).toEqual({
      provider: "openai",
      model: "future-model",
    });
  });
});

// ---------------------------------------------------------------------------
// identity() — what the index metadata records
// ---------------------------------------------------------------------------

describe("identity", () => {
  it("LocalEmbedder names the bundled model with its known dimension", () => {
    expect(new LocalEmbedder().identity()).toEqual({
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      dim: 384,
    });
  });

  it("OllamaEmbedder reports the configured model without a dimension", () => {
    expect(new OllamaEmbedder("mxbai-embed-large").identity()).toEqual({
      provider: "ollama",
      model: "mxbai-embed-large",
    });
  });

  it("OpenAIEmbedder knows the dimension of its default model only", () => {
    expect(new OpenAIEmbedder("sk-test").identity()).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dim: 1536,
    });
    expect(new OpenAIEmbedder("sk-test", "text-embedding-3-large").identity().dim).toBe(3072);
    expect(new OpenAIEmbedder("sk-test", "some-future-model").identity().dim).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createEmbedProvider factory
// ---------------------------------------------------------------------------

describe("createEmbedProvider", () => {
  it("returns a LocalEmbedder for 'local' provider", () => {
    const provider = createEmbedProvider({ embedProvider: "local" });
    expect(provider).toBeInstanceOf(LocalEmbedder);
    expect(provider.identity?.().model).toBe(DEFAULT_LOCAL_MODEL);
  });

  it("passes localModel through to the LocalEmbedder", () => {
    const provider = createEmbedProvider({
      embedProvider: "local",
      localModel: "Xenova/multilingual-e5-small",
    });
    expect(provider.identity?.()).toMatchObject({
      provider: "local",
      model: "Xenova/multilingual-e5-small",
    });
  });

  it("returns an OllamaEmbedder for 'ollama' provider", () => {
    const provider = createEmbedProvider({
      embedProvider: "ollama",
      ollamaModel: "nomic-embed-text",
      ollamaUrl: "http://localhost:11434",
    });
    expect(provider).toBeInstanceOf(OllamaEmbedder);
  });

  it("returns an OpenAIEmbedder for 'openai' provider", () => {
    const provider = createEmbedProvider({
      embedProvider: "openai",
      openaiApiKey: "sk-test",
    });
    expect(provider).toBeInstanceOf(OpenAIEmbedder);
  });
});
