import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PROVIDER_ENV_KEYS } from "./mcpEnv.js";

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
 * True when this `args` array launches OUR server, so its `env` is ours to
 * reconcile: any argument whose final path segment is `mcp-server.js`.
 *
 * Deliberately looser than the path repair's marker test, which only matches a
 * versioned extension install dir. The launcher can legitimately be the stable
 * shim (`~/.doc-search/bin/mcp-server.js`, no extension id in the path) or a
 * `${HOME}`-rooted portable reference, and the env of those entries drifts just
 * the same. Combined with the `doc-search` server key, this is our entry.
 * Separators are split explicitly so the test does not depend on the host
 * platform. Pure.
 */
function launchesDocSearchServer(args: unknown[]): boolean {
  return args.some((a) => {
    if (typeof a !== "string") return false;
    const segments = a.split(/[\\/]/);
    return segments[segments.length - 1] === "mcp-server.js";
  });
}

/**
 * Compute a `.mcp.json` whose doc-search `env` names the embedder the user
 * configured in VS Code. Pure; returns the rewritten text, or undefined when
 * nothing needs to change.
 *
 * WHY this is automatic rather than a command the user runs: the MCP server
 * does not read `docSearch.embedProvider` from `.vscode/settings.json` (a
 * cloned repo controls that file, and redirecting embeddings to an arbitrary
 * host is exactly what the trust model refuses), so the provider only reaches
 * the server through this `env` block. A `.mcp.json` generated before the user
 * switched to Ollama therefore leaves the server on the bundled model — the
 * two ends then hold incomparable vectors, and each rebuilds the index the
 * other just built. Nothing surfaces that to the user; the first symptom is
 * indexing that never seems to finish.
 *
 * Only the keys in {@link PROVIDER_ENV_KEYS} are touched: keys the selected
 * provider needs are set, the ones it does not need are removed (a stale
 * `OLLAMA_URL` left behind by a switch to `local` would otherwise put the
 * server back on Ollama), and every other entry in `env` is the user's and is
 * preserved. An existing non-empty `OPENAI_API_KEY` is never overwritten — it
 * may be a literal key the user put there, and replacing it with a `${VAR}`
 * reference that is not set in their launch environment would break the
 * server. No secret is ever written by this function.
 */
export function repairMcpServerEnv(
  currentText: string | undefined,
  desiredProviderEnv: Record<string, string>,
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

  const entryRecord = entry as Record<string, unknown>;
  const args = entryRecord.args;
  if (!Array.isArray(args) || !launchesDocSearchServer(args)) return undefined;

  const existingEnv = entryRecord.env;
  if (existingEnv !== undefined && (typeof existingEnv !== "object" || existingEnv === null)) {
    return undefined; // hand-written into a shape we do not understand
  }
  const env = (existingEnv ?? {}) as Record<string, unknown>;

  let changed = false;
  for (const key of PROVIDER_ENV_KEYS) {
    const desired = desiredProviderEnv[key];
    if (desired === undefined) {
      if (key in env) {
        delete env[key];
        changed = true;
      }
      continue;
    }
    // Never replace a key the user supplied a real value for.
    if (key === "OPENAI_API_KEY" && typeof env[key] === "string" && env[key] !== "") continue;
    if (env[key] !== desired) {
      env[key] = desired;
      changed = true;
    }
  }
  if (!changed) return undefined;

  entryRecord.env = env;
  return JSON.stringify(config, null, 2) + "\n";
}

/** What a repair pass changed in `.mcp.json`. */
export interface McpJsonRepair {
  /** The server path was re-pointed at the current build. */
  serverPath: boolean;
  /** The `env` block was reconciled with the configured embedding provider. */
  providerEnv: boolean;
}

/**
 * Repair `<workspaceRoot>/.mcp.json` in place: re-point a stale doc-search
 * server path, and reconcile its `env` with the configured embedding provider.
 * Returns what changed, or null when the file was already correct (or absent,
 * unreadable, malformed, or not ours). Best-effort; never throws.
 *
 * Both repairs are applied to one text and written once, so an upgrade that
 * needs both does not leave a half-repaired file behind.
 */
export function repairMcpJson(
  workspaceRoot: string,
  expectedServerPath: string,
  desiredProviderEnv?: Record<string, string>,
): McpJsonRepair | null {
  const mcpJsonPath = path.join(workspaceRoot, ".mcp.json");
  let currentText: string;
  try {
    currentText = fs.readFileSync(mcpJsonPath, "utf8");
  } catch {
    return null; // absent or unreadable — nothing to repair
  }

  const pathRepaired = repairMcpServerPath(currentText, expectedServerPath);
  const afterPath = pathRepaired ?? currentText;
  const envRepaired = desiredProviderEnv
    ? repairMcpServerEnv(afterPath, desiredProviderEnv)
    : undefined;

  const finalText = envRepaired ?? pathRepaired;
  if (finalText === undefined) return null;

  try {
    fs.writeFileSync(mcpJsonPath, finalText, "utf8");
    return { serverPath: pathRepaired !== undefined, providerEnv: envRepaired !== undefined };
  } catch {
    return null;
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
