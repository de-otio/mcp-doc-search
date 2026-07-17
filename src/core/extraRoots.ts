/**
 * External documentation roots — directories outside the workspace that are
 * indexed alongside the workspace docs (e.g. a locally cloned vendor-docs
 * repo).
 *
 * Files under an external root are keyed as `ext://<name>/<relpath>` in the
 * vector store, the mtime cache, and everywhere a workspace-relative path
 * would otherwise appear. The scheme prefix keeps the two namespaces apart:
 * a workspace-relative path can never start with `ext://` (resolveSafePath
 * would collapse it into the workspace), and an external key is never handed
 * to workspace-relative resolution.
 *
 * Security: configuring an external root grants every MCP/CLI client read
 * access to that directory subtree. Roots are therefore validated strictly
 * (absolute paths only, safe relative globs) and refs into a root are
 * re-contained with `resolveWithinBase` against the realpath of the root.
 */

import os from "node:os";
import path from "node:path";
import { isSafeRelativeRef } from "./safePath.js";

/** Ref-scheme prefix for files that live under an external root. */
export const EXT_REF_SCHEME = "ext://";

/** Default glob applied inside an external root (mdx included: vendor docs
 * corpora are commonly MDX). */
export const DEFAULT_EXTRA_ROOT_GLOB = "**/*.{md,mdx}";

/** Root names: short, filesystem/URL-safe identifiers. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ExtraRoot {
  /** Unique short identifier, used in `ext://<name>/...` refs. */
  name: string;
  /** Absolute directory path (a leading `~` has been expanded). */
  path: string;
  /** Glob evaluated relative to `path`. */
  glob: string;
}

export interface ParsedExtraRoots {
  roots: ExtraRoot[];
  /** Human-readable reasons for every entry that was dropped or adjusted. */
  warnings: string[];
}

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandHome(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homeDir, p.slice(2));
  }
  return p;
}

/**
 * Validate and normalize a raw `extraRoots` config value (from VS Code
 * settings, `.vscode/settings.json`, or the `DOC_SEARCH_EXTRA_ROOTS` env
 * var). Invalid entries are dropped with a warning — a bad entry must never
 * take the whole engine down, and must never widen access beyond what was
 * explicitly and correctly configured.
 */
export function parseExtraRoots(raw: unknown, homeDir: string = os.homedir()): ParsedExtraRoots {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { roots: [], warnings };
  if (!Array.isArray(raw)) {
    warnings.push(`extraRoots must be an array; got ${typeof raw} — ignoring`);
    return { roots: [], warnings };
  }

  const roots: ExtraRoot[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      warnings.push(`extraRoots entry is not an object — skipped`);
      continue;
    }
    const e = entry as Record<string, unknown>;

    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!NAME_PATTERN.test(name)) {
      warnings.push(
        `extraRoots entry has invalid name ${JSON.stringify(e.name)} ` +
          `(need 1-64 chars of [A-Za-z0-9._-], starting alphanumeric) — skipped`,
      );
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`extraRoots entry duplicates name "${name}" — skipped`);
      continue;
    }

    const rawPath = typeof e.path === "string" ? e.path.trim() : "";
    if (!rawPath) {
      warnings.push(`extraRoots entry "${name}" has no path — skipped`);
      continue;
    }
    const expanded = expandHome(rawPath, homeDir);
    if (!path.isAbsolute(expanded)) {
      warnings.push(
        `extraRoots entry "${name}" has a relative path ${JSON.stringify(rawPath)} ` +
          `(must be absolute, or start with ~) — skipped`,
      );
      continue;
    }

    let glob = DEFAULT_EXTRA_ROOT_GLOB;
    if (e.glob !== undefined) {
      const rawGlob = typeof e.glob === "string" ? e.glob.trim() : "";
      if (rawGlob && isSafeRelativeRef(rawGlob)) {
        glob = rawGlob;
      } else {
        warnings.push(
          `extraRoots entry "${name}" has an unsafe glob ${JSON.stringify(e.glob)} ` +
            `(absolute or contains ..) — using default "${DEFAULT_EXTRA_ROOT_GLOB}"`,
        );
      }
    }

    seen.add(name);
    roots.push({ name, path: path.resolve(expanded), glob });
  }

  return { roots, warnings };
}

/** Compose the index key for a file under an external root. */
export function extKey(rootName: string, rel: string): string {
  return `${EXT_REF_SCHEME}${rootName}/${rel.replace(/\\/g, "/")}`;
}

/**
 * Split an `ext://<name>/<rel>` key into its parts.
 * Returns null when the key is not a well-formed external ref
 * (missing scheme, empty name, or empty relative part).
 */
export function parseExtKey(key: string): { name: string; rel: string } | null {
  if (!key.startsWith(EXT_REF_SCHEME)) return null;
  const rest = key.slice(EXT_REF_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const name = rest.slice(0, slash);
  const rel = rest.slice(slash + 1);
  if (!rel) return null;
  return { name, rel };
}
