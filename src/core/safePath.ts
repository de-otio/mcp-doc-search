/**
 * Safe-path resolution for user-supplied refs.
 *
 * Every place that turns a caller-supplied relative path into an absolute
 * filesystem path must verify the result still lives inside the workspace
 * root. Mid-path `..` segments, absolute refs, Windows-style separators on
 * POSIX, and prefix attacks (`workspace-evil` vs `workspace`) all need to
 * be rejected here, not at each call site.
 *
 * Symlinks: `resolveSafePath` / `resolveWithinBase` validate the resolved
 * path string only; if the caller later passes that path to fs functions, the
 * OS will follow symlinks normally. Callers that read file content must
 * additionally run the filesystem-aware check (`assertRealpathWithin`), and
 * crawlers must drop symlinked entries (`isSymlinkOrEscapes`) — a committed
 * `doc/link -> ~/.ssh` passes string containment.
 */

import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/** Thrown when a ref escapes (or attempts to escape) the workspace root. */
export class PathTraversalError extends Error {
  constructor(
    /** The raw ref the caller supplied (kept for logging, never for client output). */
    public readonly ref: string,
    /** Short reason — safe to include in a user-facing error message. */
    reason: string,
  ) {
    super(`Path traversal blocked: ${reason}`);
    this.name = "PathTraversalError";
  }
}

/**
 * Resolve `ref` against `workspaceRoot` and assert the result stays inside.
 *
 * - Rejects absolute refs.
 * - Rejects refs that resolve outside the workspace (mid-path `..`,
 *   leading `..`, etc.).
 * - Normalizes Windows-style `\` separators to POSIX `/` before resolution.
 * - Empty / `.` / `./` refs resolve to the workspace root itself; callers
 *   that disallow this should check the return value.
 *
 * Returns the absolute resolved path. Throws `PathTraversalError` on
 * violation. The error message never includes `workspaceRoot` — clients
 * should not learn the absolute filesystem layout.
 */
export function resolveSafePath(workspaceRoot: string, ref: string): string {
  if (typeof ref !== "string") {
    throw new PathTraversalError(String(ref), "ref must be a string");
  }

  const normalizedRef = ref.replace(/\\/g, "/");

  if (path.isAbsolute(normalizedRef)) {
    throw new PathTraversalError(ref, "absolute paths are not allowed");
  }

  const absRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(absRoot, normalizedRef);

  // Containment check. Append `path.sep` to the root so `/workspace` is not
  // accepted as a prefix of `/workspace-evil`.
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (resolved !== absRoot && !resolved.startsWith(rootWithSep)) {
    throw new PathTraversalError(ref, "path escapes the workspace");
  }

  return resolved;
}

/**
 * Resolve `ref` against an arbitrary trusted `baseDir` and assert the result
 * stays inside it. Same containment logic as `resolveSafePath`, but where the
 * base is a caller-chosen trusted directory rather than the workspace root —
 * used for the `home/indexes/<key>` re-validation in the index-location
 * resolver.
 *
 * **String-level containment only.** This compares resolved path strings; it
 * does NOT consult the filesystem. If `baseDir` (or a segment of it) is a
 * symlink, this check can be satisfied while the real write lands elsewhere.
 * The caller is therefore responsible for **realpath-canonicalizing `baseDir`
 * first** so a symlinked base cannot redirect the real write. The
 * index-location resolver does exactly this before composing `indexes/`.
 *
 * Returns the absolute resolved path. Throws `PathTraversalError` on
 * violation. The error message never includes `baseDir`.
 */
export function resolveWithinBase(baseDir: string, ref: string): string {
  if (typeof ref !== "string") {
    throw new PathTraversalError(String(ref), "ref must be a string");
  }

  const normalizedRef = ref.replace(/\\/g, "/");

  if (path.isAbsolute(normalizedRef)) {
    throw new PathTraversalError(ref, "absolute paths are not allowed");
  }

  const absBase = path.resolve(baseDir);
  const resolved = path.resolve(absBase, normalizedRef);

  // Containment check. Append `path.sep` to the base so `/base` is not
  // accepted as a prefix of `/base-evil`.
  const baseWithSep = absBase.endsWith(path.sep) ? absBase : absBase + path.sep;
  if (resolved !== absBase && !resolved.startsWith(baseWithSep)) {
    throw new PathTraversalError(ref, "path escapes the base directory");
  }

  return resolved;
}

/**
 * Canonical (symlink-free) absolute form of a root directory, via
 * `realpathSync.native`. Throws if the directory does not exist.
 *
 * Roots themselves are routinely symlinked (`/tmp -> /private/tmp` on macOS,
 * `~/repos -> /Volumes/...`), so every real-path containment check must
 * compare against the canonical root, never the configured string.
 */
export function canonicalRoot(dir: string): string {
  return realpathSync.native(path.resolve(dir));
}

/**
 * True when the canonical form of `absPath` is `realRoot` or lives under it.
 * `realRoot` must already be canonical (see `canonicalRoot`). Returns false
 * when `absPath` cannot be canonicalized (missing, dangling link, EACCES):
 * a path we cannot see through is treated as outside.
 */
export function isUnderRealRoot(realRoot: string, absPath: string): boolean {
  let real: string;
  try {
    real = realpathSync.native(absPath);
  } catch {
    return false;
  }
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return real === realRoot || real.startsWith(rootWithSep);
}

/**
 * Filesystem-aware containment for a path that already passed string
 * containment. Canonicalizes both `rootDir` and `absPath` and asserts the
 * canonical leaf is still under the canonical root — so a file symlink, or a
 * symlinked parent directory, pointing outside the root is rejected.
 *
 * Returns the canonical path (pass this, not `absPath`, to the read).
 * Throws `PathTraversalError`; the message never includes either path.
 */
export function assertRealpathWithin(rootDir: string, absPath: string): string {
  let realRoot: string;
  try {
    realRoot = canonicalRoot(rootDir);
  } catch {
    throw new PathTraversalError(absPath, "root directory is not available");
  }
  let real: string;
  try {
    real = realpathSync.native(absPath);
  } catch {
    throw new PathTraversalError(absPath, "path could not be resolved");
  }
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (real !== realRoot && !real.startsWith(rootWithSep)) {
    throw new PathTraversalError(absPath, "path resolves outside the root via a symlink");
  }
  return real;
}

/**
 * Crawl filter: true when `absPath` must be dropped from a file listing —
 * it is itself a symlink (of any target; a link to an in-root file is only a
 * duplicate), or a parent segment is a symlink that leads outside `realRoot`.
 * Any lstat/realpath failure counts as "drop" (fail closed).
 */
export function isSymlinkOrEscapes(realRoot: string, absPath: string): boolean {
  try {
    if (lstatSync(absPath).isSymbolicLink()) return true;
  } catch {
    return true;
  }
  return !isUnderRealRoot(realRoot, absPath);
}

/**
 * True when `ref` is a syntactically-safe relative path (no absolute, no
 * traversal segments). Use for early validation of glob patterns where
 * `path.resolve` semantics are not appropriate (globs are not paths).
 */
export function isSafeRelativeRef(ref: string): boolean {
  if (typeof ref !== "string") return false;
  const normalized = ref.replace(/\\/g, "/");
  if (path.isAbsolute(normalized)) return false;
  // Reject `..` as a standalone segment anywhere in the path.
  return !normalized.split("/").some((seg) => seg === "..");
}
