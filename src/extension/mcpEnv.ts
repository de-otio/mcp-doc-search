import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionConfig } from "./config.js";

/**
 * The `env` block an MCP client must pass to the doc-search server.
 *
 * The server no longer reads trust-sensitive keys (`extraRoots`, the
 * embedding provider and its Ollama URL/model) from the workspace's
 * `.vscode/settings.json` — that file is attacker-controlled in a cloned
 * repo. Whatever the user configured in VS Code therefore has to travel to
 * the server as environment variables, and this module is the single place
 * that translates one into the other. Both the `.mcp.json` generator and the
 * native VS Code MCP provider build their env here so the two never drift.
 *
 * Pure: no VS Code, no filesystem, no process state.
 */

/** The subset of the extension configuration the MCP server env depends on. */
export type McpEnvConfig = Pick<
  ExtensionConfig,
  "docGlob" | "extraRoots" | "embedProvider" | "ollamaUrl" | "ollamaModel"
>;

/**
 * Env-variable reference for the OpenAI key. Emitted verbatim: the key
 * itself is never written to `.mcp.json`. Claude Code expands `${VAR}`
 * references in `env` values from the launching process's environment.
 */
export const OPENAI_API_KEY_REF = "${OPENAI_API_KEY}";

/**
 * Workspace reference for a portable `.mcp.json`. Claude Code sets
 * `CLAUDE_PROJECT_DIR` to the project root, so the same file works from any
 * checkout location.
 */
export const CLAUDE_PROJECT_DIR_REF = "${CLAUDE_PROJECT_DIR}";

/**
 * Build the MCP server env from the effective extension configuration.
 *
 * `workspace` is the value for `DOC_SEARCH_WORKSPACE`: an absolute path for
 * clients that pass env through unchanged, or {@link CLAUDE_PROJECT_DIR_REF}
 * for a portable Claude Code config.
 *
 * Emits only what the selected provider needs, so the resulting block is
 * minimal and the server's own defaults apply for everything else.
 */
export function buildMcpServerEnv(config: McpEnvConfig, workspace: string): Record<string, string> {
  const env: Record<string, string> = {
    DOC_SEARCH_WORKSPACE: workspace,
    DOC_SEARCH_GLOB: config.docGlob,
  };

  // The server validates the entries itself (parseExtraRoots), exactly as
  // the extension does, so the raw setting is forwarded rather than a
  // normalised copy — `~` stays `~`, which keeps the file portable.
  if (Array.isArray(config.extraRoots) && config.extraRoots.length > 0) {
    env.DOC_SEARCH_EXTRA_ROOTS = JSON.stringify(config.extraRoots);
  }

  if (config.embedProvider === "openai") {
    env.USE_OPENAI = "1";
    env.OPENAI_API_KEY = OPENAI_API_KEY_REF;
  } else if (config.embedProvider === "ollama") {
    env.OLLAMA_URL = config.ollamaUrl;
    env.OLLAMA_MODEL = config.ollamaModel;
  }

  return env;
}

/**
 * Rewrite an absolute launcher path under the user's home directory to the
 * `${HOME}/...` form Claude Code expands at launch, so the generated
 * `.mcp.json` does not embed the account name. Paths outside the home
 * directory — and every path on Windows, where `HOME` is not reliably set —
 * are returned unchanged. Pure; the home directory and platform are
 * injectable for tests.
 */
export function portableLauncherPath(
  absolutePath: string,
  opts: { homedir?: string; platform?: NodeJS.Platform } = {},
): string {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return absolutePath;
  const homedir = opts.homedir ?? os.homedir();
  if (!homedir || !path.isAbsolute(absolutePath)) return absolutePath;
  const rel = path.relative(homedir, absolutePath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return absolutePath;
  return "${HOME}/" + rel.split(path.sep).join("/");
}
