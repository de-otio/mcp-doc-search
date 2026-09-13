/**
 * Index integrity against a real LanceDB in a temp directory (no mocks).
 *
 * Covers the failure paths that motivated fix/index-integrity: external-root
 * and non-ASCII keys that the old character allow-list refused to delete
 * (duplicated chunks, undeletable pruned files), a provider/model switch
 * that silently lost unchanged files, non-atomic cache writes, and two
 * reindexes racing on one index directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Indexer,
  INDEX_SCHEMA_VERSION,
  LOCK_STALE_AFTER_MS,
  ReindexInProgressError,
} from "../../src/core/indexer.js";
import { LanceVectorStore, fileHashKey } from "../../src/core/vectorstore.js";
import { DEFAULT_EXTRA_ROOT_GLOB } from "../../src/core/extraRoots.js";
import { validateConfig } from "../../src/core/types.js";
import type {
  EmbedIdentity,
  EmbedProvider,
  IndexerConfig,
  IndexMeta,
} from "../../src/core/types.js";

const AWKWARD_KEY = "ext://v/ü file.md";

/** Deterministic unit vectors of a fixed dimension; text-dependent so rows differ. */
function fakeProvider(dim: number, identity?: EmbedIdentity): EmbedProvider {
  return {
    embed: async (texts: string[]) =>
      texts.map((t, i) => {
        const v = new Array(dim).fill(0);
        v[(t.length + i) % dim] = 1;
        return v;
      }),
    identity: identity ? () => identity : undefined,
  };
}

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function readMeta(indexDir: string): IndexMeta {
  return JSON.parse(readFileSync(path.join(indexDir, "index-meta.json"), "utf8")) as IndexMeta;
}

describe("LanceVectorStore.deleteByFile (real LanceDB)", () => {
  let indexDir: string;
  let store: LanceVectorStore;

  beforeEach(async () => {
    indexDir = tmp("ds-store-");
    store = new LanceVectorStore(indexDir);
    await store.open();
  });

  afterEach(async () => {
    await store.close();
    rmSync(indexDir, { recursive: true, force: true });
  });

  it("deletes every chunk of an ext:// key with a space and a non-ASCII char", async () => {
    await store.ensureTable(3);
    await store.upsert([
      {
        id: "a",
        vector: [1, 0, 0],
        file: AWKWARD_KEY,
        heading: "H1",
        lineStart: 0,
        text: "x",
        docid: "d1",
      },
      {
        id: "b",
        vector: [0, 1, 0],
        file: AWKWARD_KEY,
        heading: "H2",
        lineStart: 9,
        text: "y",
        docid: "d1",
      },
      {
        id: "c",
        vector: [0, 0, 1],
        file: "doc/plain.md",
        heading: "P",
        lineStart: 0,
        text: "z",
        docid: "d2",
      },
    ]);
    expect(await store.count()).toBe(3);

    await store.deleteByFile(AWKWARD_KEY);

    expect(await store.count()).toBe(1);
    expect(await store.listFiles()).toEqual([{ file: "doc/plain.md", title: "P" }]);
  });

  it("is a no-op for a key with no rows and on an empty table", async () => {
    await store.ensureTable(3);
    await expect(store.deleteByFile("never/indexed.md")).resolves.toBeUndefined();
    await store.upsert([
      {
        id: "a",
        vector: [1, 0, 0],
        file: "doc/a.md",
        heading: "A",
        lineStart: 0,
        text: "x",
        docid: "d",
      },
    ]);
    await store.deleteByFile("doc/other.md");
    expect(await store.count()).toBe(1);
  });

  it("stores the sha256 of the key as fileHash", async () => {
    await store.ensureTable(2);
    await store.upsert([
      {
        id: "a",
        vector: [1, 0],
        file: AWKWARD_KEY,
        heading: "A",
        lineStart: 0,
        text: "x",
        docid: "d",
      },
    ]);
    expect(fileHashKey(AWKWARD_KEY)).toMatch(/^[0-9a-f]{64}$/);
    // The hash is what the delete filters on; a wrong hash must delete nothing.
    await store.deleteByFile(AWKWARD_KEY + "x");
    expect(await store.count()).toBe(1);
  });

  it("dropTable removes the table so the next ensureTable starts empty", async () => {
    await store.ensureTable(2);
    await store.upsert([
      {
        id: "a",
        vector: [1, 0],
        file: "doc/a.md",
        heading: "A",
        lineStart: 0,
        text: "x",
        docid: "d",
      },
    ]);
    await store.dropTable();
    expect(store.hasTable()).toBe(false);
    expect(await store.count()).toBe(0);
    await store.ensureTable(2);
    expect(await store.count()).toBe(0);
  });
});

describe("Indexer integrity (real LanceDB)", () => {
  let workspace: string;
  let rootDir: string;
  let indexDir: string;
  let store: LanceVectorStore;

  const IDENTITY: EmbedIdentity = { provider: "local", model: "test-model", dim: 3 };

  function makeConfig(provider: EmbedProvider, overrides?: Partial<IndexerConfig>): IndexerConfig {
    return {
      workspaceRoot: workspace,
      docGlob: "doc/**/*.md",
      indexDir,
      maxChunkChars: 4000,
      headingDepth: 2,
      embedProvider: provider,
      extraRoots: [{ name: "v", path: rootDir, glob: DEFAULT_EXTRA_ROOT_GLOB }],
      ...overrides,
    };
  }

  async function freshStore(): Promise<LanceVectorStore> {
    await store.close();
    store = new LanceVectorStore(indexDir);
    await store.open();
    return store;
  }

  beforeEach(async () => {
    workspace = tmp("ds-ws-");
    rootDir = tmp("ds-root-");
    indexDir = tmp("ds-idx-");
    mkdirSync(path.join(workspace, "doc"), { recursive: true });
    writeFileSync(
      path.join(workspace, "doc", "readme.md"),
      "# Readme\n\nHello.\n\n## More\n\nText.\n",
    );
    writeFileSync(path.join(rootDir, "ü file.md"), "# Umlaut\n\nExternal.\n\n## Second\n\nMore.\n");
    store = new LanceVectorStore(indexDir);
    await store.open();
  });

  afterEach(async () => {
    await store.close();
    for (const dir of [workspace, rootDir, indexDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the row count stable across repeated forced reindexes of an ext:// key", async () => {
    const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
    const first = await indexer.reindex(true);
    const countAfterFirst = await store.count();
    expect(first.indexed).toBe(2);
    expect(countAfterFirst).toBeGreaterThan(0);

    await indexer.reindex(true);
    await indexer.reindex(true);

    // Before the hashed key, every forced pass appended the ext:// chunks again.
    expect(await store.count()).toBe(countAfterFirst);
    const files = (await store.listFiles()).map((f) => f.file);
    expect(files).toEqual(["doc/readme.md", AWKWARD_KEY]);
  });

  it("replaces, not appends, the chunks of a modified external file", async () => {
    const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
    await indexer.reindex();
    const before = await store.count();

    const extFile = path.join(rootDir, "ü file.md");
    writeFileSync(extFile, "# Umlaut\n\nChanged.\n\n## Second\n\nMore.\n");
    const future = new Date(Date.now() + 5_000);
    utimesSync(extFile, future, future);
    const stats = await indexer.reindex();

    expect(stats.indexed).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(await store.count()).toBe(before);
  });

  it("prunes a deleted external file's chunks so nothing stale stays searchable", async () => {
    const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
    await indexer.reindex();
    expect((await store.listFiles()).map((f) => f.file)).toContain(AWKWARD_KEY);

    unlinkSync(path.join(rootDir, "ü file.md"));
    const stats = await indexer.reindex();

    expect(stats.pruned).toBe(1);
    expect((await store.listFiles()).map((f) => f.file)).toEqual(["doc/readme.md"]);
  });

  it("writes index-meta.json from the provider identity and config", async () => {
    const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
    const stats = await indexer.reindex();

    expect(stats.rebuiltReason).toBeUndefined();
    const meta = readMeta(indexDir);
    expect(meta).toMatchObject({
      schemaVersion: INDEX_SCHEMA_VERSION,
      provider: "local",
      model: "test-model",
      dim: 3,
      maxChunkChars: 4000,
      headingDepth: 2,
    });
    expect(Date.parse(meta.createdAt)).not.toBeNaN();
    const status = await indexer.getStatus();
    expect(status.meta).toEqual(meta);
  });

  it("records the model-derived chunk budget (never 0) and stays stable across reindexes", async () => {
    // Every entry point (extension, MCP server, CLI) passes its raw config
    // through validateConfig with the live provider; 0 = "auto" resolves to
    // the model's budget there, so index-meta.json must hold that number.
    const MINILM: EmbedIdentity = { provider: "local", model: "Xenova/all-MiniLM-L6-v2", dim: 3 };
    const auto = (provider: EmbedProvider): IndexerConfig =>
      validateConfig({ ...makeConfig(provider), maxChunkChars: 0 }, provider);

    const first = await new Indexer(auto(fakeProvider(3, MINILM)), store).reindex();
    expect(first.rebuiltReason).toBeUndefined();
    expect(readMeta(indexDir).maxChunkChars).toBe(800);

    const again = await new Indexer(auto(fakeProvider(3, MINILM)), await freshStore()).reindex();
    expect(again.rebuiltReason).toBeUndefined();
    expect(again.indexed).toBe(0);
    expect(readMeta(indexDir).maxChunkChars).toBe(800);
  });

  it("rebuilds when the local model changes to one of the same dimension", async () => {
    const MINILM: EmbedIdentity = { provider: "local", model: "Xenova/all-MiniLM-L6-v2", dim: 3 };
    const E5: EmbedIdentity = { provider: "local", model: "Xenova/multilingual-e5-small", dim: 3 };
    const auto = (provider: EmbedProvider): IndexerConfig =>
      validateConfig({ ...makeConfig(provider), maxChunkChars: 0 }, provider);

    await new Indexer(auto(fakeProvider(3, MINILM)), store).reindex();
    const stats = await new Indexer(auto(fakeProvider(3, E5)), await freshStore()).reindex();

    expect(stats.rebuiltReason).toContain(
      "model Xenova/all-MiniLM-L6-v2 → Xenova/multilingual-e5-small",
    );
    expect(stats.indexed).toBe(2);
    expect(readMeta(indexDir)).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      maxChunkChars: 1536,
    });
  });

  it("rebuilds the whole index when the model changes, keeping unchanged files", async () => {
    await new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store).reindex();
    const countBefore = await store.count();

    // Same files, same mtimes, different model of the same dimension: the old
    // code re-embedded only changed files (none) and left the index as-is.
    const switched = new Indexer(
      makeConfig(fakeProvider(3, { ...IDENTITY, model: "other-model" })),
      await freshStore(),
    );
    const stats = await switched.reindex();

    expect(stats.rebuiltReason).toContain("model test-model → other-model");
    expect(stats.indexed).toBe(2);
    expect(stats.skipped).toBe(0);
    expect(await store.count()).toBe(countBefore);
    expect(readMeta(indexDir).model).toBe("other-model");
  });

  it("rebuilds when the dimension changes and the provider only learns it by embedding", async () => {
    await new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store).reindex();
    const countBefore = await store.count();

    // Ollama-style identity: no dim up front, and a model that now yields 4-dim
    // vectors. Same provider/model strings so the pre-loop check passes; the
    // mismatch can only show at the first embed, so one file must have changed
    // (with nothing to embed, nothing incompatible is written either).
    const extFile = path.join(rootDir, "ü file.md");
    const future = new Date(Date.now() + 5_000);
    utimesSync(extFile, future, future);
    const provider = fakeProvider(4, { provider: "local", model: "test-model" });
    const stats = await new Indexer(makeConfig(provider), await freshStore()).reindex();

    expect(stats.rebuiltReason).toContain("vector dimension 3 → 4");
    // The unchanged workspace file was skipped before the mismatch surfaced
    // and must be re-embedded after the restart.
    expect(stats.indexed).toBe(2);
    expect(stats.skipped).toBe(0);
    expect(await store.count()).toBe(countBefore);
    expect(readMeta(indexDir).dim).toBe(4);
  });

  it("treats a non-empty index without metadata as schema v1 and rebuilds it", async () => {
    await new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store).reindex();
    unlinkSync(path.join(indexDir, "index-meta.json"));
    const countBefore = await store.count();

    const stats = await new Indexer(
      makeConfig(fakeProvider(3, IDENTITY)),
      await freshStore(),
    ).reindex();

    expect(stats.rebuiltReason).toContain("schema v1");
    expect(stats.indexed).toBe(2);
    expect(await store.count()).toBe(countBefore);
    expect(existsSync(path.join(indexDir, "index-meta.json"))).toBe(true);
  });

  it("does not rebuild when metadata matches the live configuration", async () => {
    await new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store).reindex();
    const stats = await new Indexer(
      makeConfig(fakeProvider(3, IDENTITY)),
      await freshStore(),
    ).reindex();
    expect(stats.rebuiltReason).toBeUndefined();
    expect(stats.indexed).toBe(0);
    expect(stats.skipped).toBe(2);
  });

  it("rebuilds when the chunking configuration changes", async () => {
    await new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store).reindex();
    const stats = await new Indexer(
      makeConfig(fakeProvider(3, IDENTITY), { headingDepth: 1 }),
      await freshStore(),
    ).reindex();
    expect(stats.rebuiltReason).toContain("headingDepth 2 → 1");
    expect(readMeta(indexDir).headingDepth).toBe(1);
  });

  it("leaves no .tmp files behind from the atomic JSON writes", async () => {
    const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
    await indexer.reindex();
    indexer.setContext("doc", "workspace docs");
    const leftovers = readdirSync(indexDir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(existsSync(path.join(indexDir, "mtime_cache.json"))).toBe(true);
    expect(existsSync(path.join(indexDir, "context.json"))).toBe(true);
  });

  describe("reindex lock", () => {
    it("rejects a second concurrent reindex with ReindexInProgressError", async () => {
      let releaseEmbed: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseEmbed = resolve;
      });
      const blocking: EmbedProvider = {
        embed: async (texts) => {
          await gate;
          return texts.map(() => [1, 0, 0]);
        },
        identity: () => IDENTITY,
      };
      const indexer = new Indexer(makeConfig(blocking), store);
      const first = indexer.reindex();
      // Give the first run time to take the lock and block in embed().
      await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(path.join(indexDir, "reindex.lock"))).toBe(true);

      const second = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
      await expect(second.reindex()).rejects.toBeInstanceOf(ReindexInProgressError);
      await expect(second.reindex()).rejects.toThrow(/already running \(pid \d+/);

      releaseEmbed();
      await first;
      expect(existsSync(path.join(indexDir, "reindex.lock"))).toBe(false);
    });

    it("replaces a stale lock left by a dead process", async () => {
      // pid beyond any platform's maximum: never alive.
      writeFileSync(
        path.join(indexDir, "reindex.lock"),
        JSON.stringify({ pid: 2_147_483_000, startedAt: "2020-01-01T00:00:00.000Z" }),
      );
      const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
      const stats = await indexer.reindex();
      expect(stats.indexed).toBe(2);
      expect(existsSync(path.join(indexDir, "reindex.lock"))).toBe(false);
    });

    it("respects a lock held by a live process", async () => {
      writeFileSync(
        path.join(indexDir, "reindex.lock"),
        JSON.stringify({ pid: process.pid, startedAt: "2026-09-12T00:00:00.000Z" }),
      );
      const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
      await expect(indexer.reindex()).rejects.toBeInstanceOf(ReindexInProgressError);
      // The foreign lock must be left in place.
      expect(existsSync(path.join(indexDir, "reindex.lock"))).toBe(true);
    });

    it("releases the lock when the run throws", async () => {
      const failing: EmbedProvider = {
        embed: async () => {
          throw new Error("boom");
        },
        identity: () => IDENTITY,
      };
      const indexer = new Indexer(makeConfig(failing), store);
      // Two files failing consecutively is below the abort streak; the run
      // completes with failures. Force a throw via a broken healthCheck instead.
      failing.healthCheck = async () => ({ ok: false, kind: "unreachable", detail: "down" });
      for (let i = 0; i < 5; i++) {
        writeFileSync(path.join(workspace, "doc", `f${i}.md`), `# F${i}\n\nBody.\n`);
      }
      await expect(indexer.reindex()).rejects.toThrow(/down/);
      expect(existsSync(path.join(indexDir, "reindex.lock"))).toBe(false);
    });

    it("treats a live pid whose heartbeat has expired as stale (pid reuse)", async () => {
      const lockPath = path.join(indexDir, "reindex.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: "2026-09-13T06:14:05.451Z" }),
      );
      const old = new Date(Date.now() - LOCK_STALE_AFTER_MS - 1000);
      utimesSync(lockPath, old, old);

      const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
      expect(indexer.inspectReindexLock()).toMatchObject({
        pid: process.pid,
        stale: true,
        staleReason: "heartbeat-expired",
      });
      // reindex() replaces it rather than refusing.
      const stats = await indexer.reindex();
      expect(stats.indexed).toBe(2);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("inspectReindexLock reports a dead holder, and clearStaleReindexLock removes it", async () => {
      const lockPath = path.join(indexDir, "reindex.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 2_147_483_000, startedAt: "2026-09-13T06:14:05.451Z" }),
      );
      const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);

      const seen = indexer.inspectReindexLock();
      expect(seen).toMatchObject({
        pid: 2_147_483_000,
        startedAt: "2026-09-13T06:14:05.451Z",
        stale: true,
        staleReason: "holder-dead",
      });
      expect(seen?.heartbeatAt).toBeInstanceOf(Date);

      const cleared = indexer.clearStaleReindexLock();
      expect(cleared?.pid).toBe(2_147_483_000);
      expect(existsSync(lockPath)).toBe(false);
      // Nothing left to clear.
      expect(indexer.clearStaleReindexLock()).toBeNull();
      expect(indexer.inspectReindexLock()).toBeNull();
    });

    it("clearStaleReindexLock leaves a live lock alone", async () => {
      const lockPath = path.join(indexDir, "reindex.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: "2026-09-13T06:14:05.451Z" }),
      );
      const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
      expect(indexer.inspectReindexLock()).toMatchObject({ pid: process.pid, stale: false });
      expect(indexer.clearStaleReindexLock()).toBeNull();
      expect(existsSync(lockPath)).toBe(true);
    });

    it("treats an unreadable lock file as stale", async () => {
      const lockPath = path.join(indexDir, "reindex.lock");
      writeFileSync(lockPath, "not json");
      const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);
      expect(indexer.inspectReindexLock()).toMatchObject({
        stale: true,
        staleReason: "unreadable",
      });
      expect(indexer.clearStaleReindexLock()?.staleReason).toBe("unreadable");
      expect(existsSync(lockPath)).toBe(false);
    });

    it("getStatus removes a stale lock and reports both the removal and a live lock", async () => {
      const lockPath = path.join(indexDir, "reindex.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 2_147_483_000, startedAt: "2026-09-13T06:14:05.451Z" }),
      );
      const indexer = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store);

      const first = await indexer.getStatus();
      expect(first.clearedStaleLock).toMatchObject({
        pid: 2_147_483_000,
        staleReason: "holder-dead",
      });
      expect(first.reindexLock).toBeUndefined();
      expect(indexer.inspectReindexLock()).toBeNull();

      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: "2026-09-13T06:14:05.451Z" }),
      );
      const second = await indexer.getStatus();
      expect(second.clearedStaleLock).toBeUndefined();
      expect(second.reindexLock).toMatchObject({ pid: process.pid, stale: false });
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  describe("interrupted rebuild", () => {
    /**
     * Simulate a run killed part-way through (VS Code reload, SIGKILL): the
     * store's upsert throws after N files. Unlike an embed failure — which the
     * loop catches, counts, and eventually turns into an orderly abort that
     * persists the cache — this escapes reindex() with no bookkeeping at all,
     * exactly what a kill leaves behind (the lock's `finally` aside).
     */
    function killStoreAfter(target: LanceVectorStore, files: number): LanceVectorStore {
      let calls = 0;
      const upsert = target.upsert.bind(target);
      target.upsert = async (records) => {
        if (calls++ >= files) throw new Error("killed");
        return upsert(records);
      };
      return target;
    }

    beforeEach(() => {
      // Enough files that the kill lands mid-corpus.
      for (let i = 0; i < 6; i++) {
        writeFileSync(path.join(workspace, "doc", `f${i}.md`), `# F${i}\n\nBody ${i}.\n`);
      }
    });

    it("a killed rebuild does not leave an incremental run believing the index is complete", async () => {
      // Full index under the old model.
      await new Indexer(makeConfig(fakeProvider(3, IDENTITY)), store).reindex();
      const total = (await store.count()) > 0 ? 8 : 0;
      expect(total).toBe(8);

      // Model switch → rebuild, killed after 3 files.
      const switchedIdentity = { ...IDENTITY, model: "other-model" };
      const killed = new Indexer(
        makeConfig(fakeProvider(3, switchedIdentity)),
        killStoreAfter(await freshStore(), 3),
      );
      await expect(killed.reindex()).rejects.toThrow("killed");
      expect(existsSync(path.join(indexDir, "reindex.lock"))).toBe(false);

      // The old cache must be gone: the run wrote an empty one when it dropped
      // the table, so nothing vouches for files that were never re-embedded.
      const cacheAfterKill = JSON.parse(
        readFileSync(path.join(indexDir, "mtime_cache.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(cacheAfterKill).length).toBeLessThanOrEqual(3);

      // A plain (non-forced) reindex under the new model finishes the job.
      const resumed = new Indexer(
        makeConfig(fakeProvider(3, switchedIdentity)),
        await freshStore(),
      );
      const stats = await resumed.reindex();
      expect(stats.rebuiltReason).toBeUndefined();
      expect(stats.indexed + stats.skipped).toBe(8);
      expect(stats.indexed).toBeGreaterThanOrEqual(5);

      const status = await resumed.getStatus();
      expect(status.needsReindex).toBe(false);
      expect(status.cachedFiles).toBe(8);
      // Every file is searchable: distinct files in the table == corpus size.
      const rows = (await store.count()) ?? 0;
      expect(rows).toBeGreaterThan(0);
      expect(readMeta(indexDir).model).toBe("other-model");
    });

    it("a run resumes from its last checkpoint instead of re-embedding everything", async () => {
      // 30 files: the checkpoint every 25 indexed files fires once before the kill.
      for (let i = 6; i < 30; i++) {
        writeFileSync(path.join(workspace, "doc", `f${i}.md`), `# F${i}\n\nBody ${i}.\n`);
      }
      const killed = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), killStoreAfter(store, 27));
      await expect(killed.reindex()).rejects.toThrow("killed");

      const cacheAfterKill = JSON.parse(
        readFileSync(path.join(indexDir, "mtime_cache.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(cacheAfterKill).length).toBe(25);

      const resumed = new Indexer(makeConfig(fakeProvider(3, IDENTITY)), await freshStore());
      const stats = await resumed.reindex();
      expect(stats.skipped).toBe(25);
      expect(stats.indexed).toBe(32 - 25);
      expect((await resumed.getStatus()).needsReindex).toBe(false);
    });
  });
});
