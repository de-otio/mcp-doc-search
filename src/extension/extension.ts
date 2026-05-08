import * as vscode from "vscode";
import * as path from "node:path";
import { LanceVectorStore } from "../core/vectorstore.js";
import { createEmbedProvider } from "../core/embedder.js";
import { Indexer } from "../core/indexer.js";
import { validateConfig } from "../core/types.js";
import { readConfig, readOpenAIApiKey } from "./config.js";
import { StatusBarManager } from "./statusBar.js";
import { registerCommands } from "./commands.js";
import { FileWatcher } from "./fileWatcher.js";
import { ensureGitignored } from "../core/gitignore.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  // Read API key from secure storage (with migration from settings if needed)
  const apiKey = await readOpenAIApiKey(context.secrets);
  const config = readConfig(apiKey);
  const indexDir = path.join(workspaceRoot, config.indexDir);
  ensureGitignored(workspaceRoot, config.indexDir);
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
