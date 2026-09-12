import * as vscode from "vscode";
import type { ExtensionConfig } from "./config.js";
import { readConfig, readOpenAIApiKey } from "./config.js";

/**
 * Native MCP registration (VS Code 1.101+, `vscode.lm.registerMcpServerDefinitionProvider`).
 *
 * In-editor MCP clients (Copilot Chat agent mode and anything else that
 * consumes the editor's MCP registry) discover the doc-search server through
 * this provider, so no `.vscode/mcp.json` hand-edit is needed. The definition
 * points at the stable launcher and carries the same env block the
 * `.mcp.json` generator emits, so both entry points behave identically.
 */

/** Must equal `contributes.mcpServerDefinitionProviders[].id` in package.json. */
export const MCP_PROVIDER_ID = "docSearch.mcpServers";

/** Human-readable server name shown in the editor's MCP server list. */
export const MCP_SERVER_LABEL = "Doc Search";

/** The subset of the extension config the env block depends on. */
export type McpEnvConfig = Pick<ExtensionConfig, "embedProvider" | "openaiApiKey">;

/**
 * Env block for a spawned MCP server: `DOC_SEARCH_WORKSPACE`, plus the
 * OpenAI pair when that provider is active and a key is available. Pure.
 *
 * TODO(WS2): unify with buildMcpServerEnv (src/extension/mcpEnv.ts) once that
 * helper lands, so the provider and the `.mcp.json` generator share one source.
 */
export function buildProviderEnv(
  workspaceRoot: string,
  config: McpEnvConfig,
): Record<string, string> {
  const env: Record<string, string> = { DOC_SEARCH_WORKSPACE: workspaceRoot };
  if (config.embedProvider === "openai" && config.openaiApiKey) {
    env.OPENAI_API_KEY = config.openaiApiKey;
    env.USE_OPENAI = "1";
  }
  return env;
}

export interface McpProviderDeps {
  workspaceRoot: string;
  /** Path the definition launches — the stable launcher, or the versioned fallback. */
  mcpServerPath: string;
}

/**
 * Register the definition provider. Returns undefined (and registers nothing)
 * on hosts whose `vscode.lm` lacks the API — some VS Code forks report a
 * compatible engine version but do not implement it.
 *
 * The env is rebuilt on every `provideMcpServerDefinitions` call so a
 * provider/key change in settings reaches the next server start without a
 * window reload. The server is spawned with the editor's own Node.js
 * (`process.execPath`, as the API documents), which always satisfies the
 * launcher's Node floor.
 */
export function registerMcpServerDefinitionProvider(
  context: vscode.ExtensionContext,
  deps: McpProviderDeps,
): vscode.Disposable | undefined {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== "function") return undefined;

  const version = (context.extension?.packageJSON as { version?: string } | undefined)?.version;

  return vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    provideMcpServerDefinitions: async () => {
      const apiKey = await readOpenAIApiKey(context.secrets);
      const env = buildProviderEnv(deps.workspaceRoot, readConfig(apiKey));
      return [
        new vscode.McpStdioServerDefinition(
          MCP_SERVER_LABEL,
          process.execPath,
          [deps.mcpServerPath],
          env,
          version,
        ),
      ];
    },
  });
}
