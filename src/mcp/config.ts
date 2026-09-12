import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { LanceVectorStore } from "../core/vectorstore.js";
import { Indexer } from "../core/indexer.js";
import { LocalEmbedder, OllamaEmbedder, OpenAIEmbedder } from "../core/embedder.js";
import type { EmbedProvider } from "../core/types.js";
import { validateConfig } from "../core/types.js";
import { ensureGitignored } from "../core/gitignore.js";
import { parseExtraRoots } from "../core/extraRoots.js";
import { isSafeRelativeRef } from "../core/safePath.js";
import { resolveIndexLocation, resolveMode } from "../core/indexLocation.js";

const DEFAULT_DOC_GLOB = "doc/**/*.md";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";

/**
 * Opt-in: when set to `1`, the trust-sensitive keys below may also be read
 * from the workspace's `.vscode/settings.json`. Off by default because that
 * file is attacker-controlled in a cloned repo — see the trust model in
 * doc/configuration.md.
 */
export const TRUST_WORKSPACE_SETTINGS_ENV = "DOC_SEARCH_TRUST_WORKSPACE_SETTINGS";

/**
 * Settings keys that can reach outside the workspace (grant read access to
 * arbitrary directories, or send every chunk and query to an arbitrary
 * host). Read from env only unless the opt-in above is set.
 */
const TRUST_SENSITIVE_KEYS = [
  "docSearch.extraRoots",
  "docSearch.embedProvider",
  "docSearch.ollamaUrl",
  "docSearch.ollamaModel",
] as const;

export interface EngineDeps {
  store: LanceVectorStore;
  indexer: Indexer;
  embedProvider: EmbedProvider;
}

function warn(message: string): void {
  process.stderr.write(`mcp-doc-search: ${message}\n`);
}

/**
 * Read VS Code workspace settings from .vscode/settings.json.
 * Properly parses JSONC (JSON with comments) format.
 * Returns the parsed object, or {} if the file doesn't exist or can't be parsed.
 */
function readWorkspaceSettings(workspaceRoot: string): Record<string, any> {
  const settingsPath = path.join(workspaceRoot, ".vscode", "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * True when `url` parses as an http(s) URL whose host is a loopback address
 * (`localhost`, `127.0.0.0/8`, `::1`). Anything else — including a
 * non-URL string — is not loopback. Pure.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Detect an env value a client was supposed to expand but did not — e.g. a
 * portable `.mcp.json` with `"${CLAUDE_PROJECT_DIR}"` launched by a client
 * that does not know the variable.
 */
function isUnexpandedReference(value: string): boolean {
  return /^\$\{[^}]*\}$/.test(value.trim());
}

function resolveWorkspaceRoot(): string {
  const raw = process.env.DOC_SEARCH_WORKSPACE;
  if (raw === undefined || raw === "") return process.cwd();
  if (isUnexpandedReference(raw)) {
    warn(
      `DOC_SEARCH_WORKSPACE is the unexpanded reference ${JSON.stringify(raw)}; ` +
        `the MCP client did not substitute it — using the current directory instead`,
    );
    return process.cwd();
  }
  return raw;
}

export async function createEngineFromEnv(): Promise<EngineDeps> {
  const workspaceRoot = resolveWorkspaceRoot();
  const settings = readWorkspaceSettings(workspaceRoot);

  // Trust model (see doc/configuration.md): the workspace is attacker-
  // controlled, so settings.json may only influence keys that cannot escape
  // the workspace. The trust-sensitive keys come from env — the user's own
  // .mcp.json or shell — unless the user opts in explicitly. Env always wins
  // over settings.json for every key.
  const trustWorkspace = process.env[TRUST_WORKSPACE_SETTINGS_ENV] === "1";
  const trusted = (key: (typeof TRUST_SENSITIVE_KEYS)[number]): unknown =>
    trustWorkspace ? settings[key] : undefined;
  if (trustWorkspace) {
    warn(
      `${TRUST_WORKSPACE_SETTINGS_ENV}=1: reading extraRoots and embedding-provider ` +
        `settings from ${path.join(workspaceRoot, ".vscode", "settings.json")}`,
    );
  } else {
    const ignored = TRUST_SENSITIVE_KEYS.filter((key) => settings[key] !== undefined);
    if (ignored.length > 0) {
      warn(
        `ignoring ${ignored.join(", ")} from .vscode/settings.json (workspace settings are ` +
          `not trusted); set the equivalent env vars in .mcp.json, or ` +
          `${TRUST_WORKSPACE_SETTINGS_ENV}=1 to opt in`,
      );
    }
  }

  // L2: reject globs that escape the workspace; the glob is not a path, so we
  // validate it as a syntactically-safe relative ref rather than resolving it.
  const rawGlob = process.env.DOC_SEARCH_GLOB ?? settings["docSearch.docGlob"] ?? DEFAULT_DOC_GLOB;
  let docGlob: string;
  if (isSafeRelativeRef(rawGlob)) {
    docGlob = rawGlob;
  } else {
    warn(
      `rejecting unsafe docGlob "${rawGlob}" (absolute or contains ..); ` +
        `falling back to "${DEFAULT_DOC_GLOB}"`,
    );
    docGlob = DEFAULT_DOC_GLOB;
  }

  const rawIndexDir = process.env.DOC_SEARCH_INDEX_DIR ?? settings["docSearch.indexDir"];
  const mode = resolveMode(
    process.env.DOC_SEARCH_INDEX_LOCATION ?? settings["docSearch.indexLocation"],
    rawIndexDir,
  );
  const resolved = resolveIndexLocation(workspaceRoot, {
    mode,
    indexDir: rawIndexDir,
    env: process.env,
  });
  const indexDir = resolved.indexDir;
  if (resolved.shouldGitignore && resolved.gitignoreEntry)
    ensureGitignored(workspaceRoot, resolved.gitignoreEntry);
  const maxChunkChars = settings["docSearch.maxChunkChars"] ?? 4000;
  const headingDepth = settings["docSearch.headingDepth"] ?? 2;

  // External roots: env var (JSON array) → settings.json (opt-in only) → none.
  // NOTE: an external root grants MCP/CLI clients read access to a directory
  // OUTSIDE the workspace — parseExtraRoots drops anything malformed and the
  // indexer re-contains every ref against the declared root.
  let rawExtraRoots: unknown = trusted("docSearch.extraRoots");
  if (process.env.DOC_SEARCH_EXTRA_ROOTS) {
    try {
      rawExtraRoots = JSON.parse(process.env.DOC_SEARCH_EXTRA_ROOTS);
    } catch {
      warn(`DOC_SEARCH_EXTRA_ROOTS is not valid JSON; ignoring it`);
    }
  }
  const { roots: extraRoots, warnings: extraRootWarnings } = parseExtraRoots(rawExtraRoots);
  for (const warning of extraRootWarnings) warn(warning);

  // Embedding provider: env vars → settings.json (opt-in only) → local
  const providerName =
    (process.env.USE_OPENAI === "1" ? "openai" : undefined) ??
    (process.env.OLLAMA_URL ? "ollama" : undefined) ??
    trusted("docSearch.embedProvider") ??
    "local";

  let embedProvider: EmbedProvider;
  if (providerName === "openai") {
    // M1: never read the OpenAI key from settings.json. The extension stores
    // it in VS Code's SecretStorage (per-machine, encrypted). For the MCP
    // server and CLI the only supported source is the OPENAI_API_KEY env var,
    // set by the user in .mcp.json or their shell. Reading settings.json
    // here exposed the key in plaintext via JSONC parsing of a file that
    // is commonly committed to repos.
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    embedProvider = new OpenAIEmbedder(apiKey);
  } else if (providerName === "ollama") {
    const ollamaModel =
      process.env.OLLAMA_MODEL ?? trusted("docSearch.ollamaModel") ?? DEFAULT_OLLAMA_MODEL;
    embedProvider = new OllamaEmbedder(String(ollamaModel), resolveOllamaUrl(trusted));
  } else {
    embedProvider = new LocalEmbedder({ model: process.env.DOC_SEARCH_LOCAL_MODEL });
  }

  const store = new LanceVectorStore(indexDir);
  await store.open();

  const config = validateConfig(
    {
      workspaceRoot,
      docGlob,
      indexDir,
      maxChunkChars,
      headingDepth: headingDepth as 1 | 2,
      extraRoots,
    },
    embedProvider,
  );

  const indexer = new Indexer(config, store);

  return { store, indexer, embedProvider };
}

/**
 * Ollama URL: env → settings.json (opt-in only) → default. A URL from env is
 * taken as-is (the user wrote it). A URL from settings.json must be loopback
 * even after the opt-in — a repo must never be able to redirect every chunk
 * and query to a host of its choosing.
 */
function resolveOllamaUrl(trusted: (key: "docSearch.ollamaUrl") => unknown): string {
  if (process.env.OLLAMA_URL) return process.env.OLLAMA_URL;
  const fromSettings = trusted("docSearch.ollamaUrl");
  if (fromSettings === undefined) return DEFAULT_OLLAMA_URL;
  const candidate = String(fromSettings);
  if (isLoopbackUrl(candidate)) return candidate;
  warn(
    `docSearch.ollamaUrl ${JSON.stringify(candidate)} from .vscode/settings.json is not a ` +
      `loopback address; using ${DEFAULT_OLLAMA_URL} (set OLLAMA_URL in the env to use a remote host)`,
  );
  return DEFAULT_OLLAMA_URL;
}
