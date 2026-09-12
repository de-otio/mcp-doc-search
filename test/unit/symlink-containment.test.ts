/**
 * Sec 2.3: symlinks inside the workspace (or an external root) must not let
 * the crawl or `get` read outside it. Real filesystem, real symlinks — the
 * mocked-fs suites cannot exercise glob's one-level symlink traversal or
 * realpath's behaviour on a link chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Indexer } from "../../src/core/indexer.js";
import { registerTools } from "../../src/mcp/tools.js";
import { DEFAULT_EXTRA_ROOT_GLOB } from "../../src/core/extraRoots.js";
import type { LanceVectorStore } from "../../src/core/vectorstore.js";
import type { EmbedProvider, IndexerConfig } from "../../src/core/types.js";

/** Build a symlink, or return false where the host forbids them (restricted CI). */
function tryLink(target: string, linkPath: string, kind: "file" | "dir"): boolean {
  try {
    symlinkSync(target, linkPath, kind);
    return true;
  } catch {
    return false;
  }
}

describe("symlink containment (real filesystem)", () => {
  let workspace: string;
  let extRoot: string;
  let outside: string;
  let indexDir: string;
  let store: LanceVectorStore;
  let embedProvider: EmbedProvider;
  let linksOk: boolean;

  function makeIndexer(extra = false): Indexer {
    const config: IndexerConfig = {
      workspaceRoot: workspace,
      docGlob: "doc/**/*.md",
      indexDir,
      maxChunkChars: 4000,
      headingDepth: 2,
      embedProvider,
      extraRoots: extra ? [{ name: "vendor", path: extRoot, glob: DEFAULT_EXTRA_ROOT_GLOB }] : [],
    };
    return new Indexer(config, store);
  }

  /** Register the tools against a real Indexer and return the call handler. */
  function toolHandler(indexer: Indexer): (req: any) => Promise<any> {
    const server = { setRequestHandler: vi.fn() };
    registerTools(server as any, { store, indexer, embedProvider });
    return server.setRequestHandler.mock.calls[1]?.[1];
  }

  beforeEach(() => {
    // The workspace path deliberately stays un-canonicalized: on macOS
    // os.tmpdir() sits under /var -> /private/var, so this also proves a
    // symlinked *root* does not trip the check.
    workspace = mkdtempSync(path.join(os.tmpdir(), "ds-sym-ws-"));
    extRoot = mkdtempSync(path.join(os.tmpdir(), "ds-sym-ext-"));
    outside = mkdtempSync(path.join(os.tmpdir(), "ds-sym-out-"));
    indexDir = mkdtempSync(path.join(os.tmpdir(), "ds-sym-idx-"));

    mkdirSync(path.join(workspace, "doc"), { recursive: true });
    writeFileSync(path.join(workspace, "doc", "real.md"), "# Real\n\nInside.\n");
    writeFileSync(path.join(extRoot, "notes.md"), "# Vendor\n\nInside root.\n");

    // The "secret" material a hostile workspace would try to reach.
    mkdirSync(path.join(outside, "secrets"));
    writeFileSync(path.join(outside, "secret.md"), "# SECRET FILE\n");
    writeFileSync(path.join(outside, "secrets", "key.md"), "# SECRET KEY\n");

    linksOk =
      tryLink(path.join(outside, "secret.md"), path.join(workspace, "doc", "link.md"), "file") &&
      tryLink(path.join(outside, "secrets"), path.join(workspace, "doc", "linkdir"), "dir") &&
      tryLink(path.join(outside, "secret.md"), path.join(extRoot, "link.md"), "file") &&
      tryLink(path.join(outside, "secrets"), path.join(extRoot, "linkdir"), "dir");

    store = {
      deleteByFile: vi.fn(),
      ensureTable: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      listFiles: vi.fn(),
      retainedVersions: vi.fn().mockReturnValue(0),
      compact: vi.fn(),
    } as unknown as LanceVectorStore;
    embedProvider = { embed: vi.fn(async (t: string[]) => t.map(() => [0.1, 0.2, 0.3])) };
  });

  afterEach(() => {
    for (const dir of [workspace, extRoot, outside, indexDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fixture's links resolve outside (sanity: the attack is real)", () => {
    if (!linksOk) return;
    expect(realpathSync(path.join(workspace, "doc", "link.md"))).toBe(
      realpathSync(path.join(outside, "secret.md")),
    );
    expect(realpathSync(path.join(workspace, "doc", "linkdir", "key.md"))).toBe(
      realpathSync(path.join(outside, "secrets", "key.md")),
    );
  });

  it("crawl skips a file symlink and a directory symlink that leave the workspace", async () => {
    if (!linksOk) return;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const status = await makeIndexer().getStatus();
    warn.mockRestore();
    expect(status.totalFiles).toBe(1);

    const stats = await makeIndexer().reindex(true);
    const keys = vi
      .mocked(store.upsert)
      .mock.calls.flatMap((c) => (c[0] as Array<{ file: string }>).map((r) => r.file));
    expect(stats.indexed).toBe(1);
    expect(keys).toEqual(["doc/real.md"]);
  });

  it("crawl applies the same rule to an external root", async () => {
    if (!linksOk) return;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stats = await makeIndexer(true).reindex(true);
    warn.mockRestore();
    const keys = vi
      .mocked(store.upsert)
      .mock.calls.flatMap((c) => (c[0] as Array<{ file: string }>).map((r) => r.file))
      .sort();
    expect(stats.indexed).toBe(2);
    expect(keys).toEqual(["doc/real.md", "ext://vendor/notes.md"]);
  });

  it("get refuses a file symlink that points outside the workspace", async () => {
    if (!linksOk) return;
    const call = toolHandler(makeIndexer());
    const result = await call({ params: { name: "get", arguments: { ref: "doc/link.md" } } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/symlink/i);
    expect(parsed).not.toHaveProperty("content");
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
    expect(JSON.stringify(parsed)).not.toContain(outside);
  });

  it("get refuses a file reached through a symlinked directory", async () => {
    if (!linksOk) return;
    const call = toolHandler(makeIndexer());
    const result = await call({
      params: { name: "get", arguments: { ref: "doc/linkdir/key.md" } },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/symlink/i);
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  it("get refuses the same links under an external root", async () => {
    if (!linksOk) return;
    const call = toolHandler(makeIndexer(true));
    for (const ref of ["ext://vendor/link.md", "ext://vendor/linkdir/key.md"]) {
      const result = await call({ params: { name: "get", arguments: { ref } } });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/symlink/i);
      expect(JSON.stringify(parsed)).not.toContain("SECRET");
    }
  });

  it("multi_get collects the refusal per ref and still returns the good file", async () => {
    if (!linksOk) return;
    const call = toolHandler(makeIndexer());
    const result = await call({
      params: { name: "multi_get", arguments: { refs: "doc/**/*.md" } },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.docs.map((d: { file: string }) => d.file)).toEqual(["doc/real.md"]);
    expect(parsed.errors.map((e: { ref: string }) => e.ref).sort()).toEqual([
      "doc/link.md",
      "doc/linkdir/key.md",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  it("a regular file under a symlinked root still reads (normal request unchanged)", async () => {
    const call = toolHandler(makeIndexer(true));
    for (const [ref, needle] of [
      ["doc/real.md", "Inside."],
      ["ext://vendor/notes.md", "Inside root."],
    ]) {
      const result = await call({ params: { name: "get", arguments: { ref } } });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.content).toContain(needle);
    }
  });
});
