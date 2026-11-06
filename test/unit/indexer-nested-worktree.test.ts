/**
 * Regression for the "nested worktree" suggestion in #117: a linked worktree
 * (or any repo copy) under a dot-folder inside the workspace must not be
 * scanned. Real filesystem and real glob; the mocked-fs indexer suite cannot
 * show what glob's dot handling and anchoring actually do.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Indexer } from "../../src/core/indexer.js";
import type { LanceVectorStore } from "../../src/core/vectorstore.js";
import type { EmbedProvider } from "../../src/core/types.js";

describe("nested worktree under a dot-folder (real filesystem)", () => {
  let workspace: string;
  let indexDir: string;
  let store: LanceVectorStore;
  let embedProvider: EmbedProvider;

  function makeIndexer(docGlob: string): Indexer {
    return new Indexer(
      {
        workspaceRoot: workspace,
        docGlob,
        indexDir,
        maxChunkChars: 4000,
        headingDepth: 2,
        embedProvider,
      },
      store,
    );
  }

  async function indexedKeys(docGlob: string): Promise<string[]> {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await makeIndexer(docGlob).reindex(true);
    warn.mockRestore();
    return vi
      .mocked(store.upsert)
      .mock.calls.flatMap((c) => (c[0] as Array<{ file: string }>).map((r) => r.file))
      .sort();
  }

  beforeEach(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "ds-wt-ws-"));
    indexDir = mkdtempSync(path.join(os.tmpdir(), "ds-wt-idx-"));

    mkdirSync(path.join(workspace, "doc"), { recursive: true });
    writeFileSync(path.join(workspace, "doc", "a.md"), "# Real\n\nWorkspace doc.\n");

    // A linked worktree: its own doc/ tree plus a `.git` FILE pointing at the
    // main repository, as a worktree checkout lays it out.
    const wt = path.join(workspace, ".worktrees", "copy");
    mkdirSync(path.join(wt, "doc"), { recursive: true });
    writeFileSync(path.join(wt, ".git"), "gitdir: ../../.git/worktrees/copy\n");
    writeFileSync(path.join(wt, "doc", "a.md"), "# Copy\n\nWorktree doc.\n");

    store = {
      deleteByFile: vi.fn(),
      ensureTable: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      listFiles: vi.fn(),
      retainedVersions: vi.fn().mockReturnValue(0),
      compact: vi.fn(),
      hasFtsIndex: vi.fn().mockResolvedValue(false),
    } as unknown as LanceVectorStore;
    embedProvider = { embed: vi.fn(async (t: string[]) => t.map(() => [0.1, 0.2, 0.3])) };
  });

  afterEach(() => {
    for (const dir of [workspace, indexDir]) rmSync(dir, { recursive: true, force: true });
  });

  it("indexes only doc/a.md with the default docGlob", async () => {
    expect(await indexedKeys("doc/**/*.md")).toEqual(["doc/a.md"]);
  });

  it("status counts only the workspace's own file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const status = await makeIndexer("doc/**/*.md").getStatus();
    warn.mockRestore();
    expect(status.totalFiles).toBe(1);
  });

  it("still skips the dot-folder worktree under a broad **/*.md glob", async () => {
    expect(await indexedKeys("**/*.md")).toEqual(["doc/a.md"]);
  });
});
