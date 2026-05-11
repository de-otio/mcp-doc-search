#!/usr/bin/env node
/**
 * Standalone CLI for mcp-doc-search.
 * Mirrors the MCP tool surface without requiring an MCP client.
 *
 * Usage:
 *   mcp-doc-search search <query> [--n N] [--json] [--files] [--min-score N] [--explain]
 *   mcp-doc-search list [--json]
 *   mcp-doc-search reindex [--force] [--json]
 *   mcp-doc-search get <ref> [--from-line N] [--max-lines N] [--max-bytes N] [--json]
 *   mcp-doc-search multi-get <pattern> [--from-line N] [--max-lines N] [--max-bytes N] [--json] [--files]
 *   mcp-doc-search status [--json]
 *   mcp-doc-search context add <path> <text>
 *   mcp-doc-search context list [--json]
 *   mcp-doc-search context remove <path>
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createEngineFromEnv } from "../src/mcp/config.js";
import { search } from "../src/core/searcher.js";
import { PathTraversalError, resolveSafePath } from "../src/core/safePath.js";

// ---------------------------------------------------------------------------
// Minimal hand-rolled arg parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
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
  return { subcommand, positionals: positionals.slice(1), flags };
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
    --json               Emit JSON

  get <ref>              Read a file from the workspace
    --from-line N        Start at this line (0-based)
    --max-lines N        Return at most N lines
    --max-bytes N        Truncate output to N bytes
    --json               Emit JSON

  multi-get <pattern>    Read multiple files matching a glob or comma list
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
  DOC_SEARCH_WORKSPACE   Workspace root (default: cwd)
  DOC_SEARCH_GLOB        Glob pattern (default: doc/**/*.md)
  DOC_SEARCH_INDEX_DIR   Index directory (default: .doc-search-index)
  USE_OPENAI=1           Use OpenAI embeddings
  OLLAMA_URL             Use Ollama embeddings at this URL
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

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function cmdSearch(
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
  let results = await search(query, n, deps.store, deps.embedProvider);

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

async function cmdReindex(flags: Record<string, string | boolean>): Promise<void> {
  const force = getFlag(flags, "force", false);
  const asJson = getFlag(flags, "json", false);

  const deps = await createEngineFromEnv();
  const stats = await deps.indexer.reindex(force);

  if (asJson) {
    printJson({ status: "ok", ...stats });
    return;
  }

  process.stdout.write(
    `Indexed ${stats.indexed} files, skipped ${stats.skipped}, ` +
      `${stats.totalChunks} chunks, ${(stats.durationMs / 1000).toFixed(1)}s\n`,
  );
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

  const workspaceRoot = process.env.DOC_SEARCH_WORKSPACE ?? process.cwd();
  let absPath: string;
  try {
    absPath = resolveSafePath(workspaceRoot, ref);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      printError(`${err.message}. Refs must be relative paths inside the workspace.`);
      process.exit(1);
    }
    throw err;
  }

  if (!existsSync(absPath)) {
    printError(`File not found: ${ref}`);
    process.exit(1);
  }

  const text = readFilePortion(absPath, fromLine, maxLines, maxBytes);

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

  const workspaceRoot = process.env.DOC_SEARCH_WORKSPACE ?? process.cwd();

  // Support comma-separated list or glob
  let matchedFiles: string[] = [];
  if (pattern.includes(",")) {
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
    let absPath: string;
    try {
      absPath = resolveSafePath(workspaceRoot, rel);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        results.push({ file: rel, text: "", error: err.message });
        continue;
      }
      throw err;
    }
    if (!existsSync(absPath)) {
      results.push({ file: rel, text: "", error: "not found" });
      continue;
    }
    const text = readFilePortion(absPath, fromLine, maxLines, maxBytes);
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

async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const asJson = getFlag(flags, "json", false);
  const deps = await createEngineFromEnv();
  const status = await deps.indexer.getStatus();

  if (asJson) {
    printJson(status);
    return;
  }

  process.stdout.write(
    `totalFiles:    ${status.totalFiles}\n` +
      `chunkCount:    ${status.chunkCount}\n` +
      `lastIndexed:   ${status.lastIndexed ? status.lastIndexed.toISOString() : "never"}\n` +
      `needsReindex:  ${status.needsReindex}\n` +
      `changedFiles:  ${status.changedFiles}\n` +
      `newFiles:      ${status.newFiles}\n` +
      `deletedFiles:  ${status.deletedFiles}\n` +
      `docGlob:       ${status.docGlob}\n`,
  );
}

async function cmdContext(
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const action = positionals[0];

  if (!action || !["add", "list", "remove"].includes(action)) {
    printError("context requires: add <path> <text> | list | remove <path>");
    process.exit(1);
  }

  const deps = await createEngineFromEnv();
  const indexer = deps.indexer as any; // setContext/listContexts/removeContext may not be typed

  if (action === "add") {
    const filePath = positionals[1];
    const text = positionals[2];
    if (!filePath || !text) {
      printError("context add requires <path> and <text>");
      process.exit(1);
    }
    if (typeof indexer.setContext !== "function") {
      printError("setContext not available in this version");
      process.exit(2);
    }
    await indexer.setContext(filePath, text);
    process.stdout.write(`Context set for: ${filePath}\n`);
    return;
  }

  if (action === "list") {
    const asJson = getFlag(flags, "json", false);
    if (typeof indexer.listContexts !== "function") {
      printError("listContexts not available in this version");
      process.exit(2);
    }
    const contexts = await indexer.listContexts();
    if (asJson) {
      printJson(contexts);
    } else {
      if (!contexts || contexts.length === 0) {
        process.stdout.write("No context notes.\n");
      } else {
        for (const c of contexts) {
          process.stdout.write(`${c.file}: ${c.text}\n`);
        }
      }
    }
    return;
  }

  if (action === "remove") {
    const filePath = positionals[1];
    if (!filePath) {
      printError("context remove requires <path>");
      process.exit(1);
    }
    if (typeof indexer.removeContext !== "function") {
      printError("removeContext not available in this version");
      process.exit(2);
    }
    await indexer.removeContext(filePath);
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

  const parsed = parseArgs(argv);
  const { subcommand, positionals, flags } = parsed;

  try {
    switch (subcommand) {
      case "search":
        await cmdSearch(positionals, flags);
        break;
      case "list":
        await cmdList(flags);
        break;
      case "reindex":
        await cmdReindex(flags);
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
// In the bundled CJS output, require.main === module; in ESM, check import.meta.url.
// We use a process.argv check that works in both contexts.
const isMain =
  typeof require !== "undefined"
    ? require.main === module
    : process.argv[1]?.endsWith("mcp-doc-search.js") ||
      process.argv[1]?.endsWith("mcp-doc-search.ts");

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
