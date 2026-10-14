#!/usr/bin/env node
/**
 * Standalone CLI for mcp-doc-search.
 * Mirrors the MCP tool surface without requiring an MCP client.
 *
 * Usage:
 *   mcp-doc-search search <query> [--n N] [--json] [--files] [--min-score N] [--explain]
 *   mcp-doc-search list [--json]
 *   mcp-doc-search reindex [--force] [--drop-root <name>]... [--json]
 *   mcp-doc-search get <ref> [--from-line N] [--max-lines N] [--max-bytes N] [--json]
 *   mcp-doc-search multi-get <pattern> [--from-line N] [--max-lines N] [--max-bytes N] [--json] [--files]
 *   mcp-doc-search status [--json]
 *   mcp-doc-search context add <path> <text>
 *   mcp-doc-search context list [--json]
 *   mcp-doc-search context remove <path>
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createEngineFromEnv } from "../src/mcp/config.js";
import type { EngineDeps } from "../src/mcp/config.js";
import { search } from "../src/core/searcher.js";
import { assertRealpathWithin, PathTraversalError } from "../src/core/safePath.js";

// ---------------------------------------------------------------------------
// Minimal hand-rolled arg parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Values of repeatable flags (see REPEATABLE_FLAGS), in argv order. */
  repeated: Record<string, string[]>;
}

/** Flags that take a value and may be given more than once. */
const REPEATABLE_FLAGS = ["drop-root"];

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (REPEATABLE_FLAGS.includes(key)) {
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`--${key} requires a value`);
        }
        (repeated[key] ??= []).push(next);
        i += 2;
        continue;
      }
      if (next !== undefined && !next.startsWith("--")) {
        // check if it looks like a value (next arg exists and isn't a flag)
        const numeric = Number(next);
        if (!isNaN(numeric) && next.trim() !== "") {
          flags[key] = next;
          i += 2;
          continue;
        }
        // For non-numeric string values after known value-taking flags
        if (["n", "from-line", "max-lines", "max-bytes", "min-score"].includes(key)) {
          flags[key] = next;
          i += 2;
          continue;
        }
        // boolean flag
        flags[key] = true;
        i++;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      positionals.push(arg);
      i++;
    }
  }

  const subcommand = positionals[0] ?? "";
  return { subcommand, positionals: positionals.slice(1), flags, repeated };
}

function getFlag<T extends string | boolean | number>(
  flags: Record<string, string | boolean>,
  name: string,
  defaultVal: T,
): T {
  const v = flags[name];
  if (v === undefined) return defaultVal;
  if (typeof defaultVal === "number") return Number(v) as T;
  if (typeof defaultVal === "boolean") return (v === true || v === "true") as T;
  return v as T;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function printError(msg: string): void {
  process.stderr.write(`Error: ${msg}\n`);
}

function printHelp(): void {
  process.stdout.write(
    `mcp-doc-search — standalone CLI for the doc-search engine

USAGE
  mcp-doc-search <subcommand> [options]

SUBCOMMANDS
  search <query>         Semantic search over indexed docs
    --n N                Number of results (default: 5)
    --min-score N        Minimum score threshold (0–1)
    --explain            Show score breakdown
    --json               Emit JSON
    --files              Emit one file path per line

  list                   List all indexed files
    --json               Emit JSON

  reindex                Rebuild the search index
    --force              Re-embed all files (not just changed)
    --drop-root <name>   Remove the index entries of external root <name>
                         (repeatable). Entries under a root this process is
                         not configured with are otherwise kept.
    --json               Emit JSON

  get <ref>              Read a file: a workspace path, #docid, or
                         ext://<root>/<path> under a configured root
    --from-line N        Start at this line (0-based)
    --max-lines N        Return at most N lines
    --max-bytes N        Truncate output to N bytes
    --json               Emit JSON

  multi-get <pattern>    Read multiple files: a workspace glob, or a comma
                         list of refs (as for get)
    --from-line N        Start line (applied to each file)
    --max-lines N        Max lines per file
    --max-bytes N        Max bytes per file
    --json               Emit JSON
    --files              Emit one matched path per line

  status                 Show index health
    --json               Emit JSON

  context add <path> <text>    Attach context note to a file
  context list                 List all context notes
    --json               Emit JSON
  context remove <path>        Remove a context note

GLOBAL OPTIONS
  --json                 Machine-readable JSON output
  --help                 Show this help

ENVIRONMENT
  DOC_SEARCH_WORKSPACE         Workspace root (default: cwd)
  DOC_SEARCH_GLOB              Glob pattern (default: doc/**/*.md)
  DOC_SEARCH_HOME              Base directory for global index (default: ~/.doc-search)
  DOC_SEARCH_INDEX_LOCATION     Index location mode: "global" or "workspace" (default: global)
  DOC_SEARCH_INDEX_DIR         Workspace-mode index directory (default: .doc-search-index)
  USE_OPENAI=1                 Use OpenAI embeddings
  OLLAMA_URL                   Use Ollama embeddings at this URL
  DOC_SEARCH_EXTRA_ROOTS       External roots, as a JSON array of {name, path, glob?}
  DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1
                               Read extraRoots and the embedding provider from
                               .vscode/settings.json (only for settings you wrote)
`.trim() + "\n",
  );
}

// ---------------------------------------------------------------------------
// File reading helper (for get / multi-get)
// ---------------------------------------------------------------------------

function readFilePortion(
  absPath: string,
  fromLine: number,
  maxLines: number | null,
  maxBytes: number | null,
): string {
  const raw = readFileSync(absPath, "utf8");
  const lines = raw.split("\n");
  const sliced = lines.slice(fromLine, maxLines != null ? fromLine + maxLines : undefined);
  let text = sliced.join("\n");
  if (maxBytes != null && Buffer.byteLength(text) > maxBytes) {
    text = Buffer.from(text).slice(0, maxBytes).toString("utf8");
  }
  return text;
}

/**
 * Resolve a ref exactly as the MCP `get` tool does: `Indexer.resolveRef`
 * (workspace path, `#docid`, bare docid, or `ext://<root>/...` under a
 * configured root, each re-contained against its root), then a realpath check
 * so a symlink under the root cannot lead the read outside it. Returns the
 * real path to read and the ref's index key, or a path-free error.
 */
export function resolveCliRef(
  indexer: EngineDeps["indexer"],
  ref: string,
): { absPath: string; file: string } | { error: string } {
  const resolved = indexer.resolveRef(ref);
  if ("error" in resolved) return resolved;
  try {
    const real = assertRealpathWithin(indexer.rootForAbsPath(resolved.file), resolved.file);
    return { absPath: real, file: indexer.keyForAbsPath(resolved.file) };
  } catch (err) {
    if (err instanceof PathTraversalError) return { error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

export async function cmdSearch(
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const query = positionals[0];
  if (!query) {
    printError("search requires a query argument");
    process.exit(1);
  }

  const n = getFlag(flags, "n", 5);
  const minScore = getFlag(flags, "min-score", 0);
  const asJson = getFlag(flags, "json", false);
  const filesOnly = getFlag(flags, "files", false);
  const explain = getFlag(flags, "explain", false);

  const deps = await createEngineFromEnv();
  // Pass the indexer so excerpts carry `[Context: ...]` like the MCP path.
  let results = await search(query, n, deps.store, deps.embedProvider, { explain }, deps.indexer);

  if (minScore > 0) {
    results = results.filter((r) => r.score >= minScore);
  }

  if (filesOnly) {
    const paths = [...new Set(results.map((r) => r.file))];
    process.stdout.write(paths.join("\n") + (paths.length > 0 ? "\n" : ""));
    return;
  }

  if (asJson) {
    printJson(results);
    return;
  }

  if (results.length === 0) {
    process.stdout.write("No results.\n");
    return;
  }

  for (const r of results) {
    process.stdout.write(`\n[${r.score.toFixed(3)}] ${r.file}:${r.lineStart} — ${r.heading}\n`);
    if (explain) {
      process.stdout.write(`  score: ${r.score}\n`);
    }
    process.stdout.write(`  ${r.excerpt.replace(/\n/g, "\n  ")}\n`);
  }
}

async function cmdList(flags: Record<string, string | boolean>): Promise<void> {
  const asJson = getFlag(flags, "json", false);
  const deps = await createEngineFromEnv();
  const files = await deps.store.listFiles();

  if (asJson) {
    printJson(files);
    return;
  }

  if (files.length === 0) {
    process.stdout.write("No files indexed.\n");
    return;
  }

  for (const f of files) {
    process.stdout.write(`${f.file}  ${f.title ? "(" + f.title + ")" : ""}\n`);
  }
}

export async function cmdReindex(
  flags: Record<string, string | boolean>,
  dropRoots: string[] = [],
): Promise<void> {
  const force = getFlag(flags, "force", false);
  const asJson = getFlag(flags, "json", false);

  const deps = await createEngineFromEnv();
  const stats = await deps.indexer.reindex(force, undefined, { dropRoots });

  if (asJson) {
    printJson({ status: "ok", ...stats });
    return;
  }

  process.stdout.write(
    `Indexed ${stats.indexed} files, skipped ${stats.skipped}, ` +
      `${stats.totalChunks} chunks, ${(stats.durationMs / 1000).toFixed(1)}s\n`,
  );
  if (stats.rebuiltReason) {
    process.stdout.write(`Rebuilt the whole index: ${stats.rebuiltReason}\n`);
  }
  if (stats.droppedRoots?.length) {
    process.stdout.write(`Dropped external root(s): ${stats.droppedRoots.join(", ")}\n`);
  }
  if (stats.unconfiguredRoots?.length) {
    process.stdout.write(
      `Kept external root(s) this process is not configured with: ` +
        `${stats.unconfiguredRoots.join(", ")} (set DOC_SEARCH_EXTRA_ROOTS to include them, ` +
        `or --drop-root <name> to remove them)\n`,
    );
  }
  if (stats.compacted) {
    const mb = (stats.compacted.bytesRemoved / 1e6).toFixed(1);
    process.stdout.write(
      `Compacted index: dropped ${stats.compacted.versionsRemoved} old versions (${mb} MB)\n`,
    );
  }
}

export async function cmdGet(
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const ref = positionals[0];
  if (!ref) {
    printError("get requires a file path argument");
    process.exit(1);
  }

  const fromLine = getFlag(flags, "from-line", 0);
  const maxLines = flags["max-lines"] !== undefined ? getFlag(flags, "max-lines", 0) : null;
  const maxBytes = flags["max-bytes"] !== undefined ? getFlag(flags, "max-bytes", 0) : null;
  const asJson = getFlag(flags, "json", false);

  const { indexer } = await createEngineFromEnv();
  const resolved = resolveCliRef(indexer, ref);
  if ("error" in resolved) {
    printError(resolved.error);
    process.exit(1);
  }

  const text = readFilePortion(resolved.absPath, fromLine, maxLines, maxBytes);

  if (asJson) {
    printJson({ file: ref, fromLine, text });
    return;
  }

  process.stdout.write(text + "\n");
}

export async function cmdMultiGet(
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const pattern = positionals[0];
  if (!pattern) {
    printError("multi-get requires a pattern or comma-separated list");
    process.exit(1);
  }

  const fromLine = getFlag(flags, "from-line", 0);
  const maxLines = flags["max-lines"] !== undefined ? getFlag(flags, "max-lines", 0) : null;
  const maxBytes = flags["max-bytes"] !== undefined ? getFlag(flags, "max-bytes", 0) : null;
  const asJson = getFlag(flags, "json", false);
  const filesOnly = getFlag(flags, "files", false);

  const { indexer } = await createEngineFromEnv();
  const workspaceRoot = indexer.getWorkspaceRoot();

  // Support comma-separated list or glob. A glob matches workspace files only;
  // ext:// and #docid refs go in a comma list (or a single ref).
  let matchedFiles: string[] = [];
  if (pattern.includes(",") || !/[*?[]/.test(pattern)) {
    matchedFiles = pattern
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  } else {
    const { glob } = await import("glob");
    const abs = await glob(pattern, { cwd: workspaceRoot, absolute: true });
    matchedFiles = abs.map((f) => path.relative(workspaceRoot, f).replace(/\\/g, "/"));
  }

  if (filesOnly) {
    process.stdout.write(matchedFiles.join("\n") + (matchedFiles.length > 0 ? "\n" : ""));
    return;
  }

  const results: Array<{ file: string; text: string; error?: string }> = [];
  for (const rel of matchedFiles) {
    const resolved = resolveCliRef(indexer, rel);
    if ("error" in resolved) {
      results.push({ file: rel, text: "", error: resolved.error });
      continue;
    }
    const text = readFilePortion(resolved.absPath, fromLine, maxLines, maxBytes);
    results.push({ file: rel, text });
  }

  if (asJson) {
    printJson(results);
    return;
  }

  for (const r of results) {
    process.stdout.write(`\n=== ${r.file} ===\n`);
    if (r.error) {
      process.stdout.write(`(${r.error})\n`);
    } else {
      process.stdout.write(r.text + "\n");
    }
  }
}

export async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const asJson = getFlag(flags, "json", false);
  const deps = await createEngineFromEnv();
  const status = await deps.indexer.getStatus();

  if (asJson) {
    printJson(status);
    return;
  }

  const meta = status.meta;
  const metaLines = meta
    ? `schema:        v${meta.schemaVersion}\n` +
      `embedding:     ${meta.provider} / ${meta.model} (${meta.dim}-dim)\n` +
      `chunking:      maxChunkChars=${meta.maxChunkChars}, headingDepth=${meta.headingDepth}\n` +
      `indexCreated:  ${meta.createdAt || "unknown"}\n` +
      (meta.extraRoots ? `indexRoots:    ${meta.extraRoots.join(", ") || "none"}\n` : "")
    : `schema:        none recorded (empty or pre-0.8 index; the next reindex rebuilds it)\n`;

  process.stdout.write(
    `totalFiles:    ${status.totalFiles}\n` +
      `chunkCount:    ${status.chunkCount}\n` +
      `lastIndexed:   ${status.lastIndexed ? status.lastIndexed.toISOString() : "never"}\n` +
      `needsReindex:  ${status.needsReindex}\n` +
      `changedFiles:  ${status.changedFiles}\n` +
      `newFiles:      ${status.newFiles}\n` +
      `deletedFiles:  ${status.deletedFiles}\n` +
      `docGlob:       ${status.docGlob}\n` +
      `extraRoots:    ${status.extraRootNames?.length ? status.extraRootNames.join(", ") : "none"}\n` +
      (status.unconfiguredRoots?.length
        ? `unconfigured:  ${status.unconfiguredRoots.join(", ")} (in the index, not given to ` +
          `this process; set DOC_SEARCH_EXTRA_ROOTS or DOC_SEARCH_TRUST_WORKSPACE_SETTINGS=1)\n`
        : "") +
      `fts:           ${status.ftsIndex === undefined ? "unknown" : status.ftsIndex ? "present" : "missing"}\n` +
      `reindexLock:   ${
        status.reindexLock
          ? `held by pid ${status.reindexLock.pid} since ${status.reindexLock.startedAt} (heartbeat ${status.reindexLock.heartbeatAt.toISOString()})`
          : "none"
      }\n` +
      (status.clearedStaleLock
        ? `staleLock:     removed (pid ${status.clearedStaleLock.pid}, started ${status.clearedStaleLock.startedAt}, ${status.clearedStaleLock.staleReason})\n`
        : "") +
      metaLines,
  );
}

export async function cmdContext(
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const action = positionals[0];

  if (!action || !["add", "list", "remove"].includes(action)) {
    printError("context requires: add <path> <text> | list | remove <path>");
    process.exit(1);
  }

  const { indexer } = await createEngineFromEnv();

  if (action === "add") {
    const filePath = positionals[1];
    const text = positionals[2];
    if (!filePath || !text) {
      printError("context add requires <path> and <text>");
      process.exit(1);
    }
    indexer.setContext(filePath, text);
    process.stdout.write(`Context set for: ${filePath}\n`);
    return;
  }

  if (action === "list") {
    const asJson = getFlag(flags, "json", false);
    // A map of path prefix → note, not an array.
    const contexts = indexer.listContexts();
    if (asJson) {
      printJson(contexts);
      return;
    }
    const prefixes = Object.keys(contexts).sort();
    if (prefixes.length === 0) {
      process.stdout.write("No context notes.\n");
      return;
    }
    for (const prefix of prefixes) {
      process.stdout.write(`${prefix || "(root)"}: ${contexts[prefix]}\n`);
    }
    return;
  }

  if (action === "remove") {
    const filePath = positionals[1];
    if (!filePath) {
      printError("context remove requires <path>");
      process.exit(1);
    }
    indexer.removeContext(filePath);
    process.stdout.write(`Context removed for: ${filePath}\n`);
    return;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { subcommand, positionals, flags, repeated } = parsed;

  try {
    switch (subcommand) {
      case "search":
        await cmdSearch(positionals, flags);
        break;
      case "list":
        await cmdList(flags);
        break;
      case "reindex":
        await cmdReindex(flags, repeated["drop-root"] ?? []);
        break;
      case "get":
        await cmdGet(positionals, flags);
        break;
      case "multi-get":
        await cmdMultiGet(positionals, flags);
        break;
      case "status":
        await cmdStatus(flags);
        break;
      case "context":
        await cmdContext(positionals, flags);
        break;
      default:
        printError(`Unknown subcommand: ${subcommand}`);
        process.stderr.write("Run with --help to see available commands.\n");
        process.exit(1);
    }
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

// Only run main when this file is executed directly, not when imported by tests.
// In the bundled CJS output, require.main === module — except when loaded via
// the stable ~/.doc-search/bin launcher, where require.main is the launcher;
// the argv check covers that (the launcher is itself named mcp-doc-search.js).
// In ESM, only the argv check applies.
const argvIsCli =
  process.argv[1]?.endsWith("mcp-doc-search.js") || process.argv[1]?.endsWith("mcp-doc-search.ts");
const isMain = typeof require !== "undefined" ? require.main === module || argvIsCli : argvIsCli;

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
