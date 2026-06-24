import * as vscode from "vscode";
import { LanceVectorStore } from "../core/vectorstore.js";
import { createEmbedProvider } from "../core/embedder.js";
import { Indexer } from "../core/indexer.js";
import { validateConfig } from "../core/types.js";
import { readConfig, readOpenAIApiKey } from "./config.js";
import { StatusBarManager } from "./statusBar.js";
import { registerCommands } from "./commands.js";
import { FileWatcher } from "./fileWatcher.js";
import { ensureGitignored } from "../core/gitignore.js";
import { resolveIndexLocation, resolveMode } from "../core/indexLocation.js";
import { repairMcpJson } from "./mcpJson.js";
import * as path from "node:path";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  // Read API key from secure storage (with migration from settings if needed)
  const apiKey = await readOpenAIApiKey(context.secrets);
  const config = readConfig(apiKey);
  const resolved = resolveIndexLocation(workspaceRoot, {
    mode: resolveMode(config.indexLocation, config.indexDir),
    indexDir: config.indexDir,
  });
  const indexDir = resolved.indexDir;
  if (resolved.shouldGitignore && resolved.gitignoreEntry)
    ensureGitignored(workspaceRoot, resolved.gitignoreEntry);

  // Keep an existing .mcp.json pointing at THIS extension build. An upgrade
  // moves the install dir, so a previously generated .mcp.json embeds a now-
  // defunct absolute path to mcp-server.js; re-point it (no-op if absent/current).
  const expectedMcpServer = path.join(context.extensionPath, "dist", "mcp-server.js");
  if (repairMcpJson(workspaceRoot, expectedMcpServer)) {
    vscode.window.showInformationMessage(
      "Doc Search: updated .mcp.json to the current extension path. Reload the window for MCP clients to pick it up.",
    );
  }
  const store = new LanceVectorStore(indexDir);
  const embedProvider = createEmbedProvider(config);
  const indexerConfig = validateConfig(
    {
      workspaceRoot,
      docGlob: config.docGlob,
      indexDir,
      maxChunkChars: config.maxChunkChars,
      headingDepth: config.headingDepth,
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
