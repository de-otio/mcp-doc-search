import { describe, expect, it, vi } from "vitest";
import { EmbedError } from "../../src/core/embedder.js";
import {
  handleWorkerRequest,
  parseWorkerArgs,
  toErrorPayload,
  type WorkerEmbedder,
} from "../../src/extension/embedWorker.js";

function fakeEmbedder(overrides: Partial<WorkerEmbedder> = {}): WorkerEmbedder {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map((t) => [t.length])),
    healthCheck: vi.fn(async () => ({ ok: true, detail: "fake" })),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe("handleWorkerRequest", () => {
  it("embeds and echoes the request id", async () => {
    const embedder = fakeEmbedder();
    const reply = await handleWorkerRequest(embedder, {
      id: 7,
      op: "embed",
      texts: ["a", "bbb"],
      prefix: "search_query: ",
    });
    expect(reply).toEqual({ id: 7, ok: true, vectors: [[1], [3]] });
    expect(embedder.embed).toHaveBeenCalledWith(["a", "bbb"], "search_query: ");
  });

  it("forwards health checks", async () => {
    const reply = await handleWorkerRequest(fakeEmbedder(), { id: 2, op: "health" });
    expect(reply).toEqual({ id: 2, ok: true, health: { ok: true, detail: "fake" } });
  });

  it("disposes the embedder", async () => {
    const embedder = fakeEmbedder();
    expect(await handleWorkerRequest(embedder, { id: 3, op: "dispose" })).toEqual({
      id: 3,
      ok: true,
    });
    expect(embedder.dispose).toHaveBeenCalledOnce();
  });

  it("keeps an EmbedError's kind and hint", async () => {
    const embedder = fakeEmbedder({
      embed: async () => {
        throw new EmbedError("no weights", "model-missing", { hint: "download them" });
      },
    });
    expect(await handleWorkerRequest(embedder, { id: 4, op: "embed", texts: ["a"] })).toEqual({
      id: 4,
      ok: false,
      error: { message: "no weights", kind: "model-missing", hint: "download them" },
    });
  });

  it("reports a plain Error as kind unknown and never throws", async () => {
    const embedder = fakeEmbedder({
      embed: async () => {
        throw new Error("onnx exploded");
      },
    });
    const reply = await handleWorkerRequest(embedder, { id: 5, op: "embed", texts: ["a"] });
    expect(reply).toEqual({
      id: 5,
      ok: false,
      error: { message: "onnx exploded", kind: "unknown" },
    });
  });

  it("rejects an unknown op instead of hanging the caller", async () => {
    const reply = await handleWorkerRequest(fakeEmbedder(), { id: 6, op: "bogus" } as never);
    expect(reply).toMatchObject({ id: 6, ok: false, error: { kind: "unknown" } });
  });
});

describe("toErrorPayload", () => {
  it("stringifies non-Error throws", () => {
    expect(toErrorPayload("boom")).toEqual({ message: "boom", kind: "unknown" });
  });
});

describe("parseWorkerArgs", () => {
  it("reads model and model-path flags", () => {
    expect(parseWorkerArgs(["--model=Xenova/x", "--model-path=/m"])).toEqual({
      model: "Xenova/x",
      modelPath: "/m",
    });
  });

  it("treats absent or blank flags as unset", () => {
    expect(parseWorkerArgs([])).toEqual({ model: undefined, modelPath: undefined });
    expect(parseWorkerArgs(["--model=", "--model-path="])).toEqual({
      model: undefined,
      modelPath: undefined,
    });
  });
});
