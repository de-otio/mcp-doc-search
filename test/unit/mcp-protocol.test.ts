/**
 * End-to-end over the real MCP SDK (in-memory transport): what a client sees
 * during `initialize` and `tools/list`, and — through the SDK client's own
 * validation of `structuredContent` against each tool's `outputSchema` — that
 * every tool's structured output actually conforms to the schema it declares.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerTools, _resetStatusCache } from "../../src/mcp/tools.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "../../src/mcp/serverInfo.js";

vi.mock("../../src/core/searcher.js", () => ({
  search: vi.fn(),
}));

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

const ALL_TOOLS = [
  "search_docs",
  "list_docs",
  "reindex_docs",
  "get",
  "multi_get",
  "set_context",
  "list_contexts",
  "remove_context",
];

describe("MCP protocol surface", () => {
  let tmpDir: string;
  let docPath: string;
  let client: Client;
  let server: Server;
  let indexer: any;

  beforeEach(async () => {
    _resetStatusCache();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-protocol-")));
    docPath = path.join(tmpDir, "doc", "guide.md");
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, "# Guide\n\nline two\nline three\n");

    const contexts: Record<string, string> = {};
    indexer = {
      reindex: vi.fn().mockResolvedValue({
        indexed: 1,
        skipped: 0,
        failedFiles: 0,
        totalChunks: 3,
        durationMs: 12,
        pruned: 0,
      }),
      getStatus: vi.fn().mockResolvedValue({
        totalFiles: 1,
        cachedFiles: 1,
        changedFiles: 0,
        newFiles: 0,
        deletedFiles: 0,
        chunkCount: 3,
        lastIndexed: new Date(),
        needsReindex: false,
        docGlob: "doc/**/*.md",
        extraRootNames: [],
      }),
      listContexts: vi.fn(() => ({ ...contexts })),
      setContext: vi.fn((p: string, t: string) => {
        contexts[p] = t;
      }),
      removeContext: vi.fn((p: string) => delete contexts[p]),
      getContextFor: vi.fn(() => ""),
      resolveRef: vi.fn((ref: string) =>
        ref === "doc/guide.md" || ref === "#abc123"
          ? { file: docPath, docid: "abc123" }
          : { error: `Unknown ref: ${ref}` },
      ),
      getWorkspaceRoot: vi.fn(() => tmpDir),
      keyForAbsPath: vi.fn((abs: string) => path.relative(tmpDir, abs)),
      rootForAbsPath: vi.fn(() => tmpDir),
    };
    const store = {
      listFiles: vi.fn().mockResolvedValue([{ file: "doc/guide.md", title: "Guide" }]),
    };
    const { search } = await import("../../src/core/searcher.js");
    vi.mocked(search).mockResolvedValue([
      {
        file: "doc/guide.md",
        heading: "Guide",
        excerpt: "line two",
        score: 0.9,
        lineStart: 3,
        docid: "abc123",
      },
    ]);

    server = new Server(SERVER_INFO, {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    });
    registerTools(server, { store, indexer, embedProvider: { embed: vi.fn() } } as any);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports the package name and version as the server identity", () => {
    expect(client.getServerVersion()).toEqual({ name: pkg.name, version: pkg.version });
    expect(pkg.version).not.toBe("0.1.0");
  });

  it("publishes the three agent-guide rules as instructions", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Search before reading");
    expect(instructions).toContain("`#docid`");
    expect(instructions).toContain("subagent");
  });

  it("lists every tool with annotations and an object outputSchema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.outputSchema?.type, tool.name).toBe("object");
    }
  });

  async function callValidated(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    // listTools caches the per-tool validators; callTool then throws if the
    // structured content violates the declared schema.
    await client.listTools();
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  function textPayload(result: CallToolResult): unknown {
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("expected a text block");
    return JSON.parse(first.text);
  }

  it("search_docs: structuredContent validates and wraps the text array under results", async () => {
    const result = await callValidated("search_docs", { query: "guide" });
    expect(result.structuredContent).toEqual({ results: textPayload(result) });
  });

  it("search_docs: a hybrid explain result (vectorRank/ftsRank/rrfScore) validates", async () => {
    const { search } = await import("../../src/core/searcher.js");
    vi.mocked(search).mockResolvedValue([
      {
        file: "doc/guide.md",
        heading: "Guide",
        excerpt: "line two",
        score: 0.9,
        lineStart: 3,
        docid: "abc123",
        explanation: { vectorScore: 0.9, vectorRank: 1, ftsRank: 2, rrfScore: 0.0325 },
      },
      {
        file: "doc/guide.md",
        heading: "Settings",
        excerpt: "docSearch.extraRoots",
        score: 0.12,
        lineStart: 40,
        docid: "abc123",
        // Recovered by the full-text side only.
        explanation: { vectorScore: 0.12, vectorRank: null, ftsRank: 1, rrfScore: 0.0164 },
      },
    ]);

    const result = await callValidated("search_docs", { query: "extraRoots", explain: true });

    expect(result.isError).toBeFalsy();
    expect(search).toHaveBeenCalledWith(
      "extraRoots",
      5,
      expect.anything(),
      expect.anything(),
      { explain: true },
      expect.anything(),
    );
    const { results } = result.structuredContent as { results: Array<Record<string, unknown>> };
    expect(results[0].explanation).toEqual({
      vectorScore: 0.9,
      vectorRank: 1,
      ftsRank: 2,
      rrfScore: 0.0325,
    });
    expect(results[1].explanation).toMatchObject({ vectorRank: null, ftsRank: 1 });
  });

  it("list_docs: structuredContent validates and wraps the text array under files", async () => {
    const result = await callValidated("list_docs", {});
    expect(result.structuredContent).toEqual({ files: textPayload(result) });
  });

  it.each([
    ["reindex_docs", { force: false }],
    ["get", { ref: "#abc123", from_line: 2, max_lines: 1 }],
    ["multi_get", { refs: "doc/guide.md, #nope" }],
    ["set_context", { path: "doc", text: "Guides" }],
    ["list_contexts", {}],
    ["remove_context", { path: "doc" }],
  ] as const)("%s: structuredContent validates and equals the text block", async (name, args) => {
    const result = await callValidated(name, args as Record<string, unknown>);
    expect(result.structuredContent).toEqual(textPayload(result));
  });

  it("get: returns the file slice, not an error, through the validated path", async () => {
    // Guards against a mock gap: without rootForAbsPath the handler failed
    // closed and the it.each case above validated an error payload instead.
    const result = await callValidated("get", { ref: "#abc123", from_line: 3, max_lines: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      file: "doc/guide.md",
      docid: "abc123",
      content: "line two",
      lines: [3, 3],
      truncated: false,
    });
  });

  it("multi_get: mixes a resolved file with an unresolved ref without erroring", async () => {
    const result = await callValidated("multi_get", { refs: "doc/guide.md, #nope" });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      docs: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
    };
    expect(payload.docs).toHaveLength(1);
    expect(payload.docs[0]).toMatchObject({ file: "doc/guide.md", docid: "abc123" });
    expect(String(payload.docs[0].content)).toContain("line two");
    expect(payload.errors).toEqual([{ ref: "#nope", error: expect.stringContaining("nope") }]);
  });

  it("an error result still carries matching structured content that validates", async () => {
    const result = await callValidated("get", { ref: "" });
    expect(result.structuredContent).toEqual({ error: "ref is required." });
    expect(textPayload(result)).toEqual({ error: "ref is required." });
  });

  it("the client rejects structured content that breaks a declared schema", async () => {
    // Prove the validation in the tests above has teeth: a result whose
    // `lines` is not a 2-number array must fail the SDK client's check.
    const { tools } = await client.listTools();
    const getSchema = tools.find((t) => t.name === "get")!.outputSchema!;
    const bad = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    const { ListToolsRequestSchema, CallToolRequestSchema } =
      await import("@modelcontextprotocol/sdk/types.js");
    bad.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "get", inputSchema: { type: "object" }, outputSchema: getSchema }],
    }));
    bad.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { file: "x", docid: "y", content: "", lines: [1], truncated: false },
    }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await bad.connect(st);
    const badClient = new Client({ name: "t", version: "0" });
    await badClient.connect(ct);
    try {
      await badClient.listTools();
      await expect(badClient.callTool({ name: "get", arguments: {} })).rejects.toThrow(
        /does not match the tool's output schema/,
      );
    } finally {
      await badClient.close();
      await bad.close();
    }
  });
});
