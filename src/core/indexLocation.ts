/**
 * Shared resolver for the per-user global index location.
 *
 * This is the single source of truth both the **writer** (the VS Code
 * extension) and the **reader** (MCP server / CLI) call so they always agree
 * on which directory the LanceDB store lives in. Resolution is deterministic
 * (pure hash of the canonical workspace path) and performs a one-time, lazy,
 * fail-closed migration of any legacy in-workspace index in global mode.
 *
 * THREAT MODEL (security review §8 — this module owns every finding):
 *  - Attacker-controlled: the cloned workspace and everything under it —
 *    its directory structure, symlinks, `.doc-search-index/`,
 *    `.vscode/settings.json`, a committed `.mcp.json` (which can inject env).
 *    Anyone can publish a repo a victim clones and points the tool at.
 *  - Trusted (the asset to protect): the user's $HOME, existing global
 *    indexes, VS Code *user* settings, and the launch env (`DOC_SEARCH_HOME`).
 *  - Invariants: (a) never read/write outside `home/indexes/<key>`;
 *    (b) never follow a workspace symlink during migration;
 *    (c) repo-level config may only select an in-workspace path.
 *
 * Migration treats the legacy dir as hostile: it refuses to follow any
 * symlink and never deletes the source until a verified copy exists. The
 * store only ever contains LanceDB regular files/dirs, so any symlink in that
 * tree is anomalous and we fail closed.
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";

import { resolveSafePath, resolveWithinBase } from "./safePath.js";

export type IndexLocationMode = "global" | "workspace";

export const LEGACY_INDEX_DIRNAME = ".doc-search-index";

/** The LanceDB table dir that marks a populated index. */
const SENTINEL = "doc_chunks.lance";

/** Bound the interior symlink walk — LanceDB trees are shallow. */
const MAX_WALK_DEPTH = 16;

export interface ResolveIndexOptions {
  /** Resolved by the caller from config (global is the product default). */
  mode: IndexLocationMode;
  /** Workspace-relative dir; used ONLY in workspace mode. Default ".doc-search-index". */
  indexDir?: string;
  /** Override base dir (tests / power users). Default: resolveDocSearchHome(env). */
  home?: string;
  /** Injected for testing. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedIndex {
  /** Absolute path to the index dir to open. */
  indexDir: string;
  mode: IndexLocationMode;
  /** True only in workspace mode — caller should call ensureGitignored. */
  shouldGitignore: boolean;
  /** Workspace-relative entry to add to .gitignore (workspace mode only). */
  gitignoreEntry?: string;
  /**
   * Absolute path of a legacy index migrated during THIS call, else undefined.
   * Internal / local-logging only (sec §8/L2) — never surface in an MCP tool
   * response: it would leak the user's absolute $HOME layout to the client.
   */
  migratedFrom?: string;
}

function warn(message: string): void {
  process.stderr.write(`[doc-search] ${message}\n`);
}

/**
 * Resolve the workspace-mode (`global`/`workspace`) selection. Pure.
 *
 * Explicit modes win. Otherwise (D2 implicit opt-in) a non-default `indexDir`
 * — anything other than empty or the legacy default — implies the user wants
 * an in-workspace index, so we never yank a custom location into global.
 */
export function resolveMode(
  rawMode: string | undefined,
  rawIndexDir: string | undefined,
): IndexLocationMode {
  if (rawMode === "workspace") return "workspace";
  if (rawMode === "global") return "global";
  const d = rawIndexDir?.trim();
  return d && d !== LEGACY_INDEX_DIRNAME ? "workspace" : "global";
}

/**
 * `~/.doc-search`, or `$DOC_SEARCH_HOME` if it is a safe absolute path. Pure.
 *
 * `DOC_SEARCH_HOME` is part of the launch contract but can be injected via a
 * committed `.mcp.json` (sec §8/F3), so it is validated, not trusted: it must
 * be absolute and must not be the filesystem root. Relative / empty / root
 * values are rejected with a stderr warning and fall back to the default — we
 * never `path.resolve` a relative value against cwd. The accepted base is
 * realpath-canonicalized (sec §8/M5) so a symlinked home cannot later redirect
 * the containment check in `resolveIndexLocation`.
 */
export function resolveDocSearchHome(env: NodeJS.ProcessEnv = process.env): string {
  let base: string | undefined;

  const raw = env.DOC_SEARCH_HOME?.trim();
  if (raw !== undefined && raw !== "") {
    if (!path.isAbsolute(raw)) {
      warn(`DOC_SEARCH_HOME must be an absolute path; ignoring ${JSON.stringify(raw)}`);
    } else if (isFsRoot(raw)) {
      warn(`DOC_SEARCH_HOME must not be the filesystem root; ignoring ${JSON.stringify(raw)}`);
    } else {
      base = raw;
    }
  } else if (raw === "") {
    warn("DOC_SEARCH_HOME is empty; falling back to the default location");
  }

  if (base === undefined) {
    const home = os.homedir();
    if (!home || isFsRoot(home)) {
      // Never write to cwd; fall back to a tmp-scoped dir instead.
      warn("os.homedir() is empty or root; falling back to a temp directory");
      base = path.join(os.tmpdir(), "doc-search");
    } else {
      base = path.join(home, ".doc-search");
    }
  }

  return canonicalize(base);
}

/** True if `p` is a filesystem root (`/`, or a drive root like `C:\\` on Windows). */
function isFsRoot(p: string): boolean {
  const resolved = path.resolve(p);
  return path.dirname(resolved) === resolved;
}

/**
 * Realpath-canonicalize a path. If it does not exist yet, canonicalize the
 * nearest existing ancestor and re-append the missing tail so a symlinked
 * ancestor still gets resolved.
 */
function canonicalize(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // Walk up to the nearest existing ancestor, canonicalize that, re-attach.
    let current = abs;
    const tail: string[] = [];
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) return abs; // hit the root without finding one
      tail.unshift(path.basename(current));
      current = parent;
      try {
        const realParent = fs.realpathSync.native(current);
        return path.join(realParent, ...tail);
      } catch {
        // keep walking up
      }
    }
  }
}

/**
 * Deterministic, filesystem-safe per-workspace key:
 * `${sanitizedBasename}-${sha256(realpath)[:12]}`. Pure.
 *
 * The basename is sanitized to `[A-Za-z0-9._-]` (other chars collapse to `-`,
 * leading/trailing `-` trimmed, a leading `.` stripped, `.`/`..` rejected to
 * the fallback `"workspace"`, capped to 64 chars). The final key invariant is
 * asserted before returning and a violation throws — this makes the
 * containment re-check in `resolveIndexLocation` provably redundant rather
 * than load-bearing (sec §8/F4/M4).
 */
export function workspaceKey(realWorkspacePath: string): string {
  const canonical = path.resolve(realWorkspacePath);
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);

  let base = path.basename(canonical);
  base = base.replace(/[^A-Za-z0-9._-]/g, "-"); // collapse disallowed chars
  base = base.replace(/^-+|-+$/g, ""); // trim leading/trailing `-`
  base = base.replace(/^\.+/, ""); // strip leading dot(s)
  if (base === "" || base === "." || base === "..") base = "workspace";
  if (base.length > 64) base = base.slice(0, 64);
  // A trailing dot can survive the cap (e.g. "foo." truncated); guard it so
  // the key never ends in a bare `.` segment.
  if (base === "" || base === "." || base === "..") base = "workspace";

  const key = `${base}-${hash}`;

  // Should-never-happen programmer-error guard (the one place the resolver is
  // allowed to throw): if any of the above failed to produce a safe key,
  // refuse rather than emit a path that could escape `home/indexes/`.
  if (
    !/^[A-Za-z0-9._-]+$/.test(key) ||
    key === "." ||
    key === ".." ||
    key.includes("/") ||
    key.includes("\\")
  ) {
    throw new Error(`workspaceKey produced an unsafe key: ${JSON.stringify(key)}`);
  }

  return key;
}

/**
 * Resolve the absolute index dir, performing one-time lazy migration in global
 * mode. Does I/O.
 *
 * MUST NOT throw out of this function except the should-never-happen
 * key/containment invariant guard (a programmer error, not a runtime
 * condition). Any migration failure degrades to an empty, reindexable target
 * and never deletes the legacy source.
 */
export function resolveIndexLocation(
  workspaceRoot: string,
  opts: ResolveIndexOptions,
): ResolvedIndex {
  if (opts.mode === "workspace") {
    const entry = (opts.indexDir || LEGACY_INDEX_DIRNAME).trim() || LEGACY_INDEX_DIRNAME;
    // Contains to the workspace (preserves M4): repo-supplied indexDir can
    // never select an out-of-workspace path.
    const indexDir = resolveSafePath(workspaceRoot, entry);
    return {
      indexDir,
      mode: "workspace",
      shouldGitignore: true,
      gitignoreEntry: entry,
    };
  }

  // ---- global mode ----------------------------------------------------------

  // Canonicalize the workspace so a symlinked workspace root keys consistently
  // and we never key on the link path.
  const canonicalWorkspace = canonicalizeWorkspace(workspaceRoot);
  if (canonicalWorkspace !== path.resolve(workspaceRoot)) {
    // F6: social-engineering signal (a symlinked root may point at a sensitive
    // location). Not a write-escape — keying is on the canonical path — but
    // worth surfacing.
    warn(
      `workspace root resolves through a symlink (${path.resolve(workspaceRoot)} -> ${canonicalWorkspace})`,
    );
  }

  const home = resolveDocSearchHome(opts.env ?? process.env);
  const resolvedHome = opts.home !== undefined ? canonicalize(opts.home) : home;
  const indexesDir = path.join(resolvedHome, "indexes");

  const key = workspaceKey(canonicalWorkspace);
  // Defense in depth: re-validate that `<home>/indexes/<key>` stays under
  // `<home>/indexes`. `key` is already proven safe above, so this only ever
  // throws on a programmer error — never warn-and-continue (sec §8/M5).
  const target = resolveWithinBase(indexesDir, key);

  // Create the tree hardened: 0700 dirs. umask defeats the `mode` arg of
  // mkdir, so the idempotent chmod is what actually lands 0700 on POSIX. Skip
  // perm work on Windows (sec §8/H1/F7).
  hardenedMkdir(resolvedHome);
  hardenedMkdir(indexesDir);
  hardenedMkdir(target);

  // Best-effort GC of orphaned temp dirs from crashed migrations (sec §8/M2).
  gcStaleMigratingDirs(indexesDir, key);

  let migratedFrom: string | undefined;
  const legacy = path.join(canonicalWorkspace, LEGACY_INDEX_DIRNAME);
  if (!isPopulated(target) && isSafeLegacyIndex(legacy)) {
    migratedFrom = migrate(legacy, target, indexesDir, key);
  }

  return {
    indexDir: target,
    mode: "global",
    shouldGitignore: false,
    migratedFrom,
  };
}

/** Canonicalize the workspace root; fall back to a plain resolve if it doesn't exist yet. */
function canonicalizeWorkspace(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function hardenedMkdir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // best-effort tightening; not fatal
    }
  }
}

/** A populated index dir: exists and contains a regular-file/dir sentinel. Never merge. */
function isPopulated(target: string): boolean {
  try {
    const st = fs.lstatSync(target);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    const st = fs.lstatSync(path.join(target, SENTINEL));
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fail-closed gate (sec §8/F1/H2): the legacy dir is only safe to migrate when
 * it is a real directory (not a symlink), contains the sentinel as a regular
 * file, and has NO interior symlinks anywhere in its tree.
 */
function isSafeLegacyIndex(dir: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return false; // doesn't exist — nothing to migrate
  }
  if (st.isSymbolicLink()) {
    warn(`legacy index ${dir} is a symlink; refusing to migrate it (migrate manually)`);
    return false;
  }
  if (!st.isDirectory()) return false;

  // Sentinel must be a real (non-symlink) file or directory. A real LanceDB
  // table is a DIRECTORY (`doc_chunks.lance/` holding `data/`, `_versions/`,
  // …), so a regular-file-only check rejects every real index and migration
  // never runs. We only need to exclude a symlinked / missing sentinel here;
  // the interior-symlink walk below covers the rest of the tree. Mirrors the
  // file-or-dir acceptance in isPopulated().
  try {
    const sentinel = fs.lstatSync(path.join(dir, SENTINEL));
    if (sentinel.isSymbolicLink() || (!sentinel.isFile() && !sentinel.isDirectory())) {
      return false;
    }
  } catch {
    return false;
  }

  // No interior symlinks anywhere in the tree → fail closed.
  if (hasInteriorSymlink(dir, 0)) {
    warn(
      `legacy index ${dir} contains a symlink; refusing to migrate it automatically (migrate manually)`,
    );
    return false;
  }

  return true;
}

/** Recursively lstat-walk for any symlink entry. Bounded depth. */
function hasInteriorSymlink(dir: string, depth: number): boolean {
  if (depth > MAX_WALK_DEPTH) {
    // Unexpectedly deep for a LanceDB tree — treat as anomalous, fail closed.
    return true;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Can't enumerate → can't prove it's clean → fail closed.
    return true;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let est: fs.Stats;
    try {
      est = fs.lstatSync(full);
    } catch {
      return true; // can't classify → fail closed
    }
    if (est.isSymbolicLink()) return true;
    if (est.isDirectory()) {
      if (hasInteriorSymlink(full, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Best-effort migration of a verified-safe legacy index into `target`. Returns
 * the legacy path on success, else undefined. NEVER throws to the caller and
 * NEVER deletes the source on any failure path.
 */
function migrate(
  legacy: string,
  target: string,
  indexesDir: string,
  key: string,
): string | undefined {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

    // Tighten the TOCTOU window (sec §8/F5): re-lstat the source immediately
    // before the move and bail if it became a symlink since the safety gate.
    let pre: fs.Stats;
    try {
      pre = fs.lstatSync(legacy);
    } catch {
      return undefined; // vanished — another process won, or it's gone
    }
    if (pre.isSymbolicLink() || !pre.isDirectory()) return undefined;

    // Same-FS fast path: atomic rename doubles as the "claim" against a
    // concurrent extension+MCP race.
    try {
      fs.renameSync(legacy, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        return migrateCrossDevice(legacy, target, indexesDir, key);
      }
      if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
        // Race / target appeared — another process won. No-op.
        return undefined;
      }
      // Any other rename error: leave legacy intact, degrade to empty target.
      warn(`migration rename failed (${code ?? "unknown"}); leaving legacy index in place`);
      return undefined;
    }

    // Post-rename: verify the published target is not unexpectedly a symlink.
    try {
      const post = fs.lstatSync(target);
      if (post.isSymbolicLink()) {
        warn(`migrated target ${target} is unexpectedly a symlink; abandoning migration`);
        return undefined;
      }
    } catch {
      return undefined;
    }

    return legacy;
  } catch (err) {
    // Catch-all: never let migration throw out of the resolver.
    warn(
      `migration failed unexpectedly (${(err as Error).message}); leaving legacy index in place`,
    );
    return undefined;
  }
}

/**
 * EXDEV fallback: $HOME on a different volume than the workspace. Copy to a
 * pid-suffixed temp dir, verify the sentinel before publishing, publish
 * atomically, and only then delete the source. On any copy error (incl.
 * ENOSPC) clean the tmp, leave legacy intact, and degrade to an empty target.
 */
function migrateCrossDevice(
  legacy: string,
  target: string,
  indexesDir: string,
  key: string,
): string | undefined {
  const tmp = path.join(indexesDir, `${key}.migrating-${process.pid}`);

  try {
    // Symlinks copied as links, never followed; never overwrite (sec §8/H2).
    fs.cpSync(legacy, tmp, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    rmTmpBestEffort(tmp);
    warn(
      `cross-device migration copy failed (${code ?? (err as Error).message}); ` +
        `leaving legacy index in place, starting with an empty index`,
    );
    return undefined;
  }

  // Verify the copy before publishing (sec §8/M1): the sentinel must exist
  // with size > 0 in the tmp copy.
  try {
    const sentinelSize = sentinelByteSize(path.join(tmp, SENTINEL));
    if (sentinelSize <= 0) {
      rmTmpBestEffort(tmp);
      warn("cross-device migration produced an empty index; leaving legacy in place");
      return undefined;
    }
  } catch {
    rmTmpBestEffort(tmp);
    warn("cross-device migration could not be verified; leaving legacy in place");
    return undefined;
  }

  // Publish atomically.
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    rmTmpBestEffort(tmp);
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") {
      // Another process published first — fine, target is populated.
      return undefined;
    }
    warn(`cross-device migration publish failed (${code ?? "unknown"}); leaving legacy in place`);
    return undefined;
  }

  // Only after a verified publish: delete the source. No `force` so a failed
  // delete surfaces; on failure leave legacy (target is already populated).
  try {
    fs.rmSync(legacy, { recursive: true });
  } catch (err) {
    warn(
      `migrated index published but could not remove the legacy copy ` +
        `(${(err as Error).message}); leaving it in place`,
    );
  }

  return legacy;
}

/**
 * Byte size of the sentinel. LanceDB tables are directories, so sum the sizes
 * of the regular files within (bounded walk); a single regular file is sized
 * directly. Returns 0 if it can't be measured.
 */
function sentinelByteSize(sentinel: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(sentinel);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;

  let total = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let est: fs.Stats;
      try {
        est = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (est.isFile()) total += est.size;
      else if (est.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(sentinel, 0);
  return total;
}

function rmTmpBestEffort(tmp: string): void {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort cleanup of our own temp dir
  }
}

/**
 * Opportunistic GC (sec §8/M2): remove sibling `*.migrating-*` temp dirs whose
 * owning pid is no longer alive. Best-effort; never throws.
 */
function gcStaleMigratingDirs(indexesDir: string, key: string): void {
  try {
    const prefix = `${key}.migrating-`;
    const entries = fs.readdirSync(indexesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(prefix)) continue;
      const pidStr = entry.name.slice(prefix.length);
      const pid = Number(pidStr);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === process.pid) continue; // don't GC our own in-flight dir
      if (isPidAlive(pid)) continue;
      rmTmpBestEffort(path.join(indexesDir, entry.name));
    }
  } catch {
    // best-effort
  }
}

/** True if a process with `pid` exists. `process.kill(pid, 0)` probes without signalling. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH → no such process (dead). EPERM → exists but not ours (alive).
    return code !== "ESRCH";
  }
}
