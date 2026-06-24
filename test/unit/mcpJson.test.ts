import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, afterEach } from "vitest";

import { repairMcpServerPath, repairMcpJson } from "../../src/extension/mcpJson.js";

const NEW =
  "/Users/me/.vscode/extensions/de-otio.mcp-doc-search-0.3.0-darwin-arm64/dist/mcp-server.js";
const STALE = "/Users/me/.vscode/extensions/de-otio-org.mcp-doc-search-0.1.0/dist/mcp-server.js";

function mcpJson(server: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: { "doc-search": server } }, null, 2) + "\n";
}

describe("repairMcpServerPath (pure)", () => {
  it("rewrites a stale doc-search server path to the current build", () => {
    const out = repairMcpServerPath(
      mcpJson({ command: "node", args: [STALE], env: { DOC_SEARCH_WORKSPACE: "/ws" } }),
      NEW,
    );
    expect(out).toBeDefined();
    const parsed = JSON.parse(out!);
    expect(parsed.mcpServers["doc-search"].args).toEqual([NEW]);
    // env preserved untouched
    expect(parsed.mcpServers["doc-search"].env).toEqual({ DOC_SEARCH_WORKSPACE: "/ws" });
  });

  it("is a no-op when the path is already current", () => {
    expect(repairMcpServerPath(mcpJson({ command: "node", args: [NEW] }), NEW)).toBeUndefined();
  });

  it("returns undefined for an absent file", () => {
    expect(repairMcpServerPath(undefined, NEW)).toBeUndefined();
  });

  it("never clobbers malformed JSON", () => {
    expect(repairMcpServerPath("{ not json", NEW)).toBeUndefined();
  });

  it("ignores a file with no doc-search server", () => {
    const text = JSON.stringify({ mcpServers: { other: { command: "node", args: [STALE] } } });
    expect(repairMcpServerPath(text, NEW)).toBeUndefined();
  });

  it("leaves a custom (non-extension) command alone", () => {
    const custom = "/Users/me/dev/my-fork/dist/server.js";
    expect(repairMcpServerPath(mcpJson({ command: "node", args: [custom] }), NEW)).toBeUndefined();
  });

  it("rewrites only the mcp-server.js arg, preserving other args and order", () => {
    const out = repairMcpServerPath(
      mcpJson({ command: "node", args: ["--enable-source-maps", STALE, "--flag"] }),
      NEW,
    );
    const parsed = JSON.parse(out!);
    expect(parsed.mcpServers["doc-search"].args).toEqual(["--enable-source-maps", NEW, "--flag"]);
  });

  it("preserves other servers in the file", () => {
    const text = JSON.stringify(
      {
        mcpServers: {
          other: { command: "node", args: ["/x/y.js"] },
          "doc-search": { command: "node", args: [STALE] },
        },
      },
      null,
      2,
    );
    const parsed = JSON.parse(repairMcpServerPath(text, NEW)!);
    expect(parsed.mcpServers.other.args).toEqual(["/x/y.js"]);
    expect(parsed.mcpServers["doc-search"].args).toEqual([NEW]);
  });
});

describe("repairMcpJson (fs)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function mkWs(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpjson-"));
    cleanups.push(dir);
    return dir;
  }

  it("rewrites a stale .mcp.json in place and reports true", () => {
    const ws = mkWs();
    const file = path.join(ws, ".mcp.json");
    fs.writeFileSync(file, mcpJson({ command: "node", args: [STALE] }));
    expect(repairMcpJson(ws, NEW)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["doc-search"].args).toEqual([NEW]);
  });

  it("returns false (and writes nothing) when .mcp.json is absent", () => {
    const ws = mkWs();
    expect(repairMcpJson(ws, NEW)).toBe(false);
    expect(fs.existsSync(path.join(ws, ".mcp.json"))).toBe(false);
  });

  it("returns false when already current", () => {
    const ws = mkWs();
    fs.writeFileSync(path.join(ws, ".mcp.json"), mcpJson({ command: "node", args: [NEW] }));
    expect(repairMcpJson(ws, NEW)).toBe(false);
  });
});
