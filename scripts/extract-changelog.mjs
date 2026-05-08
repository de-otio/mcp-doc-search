#!/usr/bin/env node
/**
 * Extracts the section for a given version from CHANGELOG.md and prints
 * it to stdout. Used by the publish-extension workflow to generate
 * GitHub Release notes from the canonical CHANGELOG.
 *
 * Usage: node scripts/extract-changelog.mjs <version>
 *
 * Example:
 *   node scripts/extract-changelog.mjs 0.1.0
 *
 * Looks for a heading line of the form `## [<version>]` (Keep a Changelog
 * style), and prints every line until the next `## ` heading or end of file.
 * If no matching section is found, prints a placeholder line and exits 0
 * so the release still happens (the maintainer can edit notes later).
 */
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/extract-changelog.mjs <version>");
  process.exit(1);
}

const text = readFileSync("CHANGELOG.md", "utf8");
const lines = text.split("\n");

const headingRe = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`);
const nextHeadingRe = /^## /;

let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (headingRe.test(lines[i])) {
    start = i + 1;
    break;
  }
}

if (start === -1) {
  console.log(`Release ${version}.`);
  console.log();
  console.log(`See [CHANGELOG.md](CHANGELOG.md) for details.`);
  process.exit(0);
}

let end = lines.length;
for (let i = start; i < lines.length; i++) {
  if (nextHeadingRe.test(lines[i])) {
    end = i;
    break;
  }
}

const section = lines.slice(start, end).join("\n").trim();
process.stdout.write(section + "\n");
