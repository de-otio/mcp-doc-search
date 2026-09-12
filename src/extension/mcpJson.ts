import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * A doc-search server path is recognized as one we own (and may rewrite) only
 * when it both points at an `mcp-server.js` and lives under a path containing
 * this extension's id. That targets a *stale install of this extension* (a
 * different publisher/version, e.g. after an upgrade) while leaving a
 * deliberate custom command alone.
 */
const EXTENSION_MARKER = "mcp-doc-search";

/**
 * True for the portable launcher form the generator writes —
 * `${HOME}/.doc-search/bin/mcp-server.js` or any other `${VAR}`-rooted
 * `mcp-server.js` path. Such a path is expanded by the MCP client at launch
 * and is current by construction, so the repair must leave it alone. Pure.
 */
export function isPortableLauncherRef(arg: unknown): boolean {
  if (typeof arg !== "string") return false;
  if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}[\\/]/.test(arg)) return false;
  // Both separators are split explicitly rather than via path.basename,
  // whose behaviour depends on the host platform.
  const segments = arg.split(/[\\/]/);
  return segments[segments.length - 1] === "mcp-server.js";
}

/**
 * Compute a repaired `.mcp.json` when its doc-search MCP server points at a
 * stale extension build. Pure: takes the current file text (or undefined when
 * the file is absent) and the path the server *should* point at, and returns
 * the rewritten text, or undefined when nothing needs to change.
 *
 * An extension upgrade changes the install dir (`de-otio.mcp-doc-search-X.Y.Z`),
 * but the `.mcp.json` written by the Generate MCP Config command embeds an
 * absolute path to the old `dist/mcp-server.js`, so the configured server
 * silently breaks. This re-points it.
 *
 * Conservative by construction: only an EXISTING `.mcp.json` with an EXISTING
 * `mcpServers["doc-search"]` entry whose `args` reference a stale doc-search
 * `mcp-server.js` is touched. We never create the file (that stays the user's
 * opt-in), never add/remove other servers, and never alter the `env` block.
 */
export function repairMcpServerPath(
  currentText: string | undefined,
  expectedServerPath: string,
): string | undefined {
  if (currentText === undefined) return undefined;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(currentText) as Record<string, unknown>;
  } catch {
    return undefined; // malformed — never clobber
  }
  if (typeof config !== "object" || config === null) return undefined;

  const servers = config.mcpServers;
  if (typeof servers !== "object" || servers === null) return undefined;
  const entry = (servers as Record<string, unknown>)["doc-search"];
  if (typeof entry !== "object" || entry === null) return undefined;

  const args = (entry as Record<string, unknown>).args;
  if (!Array.isArray(args)) return undefined;

  // A portable file is already current: the client expands the reference.
  if (args.some(isPortableLauncherRef)) return undefined;

  const idx = args.findIndex(
    (a) =>
      typeof a === "string" && path.basename(a) === "mcp-server.js" && a.includes(EXTENSION_MARKER),
  );
  if (idx === -1) return undefined;
  if (args[idx] === expectedServerPath) return undefined; // already current

  args[idx] = expectedServerPath;
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Repair a stale doc-search server path in `<workspaceRoot>/.mcp.json` in
 * place. Best-effort; returns true iff the file was rewritten. Never throws.
 */
export function repairMcpJson(workspaceRoot: string, expectedServerPath: string): boolean {
  const mcpJsonPath = path.join(workspaceRoot, ".mcp.json");
  let currentText: string;
  try {
    currentText = fs.readFileSync(mcpJsonPath, "utf8");
  } catch {
    return false; // absent or unreadable — nothing to repair
  }
  const repaired = repairMcpServerPath(currentText, expectedServerPath);
  if (repaired === undefined) return false;
  try {
    fs.writeFileSync(mcpJsonPath, repaired, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff `relPath` is tracked by git in the repository containing
 * `workspaceRoot`. A generated `.mcp.json` that is already committed would
 * publish whatever the generator writes into it, so the generator warns.
 * Best-effort: no git, no repository, or an untracked file all yield false.
 * Never throws.
 */
export function isGitTracked(workspaceRoot: string, relPath: string): boolean {
  try {
    execFileSync("git", ["-C", workspaceRoot, "ls-files", "--error-unmatch", "--", relPath], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
