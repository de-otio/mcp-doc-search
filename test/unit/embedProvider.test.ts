import { describe, expect, it } from "vitest";
import { OllamaEmbedder, OpenAIEmbedder } from "../../src/core/embedder.js";
import { createExtensionEmbedProvider } from "../../src/extension/embedProvider.js";
import { ProcessEmbedder } from "../../src/extension/processEmbedder.js";

describe("createExtensionEmbedProvider", () => {
  it("runs the built-in model in a child process", () => {
    const provider = createExtensionEmbedProvider({ embedProvider: "local" }, "/ext");
    expect(provider).toBeInstanceOf(ProcessEmbedder);
    expect(provider.identity?.()).toMatchObject({
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
    });
  });

  it("passes the configured local model through", () => {
    const provider = createExtensionEmbedProvider(
      { embedProvider: "local", localModel: "Xenova/multilingual-e5-small" },
      "/ext",
    );
    expect(provider.identity?.()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dim: 384,
    });
  });

  it("keeps Ollama in-process", () => {
    expect(createExtensionEmbedProvider({ embedProvider: "ollama" }, "/ext")).toBeInstanceOf(
      OllamaEmbedder,
    );
  });

  it("keeps OpenAI in-process", () => {
    const provider = createExtensionEmbedProvider(
      { embedProvider: "openai", openaiApiKey: "sk-test" },
      "/ext",
    );
    expect(provider).toBeInstanceOf(OpenAIEmbedder);
  });
});
