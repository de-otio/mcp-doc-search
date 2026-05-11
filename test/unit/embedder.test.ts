import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OllamaEmbedder,
  OpenAIEmbedder,
  LocalEmbedder,
  createEmbedProvider,
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
