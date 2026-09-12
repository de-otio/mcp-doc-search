import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  MCP_PROVIDER_ID,
  MCP_SERVER_LABEL,
  buildProviderEnv,
  registerMcpServerDefinitionProvider,
} from "../../src/extension/mcpProvider.js";

vi.mock("../../src/extension/config.js", () => ({
  readConfig: vi.fn(),
  readOpenAIApiKey: vi.fn(),
}));

const STABLE_LAUNCHER = "/mock-home/.doc-search/bin/mcp-server.js";

const BASE_CONFIG = {
  docGlob: "doc/**/*.md",
  extraRoots: [],
  embedProvider: "local" as const,
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "nomic-embed-text",
  openaiApiKey: "",
};

describe("buildProviderEnv", () => {
  it("carries the absolute workspace root and the glob, like the .mcp.json generator", () => {
    expect(buildProviderEnv("/ws", BASE_CONFIG)).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_GLOB: "doc/**/*.md",
    });
  });

  it("forwards extra roots and the Ollama settings the server no longer reads from settings.json", () => {
    const roots = [{ name: "notes", path: "~/notes" }];
    expect(
      buildProviderEnv("/ws", {
        ...BASE_CONFIG,
        extraRoots: roots,
        embedProvider: "ollama",
        ollamaUrl: "http://127.0.0.1:11434",
        ollamaModel: "nomic-embed-text",
      }),
    ).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_GLOB: "doc/**/*.md",
      DOC_SEARCH_EXTRA_ROOTS: JSON.stringify(roots),
      OLLAMA_URL: "http://127.0.0.1:11434",
      OLLAMA_MODEL: "nomic-embed-text",
    });
  });

  it("substitutes the literal OpenAI key for the ${OPENAI_API_KEY} reference VS Code cannot expand", () => {
    const env = buildProviderEnv("/ws", {
      ...BASE_CONFIG,
      embedProvider: "openai",
      openaiApiKey: "sk-test",
    });
    expect(env).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_GLOB: "doc/**/*.md",
      USE_OPENAI: "1",
      OPENAI_API_KEY: "sk-test",
    });
    expect(Object.values(env)).not.toContain("${OPENAI_API_KEY}");
  });

  it("drops the key entry (so the editor's environment applies) when no key is stored", () => {
    expect(buildProviderEnv("/ws", { ...BASE_CONFIG, embedProvider: "openai" })).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_GLOB: "doc/**/*.md",
      USE_OPENAI: "1",
    });
  });

  it("ignores a stored key when the provider is not OpenAI", () => {
    expect(buildProviderEnv("/ws", { ...BASE_CONFIG, openaiApiKey: "sk-test" })).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_GLOB: "doc/**/*.md",
    });
  });
});

describe("registerMcpServerDefinitionProvider", () => {
  let context: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    context = {
      secrets: { get: vi.fn().mockResolvedValue("") },
      subscriptions: [],
      extension: { packageJSON: { version: "9.9.9" } },
    };
    const { readConfig, readOpenAIApiKey } = await import("../../src/extension/config.js");
    vi.mocked(readOpenAIApiKey).mockResolvedValue("");
    vi.mocked(readConfig).mockReturnValue({ ...BASE_CONFIG } as any);
  });

  it("uses the id declared under contributes.mcpServerDefinitionProviders", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.contributes.mcpServerDefinitionProviders).toEqual([
      { id: MCP_PROVIDER_ID, label: MCP_SERVER_LABEL },
    ]);

    registerMcpServerDefinitionProvider(context, {
      workspaceRoot: "/ws",
      mcpServerPath: STABLE_LAUNCHER,
    });

    expect(vscode.lm.registerMcpServerDefinitionProvider).toHaveBeenCalledWith(
      MCP_PROVIDER_ID,
      expect.objectContaining({ provideMcpServerDefinitions: expect.any(Function) }),
    );
  });

  it("provides exactly one stdio definition pointing at the stable launcher", async () => {
    registerMcpServerDefinitionProvider(context, {
      workspaceRoot: "/ws",
      mcpServerPath: STABLE_LAUNCHER,
    });
    const provider = vi.mocked(vscode.lm.registerMcpServerDefinitionProvider).mock.calls[0][1];

    const defs = await provider.provideMcpServerDefinitions({} as any);

    expect(defs).toHaveLength(1);
    const def = defs![0] as vscode.McpStdioServerDefinition;
    expect(def).toBeInstanceOf(vscode.McpStdioServerDefinition);
    expect(def.label).toBe(MCP_SERVER_LABEL);
    expect(def.command).toBe(process.execPath);
    expect(def.args).toEqual([STABLE_LAUNCHER]);
    expect(def.env).toEqual({ DOC_SEARCH_WORKSPACE: "/ws", DOC_SEARCH_GLOB: "doc/**/*.md" });
    expect(def.version).toBe("9.9.9");
  });

  it("re-reads the provider configuration on every provide call", async () => {
    const { readConfig, readOpenAIApiKey } = await import("../../src/extension/config.js");
    registerMcpServerDefinitionProvider(context, {
      workspaceRoot: "/ws",
      mcpServerPath: STABLE_LAUNCHER,
    });
    const provider = vi.mocked(vscode.lm.registerMcpServerDefinitionProvider).mock.calls[0][1];

    const before = (await provider.provideMcpServerDefinitions({} as any))![0] as any;
    expect(before.env.USE_OPENAI).toBeUndefined();

    vi.mocked(readOpenAIApiKey).mockResolvedValue("sk-live");
    vi.mocked(readConfig).mockReturnValue({
      ...BASE_CONFIG,
      embedProvider: "openai",
      openaiApiKey: "sk-live",
    } as any);
    const after = (await provider.provideMcpServerDefinitions({} as any))![0] as any;

    expect(readOpenAIApiKey).toHaveBeenCalledWith(context.secrets);
    expect(readConfig).toHaveBeenLastCalledWith("sk-live");
    expect(after.env).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_GLOB: "doc/**/*.md",
      OPENAI_API_KEY: "sk-live",
      USE_OPENAI: "1",
    });
  });

  it("returns the registration disposable", () => {
    const disposable = registerMcpServerDefinitionProvider(context, {
      workspaceRoot: "/ws",
      mcpServerPath: STABLE_LAUNCHER,
    });
    expect(disposable).toEqual(expect.objectContaining({ dispose: expect.any(Function) }));
  });

  it("registers nothing on a host whose vscode.lm lacks the API", () => {
    const original = vscode.lm.registerMcpServerDefinitionProvider;
    (vscode.lm as any).registerMcpServerDefinitionProvider = undefined;
    try {
      const result = registerMcpServerDefinitionProvider(context, {
        workspaceRoot: "/ws",
        mcpServerPath: STABLE_LAUNCHER,
      });
      expect(result).toBeUndefined();
    } finally {
      (vscode.lm as any).registerMcpServerDefinitionProvider = original;
    }
  });
});
