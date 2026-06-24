import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A doc-search server path is recognized as one we own (and may rewrite) only
 * when it both points at an `mcp-server.js` and lives under a path containing
 * this extension's id. That targets a *stale install of this extension* (a
 * different publisher/version, e.g. after an upgrade) while leaving a
 * deliberate custom command alone.
 */
const EXTENSION_MARKER = "mcp-doc-search";

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
