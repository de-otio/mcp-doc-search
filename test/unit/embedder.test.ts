import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OllamaEmbedder,
  OpenAIEmbedder,
  LocalEmbedder,
  createEmbedProvider,
  isFatalEmbedKind,
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

describe("LocalEmbedder", () => {
  let fakePipelineFn: ReturnType<typeof vi.fn>;
  let fakePipelineFactory: ReturnType<typeof vi.fn>;
  let fakeEnv: { localModelPath: string };
  let fakeLoader: () => typeof import("@huggingface/transformers");

  beforeEach(() => {
    fakeEnv = { localModelPath: "" };
    fakePipelineFn = vi.fn(async () => ({
      data: new Float32Array([0.1, 0.2, 0.3]),
    }));
    fakePipelineFactory = vi.fn(async () => fakePipelineFn);
    fakeLoader = () =>
      ({
        pipeline: fakePipelineFactory,
        env: fakeEnv,
      }) as unknown as typeof import("@huggingface/transformers");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the transformers pipeline and returns float arrays", async () => {
    const embedder = new LocalEmbedder({ loader: fakeLoader });
    const result = await embedder.embed(["hello world"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([
      expect.closeTo(0.1, 4),
      expect.closeTo(0.2, 4),
      expect.closeTo(0.3, 4),
    ]);
  });

  it("ignores the prefix parameter", async () => {
    const embedder = new LocalEmbedder({ loader: fakeLoader });
    await embedder.embed(["test"], "search_document: ");

    // The pipeline is called with the raw text, NOT with the prefix
    expect(fakePipelineFn).toHaveBeenCalledWith("test", {
      pooling: "mean",
      normalize: true,
    });
  });

  it("sets localModelPath on env when modelPath is provided", async () => {
    const embedder = new LocalEmbedder({ modelPath: "/tmp/models", loader: fakeLoader });
    await embedder.embed(["test"]);

    expect(fakeEnv.localModelPath).toBe("/tmp/models");
  });

  it("reuses the pipeline across multiple embed calls", async () => {
    const embedder = new LocalEmbedder({ loader: fakeLoader });
    await embedder.embed(["first"]);
    await embedder.embed(["second"]);

    // pipeline factory should only be called once (lazy init)
    expect(fakePipelineFactory).toHaveBeenCalledTimes(1);
    // But the pipeline function itself is called for each text
    expect(fakePipelineFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createEmbedProvider factory
// ---------------------------------------------------------------------------

describe("createEmbedProvider", () => {
  it("returns a LocalEmbedder for 'local' provider", () => {
    const provider = createEmbedProvider({ embedProvider: "local" });
    expect(provider).toBeInstanceOf(LocalEmbedder);
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
