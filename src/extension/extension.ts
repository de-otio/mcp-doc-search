import * as vscode from "vscode";
import { LanceVectorStore } from "../core/vectorstore.js";
import { createEmbedProvider } from "../core/embedder.js";
import { parseExtraRoots } from "../core/extraRoots.js";
import { Indexer } from "../core/indexer.js";
import { validateConfig } from "../core/types.js";
import { readConfig, readOpenAIApiKey } from "./config.js";
import { StatusBarManager } from "./statusBar.js";
import { registerCommands } from "./commands.js";
import { FileWatcher } from "./fileWatcher.js";
import { ensureGitignored } from "../core/gitignore.js";
import {
  resolveIndexLocation,
  resolveMode,
  removeSupersededLegacyIndex,
} from "../core/indexLocation.js";
import { repairMcpJson } from "./mcpJson.js";
import { buildProviderEnv } from "./mcpEnv.js";
import { writeStableLaunchers } from "./stableBin.js";
import { registerMcpServerDefinitionProvider } from "./mcpProvider.js";
import * as path from "node:path";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  // Read API key from secure storage (with migration from settings if needed)
  const apiKey = await readOpenAIApiKey(context.secrets);
  const config = readConfig(apiKey);
  // Built here rather than at its first use below: the index directory is keyed
  // by the embedder, so the provider has to be known before the location is
  // resolved (see workspaceKey).
  const embedProvider = createEmbedProvider(config);
  const resolved = resolveIndexLocation(workspaceRoot, {
    mode: resolveMode(config.indexLocation, config.indexDir),
    indexDir: config.indexDir,
    embedding: embedProvider.identity?.(),
  });
  const indexDir = resolved.indexDir;
  if (resolved.shouldGitignore && resolved.gitignoreEntry)
    ensureGitignored(workspaceRoot, resolved.gitignoreEntry);

  // In global mode the in-tree `.doc-search-index` is redundant: either it was
  // just migrated (already moved away) or a populated global index supersedes
  // it. Remove any leftover so the workspace tree isn't littered with a stale
  // copy. Deletion lives here in the extension (the trusted writer) — never in
  // the MCP reader. Runs once: after removal the next activation is a no-op.
  const removedLegacy =
    resolved.mode === "global"
      ? (resolved.migratedFrom ?? removeSupersededLegacyIndex(workspaceRoot, indexDir))
      : undefined;
  if (removedLegacy) {
    vscode.window.showInformationMessage(
      "Doc Search: this workspace now uses the global index (~/.doc-search); " +
        "removed the redundant in-tree .doc-search-index folder.",
    );
  }

  // Refresh the stable launchers (~/.doc-search/bin) to forward to THIS build,
  // then re-point any existing .mcp.json still embedding a versioned extension
  // path at the stable launcher instead — once repointed, future upgrades need
  // no .mcp.json changes at all. Falls back to the versioned path if the bin
  // directory is unwritable (no-op if .mcp.json is absent/current).
  const expectedMcpServer =
    writeStableLaunchers(context.extensionPath) ??
    path.join(context.extensionPath, "dist", "mcp-server.js");
  // The env block is reconciled here too, not only by the Generate command:
  // the server cannot read the provider from settings.json (trust model), so a
  // `.mcp.json` written before the user switched providers silently leaves the
  // server on a different embedder — which since 0.8.2 means a second index,
  // and before it meant the two ends rebuilding over each other. Nobody should
  // have to hand-edit that file after an upgrade or a settings change.
  const repaired = repairMcpJson(workspaceRoot, expectedMcpServer, buildProviderEnv(config));
  if (repaired) {
    const what = [
      repaired.serverPath ? "the stable server path (~/.doc-search/bin)" : undefined,
      repaired.providerEnv ? `the ${config.embedProvider} embedding settings` : undefined,
    ]
      .filter(Boolean)
      .join(" and ");
    vscode.window.showInformationMessage(
      `Doc Search: updated .mcp.json to match ${what}. Reload the window for MCP clients to pick it up.`,
    );
  }
  // Publish the server to the editor's native MCP registry (VS Code 1.101+)
  // so in-editor clients need no config file. No-op where the API is absent.
  const mcpProvider = registerMcpServerDefinitionProvider(context, {
    workspaceRoot,
    mcpServerPath: expectedMcpServer,
  });
  if (mcpProvider) context.subscriptions.push(mcpProvider);
  const store = new LanceVectorStore(indexDir);
  const { roots: extraRoots, warnings: extraRootWarnings } = parseExtraRoots(config.extraRoots);
  for (const warning of extraRootWarnings) {
    vscode.window.showWarningMessage(`Doc Search: ${warning}`);
  }
  const indexerConfig = validateConfig(
    {
      workspaceRoot,
      docGlob: config.docGlob,
      indexDir,
      maxChunkChars: config.maxChunkChars,
      headingDepth: config.headingDepth,
      extraRoots,
    },
    embedProvider,
  );
  const indexer = new Indexer(indexerConfig, store);
  const statusBar = new StatusBarManager(context);

  registerCommands(context, {
    context,
    indexer,
    store,
    embedProvider,
    statusBar,
    workspaceRoot,
    config,
  });

  if (config.autoReindex) {
    const watcher = new FileWatcher(workspaceRoot, config.docGlob, indexer, statusBar);
    context.subscriptions.push(watcher);
  }

  // Open store, then check if a catch-up reindex is needed (async, non-blocking)
  store
    .open()
    .then(async () => {
      // A lock left by a run that VS Code killed (window reload, quit) would
      // otherwise sit until the next reindex tripped over it.
      const stale = indexer.clearStaleReindexLock();
      if (stale) {
        console.warn(
          `Doc Search: removed stale reindex lock (pid ${stale.pid}, started ${stale.startedAt}, ${stale.staleReason})`,
        );
      }
      if (!config.autoReindex) return;
      const status = await indexer.getStatus();
      if (!status.needsReindex) return;
      statusBar.setIndexing();
      try {
        await indexer.reindex(false);
        statusBar.setReady();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        statusBar.setError(`Catch-up reindex failed: ${msg}`);
      }
    })
    .catch((err) => {
      vscode.window.showWarningMessage(
        `Doc Search: Failed to open index — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

export function deactivate(): void {}
