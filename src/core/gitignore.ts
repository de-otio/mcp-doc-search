import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Ensures that `entry` (e.g. ".doc-search-index") appears in the workspace's
 * .gitignore. Creates the file if it doesn't exist. Does nothing if the entry
 * is already present (exact line or via a parent glob).
 */
export function ensureGitignored(workspaceRoot: string, entry: string): void {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");

  let existing = "";
  try {
    existing = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    // File doesn't exist — we'll create it below
  }

  // Check if already covered by an exact match on any non-comment line
  const lines = existing.split("\n").map((l) => l.trim());
  const alreadyCovered = lines.some((l) => !l.startsWith("#") && l !== "" && entry === l);
  if (alreadyCovered) return;

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, `${separator}# doc-search index\n${entry}\n`, "utf8");
}
