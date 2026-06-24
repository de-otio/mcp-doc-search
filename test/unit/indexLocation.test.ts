import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  LEGACY_INDEX_DIRNAME,
  resolveDocSearchHome,
  workspaceKey,
  resolveMode,
  resolveIndexLocation,
  removeSupersededLegacyIndex,
} from "../../src/core/indexLocation.js";

const isPosix = process.platform !== "win32";
const SENTINEL = "doc_chunks.lance";
// A regular file inside the LanceDB table dir — real tables are directories, so
// the sentinel itself is never a regular file.
const SENTINEL_DATA = "data.lance";

let scratch: string;
const cleanups: string[] = [];

function mkScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/**
 * Write a real-LanceDB-shaped index at `dir`: the sentinel `doc_chunks.lance`
 * is a DIRECTORY (not a regular file) containing a data file. This matches what
 * LanceDB actually produces on disk — the file-shaped fixture this replaced let
 * a migration bug ship (isSafeLegacyIndex required a regular-file sentinel).
 */
function makeIndexAt(dir: string, content = "lance-data"): void {
  const table = path.join(dir, SENTINEL);
  fs.mkdirSync(table, { recursive: true });
  fs.writeFileSync(path.join(table, SENTINEL_DATA), content);
}

/** Create a populated legacy index dir (real-LanceDB-shaped). */
function makeLegacy(workspace: string, content = "lance-data"): string {
  const legacy = path.join(workspace, LEGACY_INDEX_DIRNAME);
  makeIndexAt(legacy, content);
  return legacy;
}

/** Read the data file inside a migrated/target index's sentinel directory. */
function readSentinelData(indexDir: string): string {
  return fs.readFileSync(path.join(indexDir, SENTINEL, SENTINEL_DATA), "utf8");
}

beforeEach(() => {
  scratch = mkScratch("idxloc-");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanups.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ---------------------------------------------------------------------------
// resolveMode (D2)
// ---------------------------------------------------------------------------

describe("resolveMode", () => {
  it("honors explicit modes", () => {
    expect(resolveMode("workspace", undefined)).toBe("workspace");
    expect(resolveMode("global", ".doc-search-index")).toBe("global");
  });

  it("defaults to global with no/empty/default indexDir", () => {
    expect(resolveMode(undefined, undefined)).toBe("global");
    expect(resolveMode(undefined, "")).toBe("global");
    expect(resolveMode(undefined, "  ")).toBe("global");
    expect(resolveMode(undefined, LEGACY_INDEX_DIRNAME)).toBe("global");
  });

  it("implicitly opts into workspace mode for a non-default indexDir (D2)", () => {
    expect(resolveMode(undefined, "my-index")).toBe("workspace");
    expect(resolveMode(undefined, ".cache/idx")).toBe("workspace");
  });
});

// ---------------------------------------------------------------------------
// resolveDocSearchHome (M3 / M5)
// ---------------------------------------------------------------------------

describe("resolveDocSearchHome", () => {
  it("uses an absolute DOC_SEARCH_HOME", () => {
    const home = mkScratch("home-");
    const got = resolveDocSearchHome({ DOC_SEARCH_HOME: home });
    expect(got).toBe(fs.realpathSync.native(home));
  });

  it("rejects a relative DOC_SEARCH_HOME and falls back (not cwd-resolved) (M3)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(os, "homedir").mockReturnValue(scratch);
    const got = resolveDocSearchHome({ DOC_SEARCH_HOME: "relative/dir" });
    expect(got).not.toContain(path.resolve("relative/dir"));
    expect(got.startsWith(fs.realpathSync.native(scratch))).toBe(true);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/absolute/);
  });

  it("rejects an empty-after-trim DOC_SEARCH_HOME and falls back (M3)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(os, "homedir").mockReturnValue(scratch);
    const got = resolveDocSearchHome({ DOC_SEARCH_HOME: "   " });
    expect(got.startsWith(fs.realpathSync.native(scratch))).toBe(true);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/empty/);
  });

  it("rejects the filesystem root as DOC_SEARCH_HOME (M3)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const got = resolveDocSearchHome({ DOC_SEARCH_HOME: path.parse(scratch).root, HOME: scratch });
    expect(got).not.toBe(path.parse(scratch).root);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/root/);
  });

  it("defaults to ~/.doc-search", () => {
    const fakeHome = mkScratch("fakehome-");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const got = resolveDocSearchHome({});
    expect(got).toBe(path.join(fs.realpathSync.native(fakeHome), ".doc-search"));
  });

  it("falls back to a tmp dir when homedir is empty (homedir-missing fallback)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(os, "homedir").mockReturnValue("");
    const got = resolveDocSearchHome({});
    expect(got).toContain("doc-search");
    expect(got).not.toBe("");
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/homedir/);
  });

  it("canonicalizes a symlinked home before composing (M5)", () => {
    if (!isPosix) return;
    const real = mkScratch("realhome-");
    const link = path.join(mkScratch("linkparent-"), "homelink");
    fs.symlinkSync(real, link);
    const got = resolveDocSearchHome({ DOC_SEARCH_HOME: link });
    expect(got).toBe(fs.realpathSync.native(real));
  });
});

// ---------------------------------------------------------------------------
// workspaceKey (M4)
// ---------------------------------------------------------------------------

describe("workspaceKey", () => {
  const KEY_RE = /^[A-Za-z0-9._-]+$/;

  it("is deterministic: same path -> same key", () => {
    expect(workspaceKey("/a/b/project")).toBe(workspaceKey("/a/b/project"));
  });

  it("different paths -> different keys", () => {
    expect(workspaceKey("/a/b/project")).not.toBe(workspaceKey("/a/c/project"));
  });

  it("appends a 12-char sha256 prefix of the canonical path", () => {
    const p = "/a/b/myproj";
    const hash = crypto.createHash("sha256").update(path.resolve(p)).digest("hex").slice(0, 12);
    expect(workspaceKey(p)).toBe(`myproj-${hash}`);
  });

  it("sanitizes disallowed characters", () => {
    const key = workspaceKey("/a/b/my project!@#");
    expect(KEY_RE.test(key)).toBe(true);
  });

  it("falls back to 'workspace' for a basename that sanitizes to empty", () => {
    expect(workspaceKey("/a/b/...").startsWith("workspace-")).toBe(true);
  });

  it("strips a leading dot from the basename", () => {
    expect(workspaceKey("/a/b/.hidden").startsWith("hidden-")).toBe(true);
  });

  it("never produces a '.' or '..' key", () => {
    for (const p of ["/a/b/.", "/a/b/..", "/", "/a/b/./"]) {
      const key = workspaceKey(p);
      expect(key).not.toBe(".");
      expect(key).not.toBe("..");
      expect(KEY_RE.test(key)).toBe(true);
    }
  });

  it("caps the basename to 64 chars (length cap)", () => {
    const long = "x".repeat(200);
    const key = workspaceKey(`/a/b/${long}`);
    const base = key.slice(0, key.lastIndexOf("-"));
    expect(base.length).toBeLessThanOrEqual(64);
    expect(KEY_RE.test(key)).toBe(true);
  });

  it("contains no path separators", () => {
    const key = workspaceKey("/a/b/weird\\name");
    expect(key.includes("/")).toBe(false);
    expect(key.includes("\\")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveIndexLocation — workspace mode (M4 preserved)
// ---------------------------------------------------------------------------

describe("resolveIndexLocation (workspace mode)", () => {
  it("resolves an in-workspace indexDir and flags gitignore", () => {
    const ws = mkScratch("ws-");
    const r = resolveIndexLocation(ws, { mode: "workspace", indexDir: "custom-index" });
    expect(r.mode).toBe("workspace");
    expect(r.shouldGitignore).toBe(true);
    expect(r.gitignoreEntry).toBe("custom-index");
    expect(r.indexDir).toBe(path.join(path.resolve(ws), "custom-index"));
  });

  it("defaults the entry to the legacy dirname", () => {
    const ws = mkScratch("ws-");
    const r = resolveIndexLocation(ws, { mode: "workspace" });
    expect(r.gitignoreEntry).toBe(LEGACY_INDEX_DIRNAME);
  });

  it("rejects a `..` indexDir (M4)", () => {
    const ws = mkScratch("ws-");
    expect(() => resolveIndexLocation(ws, { mode: "workspace", indexDir: "../escape" })).toThrow();
  });

  it("rejects an absolute indexDir (M4)", () => {
    const ws = mkScratch("ws-");
    expect(() => resolveIndexLocation(ws, { mode: "workspace", indexDir: "/tmp/abs" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveIndexLocation — global mode happy paths
// ---------------------------------------------------------------------------

describe("resolveIndexLocation (global mode)", () => {
  it("resolves under home/indexes/<key> and does not gitignore", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.mode).toBe("global");
    expect(r.shouldGitignore).toBe(false);
    const key = workspaceKey(fs.realpathSync.native(ws));
    expect(r.indexDir).toBe(path.join(fs.realpathSync.native(home), "indexes", key));
    expect(fs.existsSync(r.indexDir)).toBe(true);
  });

  it("migrates a same-FS legacy index via renameSync", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    makeLegacy(ws, "real-lance-data");
    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.migratedFrom).toBeDefined();
    expect(fs.existsSync(path.join(r.indexDir, SENTINEL))).toBe(true);
    expect(readSentinelData(r.indexDir)).toBe("real-lance-data");
    // Legacy gone after same-FS rename.
    expect(fs.existsSync(path.join(ws, LEGACY_INDEX_DIRNAME))).toBe(false);
  });

  it("does not migrate when target is already populated (idempotency; legacy untouched)", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const legacy = makeLegacy(ws, "legacy-data");
    // Pre-populate the target.
    const key = workspaceKey(fs.realpathSync.native(ws));
    const target = path.join(fs.realpathSync.native(home), "indexes", key);
    makeIndexAt(target, "existing-data");

    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.migratedFrom).toBeUndefined();
    expect(readSentinelData(r.indexDir)).toBe("existing-data");
    // Legacy untouched.
    expect(fs.existsSync(path.join(legacy, SENTINEL))).toBe(true);
  });

  it("does not migrate an empty / non-index dir", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    fs.mkdirSync(path.join(ws, LEGACY_INDEX_DIRNAME)); // no sentinel
    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.migratedFrom).toBeUndefined();
    expect(fs.existsSync(path.join(r.indexDir, SENTINEL))).toBe(false);
  });

  it("canonicalizes a symlinked workspace root and warns (F6)", () => {
    if (!isPosix) return;
    const realWs = mkScratch("realws-");
    const link = path.join(mkScratch("linkparent-"), "wslink");
    fs.symlinkSync(realWs, link);
    const home = mkScratch("home-");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const r = resolveIndexLocation(link, { mode: "global", home });
    const key = workspaceKey(fs.realpathSync.native(realWs));
    expect(r.indexDir).toBe(path.join(fs.realpathSync.native(home), "indexes", key));
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/symlink/);
  });

  it("honors DOC_SEARCH_HOME via env when home opt is absent", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const r = resolveIndexLocation(ws, { mode: "global", env: { DOC_SEARCH_HOME: home } });
    expect(r.indexDir.startsWith(fs.realpathSync.native(home))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Symlink refusal (F1 / H2)
// ---------------------------------------------------------------------------

describe("resolveIndexLocation — symlink refusal (F1/H2)", () => {
  it("refuses a symlinked legacy dir; target not created from it (F1)", () => {
    if (!isPosix) return;
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    // A sensitive dir the symlink would point at.
    const secret = mkScratch("secret-");
    fs.writeFileSync(path.join(secret, SENTINEL), "secret");
    fs.symlinkSync(secret, path.join(ws, LEGACY_INDEX_DIRNAME));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.migratedFrom).toBeUndefined();
    expect(fs.existsSync(path.join(r.indexDir, SENTINEL))).toBe(false);
    // Symlink and its target left intact.
    expect(fs.existsSync(path.join(secret, SENTINEL))).toBe(true);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/symlink/);
  });

  it("refuses migration when the legacy tree has an interior symlink (H2)", () => {
    if (!isPosix) return;
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const secret = mkScratch("secret-");
    fs.writeFileSync(path.join(secret, "creds"), "topsecret");
    const legacy = makeLegacy(ws, "data");
    fs.symlinkSync(secret, path.join(legacy, "evil"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.migratedFrom).toBeUndefined();
    expect(fs.existsSync(path.join(r.indexDir, SENTINEL))).toBe(false);
    // Link not dereferenced — secret untouched, legacy preserved.
    expect(fs.existsSync(path.join(secret, "creds"))).toBe(true);
    expect(fs.existsSync(path.join(legacy, SENTINEL))).toBe(true);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/symlink/);
  });
});

// ---------------------------------------------------------------------------
// EXDEV copy-fallback + verify-before-delete (M1) + ENOSPC (L1) + rm fail (H3)
// ---------------------------------------------------------------------------

describe("resolveIndexLocation — cross-device migration", () => {
  it("copies via cpSync when renameSync throws EXDEV", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    makeLegacy(ws, "xdev-data");

    const realRename = fs.renameSync;
    let threwOnce = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // Only fail the legacy->target move once; allow tmp->target publish.
      if (!threwOnce && String(from).includes(LEGACY_INDEX_DIRNAME)) {
        threwOnce = true;
        const e = new Error("cross-device") as NodeJS.ErrnoException;
        e.code = "EXDEV";
        throw e;
      }
      return realRename(from, to);
    });

    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.migratedFrom).toBeDefined();
    expect(readSentinelData(r.indexDir)).toBe("xdev-data");
    // Source deleted only after verified publish.
    expect(fs.existsSync(path.join(ws, LEGACY_INDEX_DIRNAME))).toBe(false);
    // No orphan migrating dir left behind.
    const indexes = path.join(fs.realpathSync.native(home), "indexes");
    expect(fs.readdirSync(indexes).some((n) => n.includes(".migrating-"))).toBe(false);
  });

  it("does not publish or delete source when the copy is empty (M1)", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    makeLegacy(ws, "good-data");

    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(LEGACY_INDEX_DIRNAME)) {
        const e = new Error("cross-device") as NodeJS.ErrnoException;
        e.code = "EXDEV";
        throw e;
      }
      return realRename(from, to);
    });
    // Force cpSync to produce an empty (size 0) sentinel.
    vi.spyOn(fs, "cpSync").mockImplementation((_src, dest) => {
      fs.mkdirSync(dest as string, { recursive: true });
      fs.writeFileSync(path.join(dest as string, SENTINEL), "");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.migratedFrom).toBeUndefined();
    // Source preserved.
    expect(fs.existsSync(path.join(ws, LEGACY_INDEX_DIRNAME, SENTINEL))).toBe(true);
    // Target empty (no sentinel).
    expect(fs.existsSync(path.join(r.indexDir, SENTINEL))).toBe(false);
    // tmp cleaned up.
    const indexes = path.join(fs.realpathSync.native(home), "indexes");
    expect(fs.readdirSync(indexes).some((n) => n.includes(".migrating-"))).toBe(false);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/empty/);
  });

  it("degrades to empty and preserves source on ENOSPC (L1)", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    makeLegacy(ws, "data");

    vi.spyOn(fs, "renameSync").mockImplementation((from) => {
      if (String(from).includes(LEGACY_INDEX_DIRNAME)) {
        const e = new Error("cross-device") as NodeJS.ErrnoException;
        e.code = "EXDEV";
        throw e;
      }
      throw new Error("unexpected rename");
    });
    vi.spyOn(fs, "cpSync").mockImplementation(() => {
      const e = new Error("no space left on device") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const r = resolveIndexLocation(ws, { mode: "global", home });
    expect(r.migratedFrom).toBeUndefined();
    // Source preserved.
    expect(fs.existsSync(path.join(ws, LEGACY_INDEX_DIRNAME, SENTINEL))).toBe(true);
    // Empty target.
    expect(fs.existsSync(path.join(r.indexDir, SENTINEL))).toBe(false);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/ENOSPC/);
  });

  it("leaves legacy in place when rmSync throws after a verified publish (H3, never-throw)", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    makeLegacy(ws, "publish-then-rm-fail");

    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(LEGACY_INDEX_DIRNAME)) {
        const e = new Error("cross-device") as NodeJS.ErrnoException;
        e.code = "EXDEV";
        throw e;
      }
      return realRename(from, to);
    });
    vi.spyOn(fs, "rmSync").mockImplementation((target) => {
      if (String(target).includes(LEGACY_INDEX_DIRNAME)) {
        throw new Error("rm refused");
      }
      // allow tmp cleanups (none expected here)
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const r = resolveIndexLocation(ws, { mode: "global", home });
    // Published target is populated.
    expect(readSentinelData(r.indexDir)).toBe("publish-then-rm-fail");
    // Legacy left behind, not lost.
    expect(fs.existsSync(path.join(ws, LEGACY_INDEX_DIRNAME))).toBe(true);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/legacy/);
  });
});

// ---------------------------------------------------------------------------
// Permissions (H1/H7) — POSIX only
// ---------------------------------------------------------------------------

describe("resolveIndexLocation — directory permissions (H1/H7)", () => {
  it("creates home at 0700", () => {
    if (!isPosix) return;
    const ws = mkScratch("ws-");
    const home = path.join(mkScratch("homeparent-"), "doc-search-home");
    resolveIndexLocation(ws, { mode: "global", home });
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing 0755 home to 0700 (idempotent)", () => {
    if (!isPosix) return;
    const ws = mkScratch("ws-");
    const home = path.join(mkScratch("homeparent-"), "loose-home");
    fs.mkdirSync(home, { mode: 0o755 });
    fs.chmodSync(home, 0o755);
    resolveIndexLocation(ws, { mode: "global", home });
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// Orphan GC (M2)
// ---------------------------------------------------------------------------

describe("resolveIndexLocation — orphan GC (M2)", () => {
  it("removes a stale migrating dir whose pid is dead", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const key = workspaceKey(fs.realpathSync.native(ws));
    const indexes = path.join(fs.realpathSync.native(home), "indexes");
    fs.mkdirSync(indexes, { recursive: true });
    // A dead pid: process.kill(deadPid, 0) -> ESRCH.
    const deadPid = 2_147_483_646;
    const stale = path.join(indexes, `${key}.migrating-${deadPid}`);
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "junk"), "x");

    resolveIndexLocation(ws, { mode: "global", home });
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("keeps a migrating dir whose pid is alive (our own pid)", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const key = workspaceKey(fs.realpathSync.native(ws));
    const indexes = path.join(fs.realpathSync.native(home), "indexes");
    fs.mkdirSync(indexes, { recursive: true });
    const live = path.join(indexes, `${key}.migrating-${process.pid}`);
    fs.mkdirSync(live, { recursive: true });

    resolveIndexLocation(ws, { mode: "global", home });
    expect(fs.existsSync(live)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M5 — containment re-check with a symlinked indexes base
// ---------------------------------------------------------------------------

describe("resolveIndexLocation — symlinked base (M5)", () => {
  it("canonicalizes a symlinked home so the write lands in the real dir", () => {
    if (!isPosix) return;
    const ws = mkScratch("ws-");
    const realHome = mkScratch("realhome-");
    const link = path.join(mkScratch("linkparent-"), "homelink");
    fs.symlinkSync(realHome, link);

    const r = resolveIndexLocation(ws, { mode: "global", home: link });
    expect(r.indexDir.startsWith(fs.realpathSync.native(realHome))).toBe(true);
    expect(fs.existsSync(r.indexDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removeSupersededLegacyIndex — extension-only cleanup of a redundant in-tree
// index once a populated global index supersedes it.
// ---------------------------------------------------------------------------

describe("removeSupersededLegacyIndex", () => {
  /** Path of the (would-be) populated global target for `ws` under `home`. */
  function targetFor(ws: string, home: string): string {
    const key = workspaceKey(fs.realpathSync.native(ws));
    return path.join(fs.realpathSync.native(home), "indexes", key);
  }

  it("removes a safe legacy index once the global target is populated", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const legacy = makeLegacy(ws, "legacy-data");
    const target = targetFor(ws, home);
    makeIndexAt(target, "global-data");

    const removed = removeSupersededLegacyIndex(ws, target);
    expect(removed).toBeDefined();
    expect(fs.existsSync(legacy)).toBe(false);
    // The surviving global index is untouched.
    expect(readSentinelData(target)).toBe("global-data");
  });

  it("leaves the legacy index when the global target is NOT populated", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const legacy = makeLegacy(ws, "legacy-data");
    const target = targetFor(ws, home); // never created/populated

    const removed = removeSupersededLegacyIndex(ws, target);
    expect(removed).toBeUndefined();
    expect(fs.existsSync(path.join(legacy, SENTINEL))).toBe(true);
  });

  it("no-ops when there is no legacy index (e.g. already migrated away)", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const target = targetFor(ws, home);
    makeIndexAt(target, "global-data");

    expect(removeSupersededLegacyIndex(ws, target)).toBeUndefined();
  });

  it("refuses to remove a symlinked legacy dir (fail closed)", () => {
    if (!isPosix) return;
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const secret = mkScratch("secret-");
    makeIndexAt(secret, "secret"); // what the symlink points at
    fs.symlinkSync(secret, path.join(ws, LEGACY_INDEX_DIRNAME));
    const target = targetFor(ws, home);
    makeIndexAt(target, "global-data");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(removeSupersededLegacyIndex(ws, target)).toBeUndefined();
    // Symlink and its target left intact.
    expect(fs.existsSync(path.join(secret, SENTINEL))).toBe(true);
    expect(fs.existsSync(path.join(ws, LEGACY_INDEX_DIRNAME))).toBe(true);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/symlink/);
  });

  it("refuses when the legacy tree has an interior symlink (fail closed)", () => {
    if (!isPosix) return;
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    const secret = mkScratch("secret-");
    fs.writeFileSync(path.join(secret, "creds"), "topsecret");
    const legacy = makeLegacy(ws, "data");
    fs.symlinkSync(secret, path.join(legacy, "evil"));
    const target = targetFor(ws, home);
    makeIndexAt(target, "global-data");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(removeSupersededLegacyIndex(ws, target)).toBeUndefined();
    // Link not dereferenced — secret untouched, legacy preserved.
    expect(fs.existsSync(path.join(secret, "creds"))).toBe(true);
    expect(fs.existsSync(path.join(legacy, SENTINEL))).toBe(true);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/symlink/);
  });

  it("never throws and leaves legacy in place when rmSync fails (best-effort)", () => {
    const ws = mkScratch("ws-");
    const home = mkScratch("home-");
    makeLegacy(ws, "data");
    const target = targetFor(ws, home);
    makeIndexAt(target, "global-data");
    vi.spyOn(fs, "rmSync").mockImplementation((p) => {
      if (String(p).includes(LEGACY_INDEX_DIRNAME)) throw new Error("rm refused");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(removeSupersededLegacyIndex(ws, target)).toBeUndefined();
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/superseded/);
  });
});
