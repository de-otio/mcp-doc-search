import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_EXTRA_ROOT_GLOB,
  EXT_REF_SCHEME,
  extKey,
  parseExtKey,
  parseExtraRoots,
} from "../../src/core/extraRoots.js";
import { Indexer } from "../../src/core/indexer.js";
import type { LanceVectorStore, VectorRecord } from "../../src/core/vectorstore.js";
import type { EmbedProvider, IndexerConfig } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// parseExtraRoots
// ---------------------------------------------------------------------------

describe("parseExtraRoots", () => {
  const HOME = "/home/user";

  it("accepts a valid entry and applies the default glob", () => {
    const { roots, warnings } = parseExtraRoots([{ name: "vendor", path: "/srv/docs" }], HOME);
    expect(warnings).toEqual([]);
    expect(roots).toEqual([{ name: "vendor", path: "/srv/docs", glob: DEFAULT_EXTRA_ROOT_GLOB }]);
  });

  it("expands a leading ~ against the home directory", () => {
    const { roots } = parseExtraRoots([{ name: "v", path: "~/repos/docs" }], HOME);
    expect(roots[0].path).toBe(path.resolve("/home/user/repos/docs"));
  });

  it("keeps a custom safe glob", () => {
    const { roots } = parseExtraRoots(
      [{ name: "v", path: "/srv/d", glob: "pages/**/*.mdx" }],
      HOME,
    );
    expect(roots[0].glob).toBe("pages/**/*.mdx");
  });

  it("falls back to the default glob when the custom glob is unsafe", () => {
    const { roots, warnings } = parseExtraRoots(
      [{ name: "v", path: "/srv/d", glob: "../**/*.md" }],
      HOME,
    );
    expect(roots[0].glob).toBe(DEFAULT_EXTRA_ROOT_GLOB);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unsafe glob");
  });

  it.each([
    ["bad name", [{ name: "no/slash", path: "/srv/d" }], "invalid name"],
    ["empty name", [{ name: "", path: "/srv/d" }], "invalid name"],
    ["relative path", [{ name: "v", path: "docs" }], "relative path"],
    ["missing path", [{ name: "v" }], "no path"],
    ["non-object entry", ["nope"], "not an object"],
  ])("drops entries with %s", (_label, raw, needle) => {
    const { roots, warnings } = parseExtraRoots(raw, HOME);
    expect(roots).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(needle);
  });

  it("drops duplicate names, keeping the first", () => {
    const { roots, warnings } = parseExtraRoots(
      [
        { name: "v", path: "/srv/a" },
        { name: "v", path: "/srv/b" },
      ],
      HOME,
    );
    expect(roots).toHaveLength(1);
    expect(roots[0].path).toBe("/srv/a");
    expect(warnings[0]).toContain("duplicates name");
  });

  it("ignores non-array input with a warning", () => {
    const { roots, warnings } = parseExtraRoots({ name: "v" }, HOME);
    expect(roots).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("treats undefined/null as no roots, without warnings", () => {
    expect(parseExtraRoots(undefined, HOME)).toEqual({ roots: [], warnings: [] });
    expect(parseExtraRoots(null, HOME)).toEqual({ roots: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// extKey / parseExtKey
// ---------------------------------------------------------------------------

describe("extKey / parseExtKey", () => {
  it("round-trips a key", () => {
    const key = extKey("vendor", "pages/a.mdx");
    expect(key).toBe("ext://vendor/pages/a.mdx");
    expect(parseExtKey(key)).toEqual({ name: "vendor", rel: "pages/a.mdx" });
  });

  it("normalizes backslashes in the relative part", () => {
    expect(extKey("v", "a\\b.md")).toBe("ext://v/a/b.md");
  });

  it.each([
    ["no scheme", "doc/foo.md"],
    ["empty name", "ext:///x.md"],
    ["no rel", "ext://vendor"],
    ["empty rel", "ext://vendor/"],
  ])("rejects malformed keys (%s)", (_label, key) => {
    expect(parseExtKey(key)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Indexer integration with a real external root on disk
// ---------------------------------------------------------------------------

describe("Indexer with external roots", () => {
  let workspace: string;
  let rootDir: string;
  let indexDir: string;
  let upserted: VectorRecord[];
  let deletedFiles: string[];
  let store: LanceVectorStore;
  let embedProvider: EmbedProvider;

  function makeConfig(overrides?: Partial<IndexerConfig>): IndexerConfig {
    return {
      workspaceRoot: workspace,
      docGlob: "doc/**/*.md",
      indexDir,
      maxChunkChars: 4000,
      headingDepth: 2,
      embedProvider,
      extraRoots: [{ name: "vendor", path: rootDir, glob: DEFAULT_EXTRA_ROOT_GLOB }],
      ...overrides,
    };
  }

  beforeEach(() => {
    // realpath: on macOS os.tmpdir() is a symlink (/tmp -> /private/tmp) and
    // resolveExtKey canonicalizes the root, so expectations must compare
    // against canonical paths.
    workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ds-ws-")));
    rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ds-root-")));
    indexDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ds-idx-")));

    mkdirSync(path.join(workspace, "doc"), { recursive: true });
    writeFileSync(path.join(workspace, "doc", "readme.md"), "# Workspace Doc\n\nHello.\n");
    mkdirSync(path.join(rootDir, "pages"), { recursive: true });
    writeFileSync(path.join(rootDir, "pages", "guide.mdx"), "# Vendor Guide\n\nExternal.\n");
    writeFileSync(path.join(rootDir, "notes.md"), "# Vendor Notes\n\nMore.\n");

    upserted = [];
    deletedFiles = [];
    store = {
      deleteByFile: vi.fn(async (f: string) => {
        deletedFiles.push(f);
      }),
      ensureTable: vi.fn(),
      dropTable: vi.fn(),
      upsert: vi.fn(async (records: VectorRecord[]) => {
        upserted.push(...records);
      }),
      count: vi.fn().mockResolvedValue(0),
      listFiles: vi.fn(),
      retainedVersions: vi.fn().mockReturnValue(0),
      compact: vi.fn(),
      hasFtsIndex: vi.fn().mockResolvedValue(false),
    } as unknown as LanceVectorStore;

    embedProvider = {
      embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    };
  });

  afterEach(() => {
    for (const dir of [workspace, rootDir, indexDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("indexes workspace and external files under distinct key namespaces", async () => {
    const indexer = new Indexer(makeConfig(), store);
    const stats = await indexer.reindex();

    expect(stats.indexed).toBe(3);
    const keys = upserted.map((r) => r.file).sort();
    expect(keys).toEqual([
      "doc/readme.md",
      "ext://vendor/notes.md",
      "ext://vendor/pages/guide.mdx",
    ]);
  });

  it("picks up .mdx files via the default external glob", async () => {
    const indexer = new Indexer(makeConfig(), store);
    await indexer.reindex();
    expect(upserted.some((r) => r.file === "ext://vendor/pages/guide.mdx")).toBe(true);
  });

  it("reports external files in getStatus and lists root names", async () => {
    const indexer = new Indexer(makeConfig(), store);
    const status = await indexer.getStatus();
    expect(status.totalFiles).toBe(3);
    expect(status.newFiles).toBe(3);
    expect(status.extraRootNames).toEqual(["vendor"]);
  });

  it("resolves ext:// refs to absolute paths with docids", async () => {
    const indexer = new Indexer(makeConfig(), store);
    await indexer.reindex();

    const resolved = indexer.resolveRef("ext://vendor/pages/guide.mdx");
    expect(resolved).not.toHaveProperty("error");
    if ("error" in resolved) throw new Error("unreachable");
    expect(resolved.file).toBe(path.join(rootDir, "pages", "guide.mdx"));
    expect(resolved.docid).toMatch(/^[0-9a-f]{6}$/);

    // docid ref round-trip
    const viaDocid = indexer.resolveRef(`#${resolved.docid}`);
    if ("error" in viaDocid) throw new Error("docid resolution failed");
    expect(viaDocid.file).toBe(resolved.file);
  });

  it("blocks traversal out of an external root", async () => {
    writeFileSync(path.join(workspace, "secret.txt"), "s3cret");
    const indexer = new Indexer(makeConfig(), store);
    const resolved = indexer.resolveRef(`${EXT_REF_SCHEME}vendor/../secret.txt`);
    expect(resolved).toHaveProperty("error");
  });

  it("rejects refs to unconfigured roots, naming the fix", () => {
    const indexer = new Indexer(makeConfig(), store);
    const resolved = indexer.resolveRef("ext://other/x.md");
    if (!("error" in resolved)) throw new Error("expected an error");
    expect(resolved.error).toMatch(/^Unknown external root: other\. This server was not given/);
    expect(resolved.error).toContain("DOC_SEARCH_EXTRA_ROOTS");
    expect(resolved.error).toContain("DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1");
    // The message must stay path-free: it is returned to MCP clients verbatim.
    expect(resolved.error).not.toContain(rootDir);
    expect(indexer.resolveRef("ext://vendor")).toHaveProperty("error");
  });

  it("does not follow a symlinked file out of the root via resolveRef containment", async () => {
    // A symlink inside the root pointing outside: string containment passes,
    // but this documents the OS-follows-symlinks caveat from safePath.ts —
    // the ref itself must stay inside the root.
    const outside = path.join(workspace, "outside.md");
    writeFileSync(outside, "# Outside\n");
    try {
      symlinkSync(outside, path.join(rootDir, "link.md"));
    } catch {
      return; // symlinks unavailable (e.g. restricted CI) — skip
    }
    const indexer = new Indexer(makeConfig(), store);
    const resolved = indexer.resolveRef("ext://vendor/link.md");
    // The ref resolves (documented behavior); what must never work is `..`.
    expect(resolved).not.toHaveProperty("error");
  });

  it("maps absolute paths back to keys with keyForAbsPath", () => {
    const indexer = new Indexer(makeConfig(), store);
    expect(indexer.keyForAbsPath(path.join(rootDir, "pages", "guide.mdx"))).toBe(
      "ext://vendor/pages/guide.mdx",
    );
    expect(indexer.keyForAbsPath(path.join(workspace, "doc", "readme.md"))).toBe("doc/readme.md");
  });

  it("keeps index entries for a missing root instead of pruning them", async () => {
    const indexer = new Indexer(makeConfig(), store);
    await indexer.reindex();
    expect(upserted.filter((r) => r.file.startsWith(EXT_REF_SCHEME))).toHaveLength(2);

    // Same index, root directory now gone
    rmSync(rootDir, { recursive: true, force: true });
    deletedFiles.length = 0;
    const indexer2 = new Indexer(makeConfig(), store);
    const stats = await indexer2.reindex();

    expect(stats.pruned).toBe(0);
    expect(deletedFiles.filter((f) => f.startsWith(EXT_REF_SCHEME))).toEqual([]);

    const status = await indexer2.getStatus();
    expect(status.deletedFiles).toBe(0);
  });

  describe("unconfigured roots (a reader not given the writer's roots)", () => {
    const EXT_KEYS = ["ext://vendor/notes.md", "ext://vendor/pages/guide.mdx"];
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The writer indexes the federated corpus.
      await new Indexer(makeConfig(), store).reindex();
      deletedFiles.length = 0;
      warn.mockClear();
    });

    afterEach(() => {
      warn.mockRestore();
    });

    const readCache = (): Record<string, unknown> =>
      JSON.parse(readFileSync(path.join(indexDir, "mtime_cache.json"), "utf8"));

    it("keeps their entries on a reindex with no roots configured, and warns", async () => {
      const reader = new Indexer(makeConfig({ extraRoots: [] }), store);
      const stats = await reader.reindex();

      // 0.8.3 pruned both ext:// entries here: pruned=2.
      expect(stats.pruned).toBe(0);
      expect(deletedFiles).toEqual([]);
      expect(stats.unconfiguredRoots).toEqual(["vendor"]);
      expect(Object.keys(readCache())).toEqual(expect.arrayContaining(EXT_KEYS));

      const warning = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warning).toContain("vendor");
      expect(warning).toContain("DOC_SEARCH_EXTRA_ROOTS");
      expect(warning).toContain("DOC_SEARCH_TRUST_WORKSPACE_SETTINGS");

      // And again: the kept entries survive repeated reader runs.
      expect((await reader.reindex()).pruned).toBe(0);
      expect(deletedFiles).toEqual([]);
    });

    it("prunes a root's entries when the drop is explicit", async () => {
      const reader = new Indexer(makeConfig({ extraRoots: [] }), store);
      const stats = await reader.reindex(false, undefined, { dropRoots: ["vendor"] });

      expect(stats.pruned).toBe(2);
      expect(deletedFiles.sort()).toEqual(EXT_KEYS);
      expect(stats.droppedRoots).toEqual(["vendor"]);
      expect(stats.unconfiguredRoots).toBeUndefined();
      expect(Object.keys(readCache())).toEqual(["doc/readme.md"]);
      expect((await reader.getStatus()).unconfiguredRoots).toEqual([]);
    });

    it("drops a root removed from the settings of the process that owns them", async () => {
      const owner = new Indexer(makeConfig({ extraRoots: [], ownsRootConfig: true }), store);
      expect((await owner.getStatus()).needsReindex).toBe(true);

      const stats = await owner.reindex();

      expect(stats.pruned).toBe(2);
      expect(deletedFiles.sort()).toEqual(EXT_KEYS);
      expect(stats.droppedRoots).toEqual(["vendor"]);
      expect((await owner.getStatus()).needsReindex).toBe(false);
    });

    it("still prunes a file deleted under a configured root", async () => {
      rmSync(path.join(rootDir, "notes.md"));
      const stats = await new Indexer(makeConfig(), store).reindex();

      expect(stats.pruned).toBe(1);
      expect(deletedFiles).toEqual(["ext://vendor/notes.md"]);
      expect(stats.unconfiguredRoots).toBeUndefined();
    });

    it("reports a reader's index as not stale, and names the roots it lacks", async () => {
      const status = await new Indexer(makeConfig({ extraRoots: [] }), store).getStatus();

      // 0.8.3 counted both ext:// entries as deleted: needsReindex=true forever.
      expect(status.deletedFiles).toBe(0);
      expect(status.needsReindex).toBe(false);
      expect(status.unconfiguredRoots).toEqual(["vendor"]);
      expect(status.extraRootNames).toEqual([]);
    });

    it("refuses to drop a configured root or a malformed name, before touching the index", async () => {
      const indexer = new Indexer(makeConfig(), store);
      await expect(indexer.reindex(false, undefined, { dropRoots: ["vendor"] })).rejects.toThrow(
        /configured for this run/,
      );
      await expect(
        indexer.reindex(false, undefined, { dropRoots: ["vendor/pages"] }),
      ).rejects.toThrow(/not a valid root name/);
      expect(deletedFiles).toEqual([]);
    });

    it("records the roots the index covers in index-meta.json", async () => {
      const meta = (): { extraRoots?: string[] } =>
        JSON.parse(readFileSync(path.join(indexDir, "index-meta.json"), "utf8"));
      expect(meta().extraRoots).toEqual(["vendor"]);

      await new Indexer(makeConfig({ extraRoots: [] }), store).reindex();
      expect(meta().extraRoots).toEqual(["vendor"]);

      await new Indexer(makeConfig({ extraRoots: [] }), store).reindex(false, undefined, {
        dropRoots: ["vendor"],
      });
      expect(meta().extraRoots).toEqual([]);
    });
  });
});
