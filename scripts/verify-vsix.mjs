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
 *   - VSIX size is under a sane upper bound
 */
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";

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
const sizeBytes = statSync(vsix).size;
const sizeMB = sizeBytes / 1024 / 1024;
console.log(`Verifying ${vsix} (${sizeMB.toFixed(1)} MB)`);

const listing = execSync(`unzip -l "${vsix}"`, { encoding: "utf8" });

const required = ["extension/dist/extension.js", "extension/dist/mcp-server.js"];
const forbidden = [
  "extension/src/",
  "extension/node_modules/onnxruntime-web/",
  "extension/test/",
  "extension/coverage/",
  "extension/plans/",
];

const failures = [];

for (const r of required) {
  if (!listing.includes(r)) failures.push(`MISSING: ${r}`);
}
for (const f of forbidden) {
  if (listing.includes(f)) failures.push(`LEAKED:  ${f}`);
}

const MAX_MB = 80;
if (sizeMB > MAX_MB) {
  failures.push(`OVERSIZED: ${sizeMB.toFixed(1)} MB > ${MAX_MB} MB cap`);
}

if (failures.length > 0) {
  console.error("VSIX verification failed:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`OK: ${vsix} passed verification`);
