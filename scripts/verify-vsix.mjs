#!/usr/bin/env node
/**
 * Smoke-checks a packaged VSIX before publish.
 *
 * Usage: node scripts/verify-vsix.mjs --target=<target>
 *
 * Locates the .vsix matching the given --target, lists its contents via
 * `unzip -l`, then asserts:
 *   - dist/extension.js is present
 *   - dist/mcp-server.js is present
 *   - no src/** files leaked in
 *   - no node_modules/onnxruntime-web/** files leaked in
 *   - no internal/dev files leaked in (CLAUDE.md, .vscode/, ...)
 *   - no credential-shaped files anywhere in the archive (.env*, *.pem,
 *     *.key, .npmrc, id_*, *token*, *secret*) — see FORBIDDEN_NAMES
 *   - VSIX size is under a sane upper bound
 *
 * The checks are pure functions over the entry list so they can be unit
 * tested (test/unit/verify-vsix.test.ts); the CLI wrapper at the bottom
 * only runs when this file is executed directly.
 */
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED = ["extension/dist/extension.js", "extension/dist/mcp-server.js"];

/** Path prefixes that must not appear in the archive. */
export const FORBIDDEN_PREFIXES = [
  "extension/src/",
  "extension/node_modules/onnxruntime-web/",
  "extension/test/",
  "extension/coverage/",
  "extension/plans/",
  // Internal/dev files that must never ship.
  "extension/CLAUDE.md",
  "extension/CONTRIBUTING.md",
  "extension/CODE_OF_CONDUCT.md",
  "extension/SECURITY.md",
  "extension/vitest.config.ts",
  "extension/eslint.config.mjs",
  "extension/analysis/",
  "extension/bin/",
  "extension/.doc-search-index/",
  "extension/.mcp.json",
  "extension/.vscode/",
  "extension/.claude/",
  "extension/package-lock.json",
];

/**
 * Credential-shaped file names, matched against the basename of EVERY
 * entry at any depth (a `.env` or private key three node_modules levels
 * down is just as much a leak as one at the root).
 *
 * `codeExempt` patterns are name heuristics (`*token*`, `*secret*`,
 * `id_*`) that legitimately occur as source-file names inside libraries
 * (`tokenizers.js`, `tokenize.js`, ...). For those, entries with a code
 * extension are exempt; a real credential dump is never a `.js` file.
 * File-type patterns (`.env*`, `*.pem`, `*.key`, `.npmrc`) have no exemption.
 */
export const FORBIDDEN_NAMES = [
  { label: ".env*", test: (n) => n === ".env" || n.startsWith(".env.") },
  { label: "*.pem", test: (n) => n.endsWith(".pem") },
  { label: "*.key", test: (n) => n.endsWith(".key") },
  { label: ".npmrc", test: (n) => n === ".npmrc" },
  { label: "id_*", test: (n) => n.startsWith("id_"), codeExempt: true },
  { label: "*token*", test: (n) => n.includes("token"), codeExempt: true },
  { label: "*secret*", test: (n) => n.includes("secret"), codeExempt: true },
];

const CODE_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts", ".mts", ".cts", ".map", ".wasm", ".node"];

export const MAX_MB = 80;

/**
 * Parse `unzip -l` output into the list of entry names. The name is the
 * last column and may contain spaces, so match on the three leading
 * numeric/date/time columns and take the rest verbatim.
 */
export function parseUnzipListing(text) {
  const names = [];
  for (const line of text.split("\n")) {
    const m = /^\s*\d+\s+[\d-]+\s+[\d:]+\s+(.+?)\s*$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

function isCodeFile(name) {
  const lower = name.toLowerCase();
  return CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Run every check over an archive entry list. Returns the list of failure
 * messages (empty when the VSIX passes).
 */
export function verifyEntries(entries, sizeMB) {
  const failures = [];
  const set = new Set(entries);

  for (const r of REQUIRED) {
    if (!set.has(r)) failures.push(`MISSING: ${r}`);
  }
  for (const f of FORBIDDEN_PREFIXES) {
    if (entries.some((e) => e.startsWith(f))) failures.push(`LEAKED:  ${f}`);
  }
  for (const e of entries) {
    if (e.endsWith("/")) continue; // directory entry
    const name = basename(e).toLowerCase();
    for (const rule of FORBIDDEN_NAMES) {
      if (rule.codeExempt && isCodeFile(name)) continue;
      if (rule.test(name)) failures.push(`SECRET:  ${e} (matches ${rule.label})`);
    }
  }
  if (sizeMB > MAX_MB) {
    failures.push(`OVERSIZED: ${sizeMB.toFixed(1)} MB > ${MAX_MB} MB cap`);
  }
  return failures;
}

function main() {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.replace(/^--/, "").split("=");
        return [k, v ?? true];
      }),
  );

  const target = args.target;
  if (!target) {
    console.error("Usage: node scripts/verify-vsix.mjs --target=<target>");
    process.exit(1);
  }

  const vsixes = readdirSync(".").filter((f) => f.endsWith(".vsix") && f.includes(target));
  if (vsixes.length === 0) {
    console.error(`No VSIX found for target ${target}`);
    process.exit(1);
  }
  if (vsixes.length > 1) {
    console.error(`Multiple VSIXes found for target ${target}: ${vsixes.join(", ")}`);
    process.exit(1);
  }

  const vsix = vsixes[0];
  const sizeMB = statSync(vsix).size / 1024 / 1024;
  console.log(`Verifying ${vsix} (${sizeMB.toFixed(1)} MB)`);

  const listing = execSync(`unzip -l "${vsix}"`, { encoding: "utf8" });
  const entries = parseUnzipListing(listing);
  if (entries.length === 0) {
    console.error(`Could not parse any entries from unzip -l output for ${vsix}`);
    process.exit(1);
  }

  const failures = verifyEntries(entries, sizeMB);
  if (failures.length > 0) {
    console.error("VSIX verification failed:");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log(`OK: ${vsix} passed verification (${entries.length} entries)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
