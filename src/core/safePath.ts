/**
 * Safe-path resolution for user-supplied refs.
 *
 * Every place that turns a caller-supplied relative path into an absolute
 * filesystem path must verify the result still lives inside the workspace
 * root. Mid-path `..` segments, absolute refs, Windows-style separators on
 * POSIX, and prefix attacks (`workspace-evil` vs `workspace`) all need to
 * be rejected here, not at each call site.
 *
 * Symlinks: this helper validates the resolved path; if the caller later
 * passes that path to fs functions, the OS will follow symlinks normally.
 * Callers that need symlink-aware containment should use realpath separately.
 */

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
