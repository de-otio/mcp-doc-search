import * as vscode from "vscode";
import * as path from "node:path";
import { LanceVectorStore } from "../core/vectorstore.js";
import { createEmbedProvider } from "../core/embedder.js";
import { Indexer } from "../core/indexer.js";
import { readConfig } from "./config.js";
import { StatusBarManager } from "./statusBar.js";
import { registerCommands } from "./commands.js";
import { FileWatcher } from "./fileWatcher.js";
import { ensureGitignored } from "../core/gitignore.js";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const config = readConfig();
  const indexDir = path.join(workspaceRoot, config.indexDir);
  ensureGitignored(workspaceRoot, config.indexDir);
  const store = new LanceVectorStore(indexDir);
  const embedProvider = createEmbedProvider(config);
  const indexer = new Indexer(
    { workspaceRoot, ...config, indexDir, embedProvider },
    store,
  );
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
    const watcher = new FileWatcher(
      workspaceRoot,
      config.docGlob,
      indexer,
      statusBar,
    );
    context.subscriptions.push(watcher);
  }

  // Open store (async, non-blocking)
  store.open().catch((err) => {
    vscode.window.showWarningMessage(
      `Doc Search: Failed to open index — ${err instanceof Error ? err.message : String(err)}`,
    );
  });

}

export function deactivate(): void {}
