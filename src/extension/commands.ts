import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Indexer } from "../core/indexer.js";
import type { EmbedProvider } from "../core/types.js";
import type { LanceVectorStore } from "../core/vectorstore.js";
import type { ExtensionConfig } from "./config.js";
import type { StatusBarManager } from "./statusBar.js";
import { showSearchQuickPick } from "./searchPanel.js";

interface CommandDeps {
  context: vscode.ExtensionContext;
  indexer: Indexer;
  store: LanceVectorStore;
  embedProvider: EmbedProvider;
  statusBar: StatusBarManager;
  workspaceRoot: string;
  config: ExtensionConfig;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: CommandDeps,
): void {
  const { indexer, store, embedProvider, statusBar, workspaceRoot } = deps;

  context.subscriptions.push(
    vscode.commands.registerCommand("docSearch.search", async () => {
      await showSearchQuickPick({ workspaceRoot, store, embedProvider });
    }),

    vscode.commands.registerCommand("docSearch.reindex", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(refresh) Incremental",
            description: "Only reindex changed files",
            force: false,
          },
          {
            label: "$(trash) Full reindex",
            description: "Reindex all files from scratch",
            force: true,
          },
        ],
        { placeHolder: "Choose reindex mode" },
      );

      if (!choice) return;

      statusBar.setIndexing();
      try {
        const stats = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Doc Search: Indexing...",
            cancellable: false,
          },
          () => indexer.reindex(choice.force),
        );

        statusBar.setReady();
        vscode.window.showInformationMessage(
          `Doc Search: Indexed ${stats.indexed} file(s), ${stats.totalChunks} chunk(s) in ${stats.durationMs}ms (${stats.skipped} skipped).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        statusBar.setError(`Reindex failed: ${msg}`);
        vscode.window.showErrorMessage(`Doc Search: Reindex failed — ${msg}`);
      }
    }),

    vscode.commands.registerCommand(
      "docSearch.generateMcpJson",
      async () => {
        const extensionDir = context.extensionPath;
        const mcpServerPath = path.join(extensionDir, "dist", "mcp-server.js");
        const mcpJsonPath = path.join(workspaceRoot, ".mcp.json");

        const mcpConfig = {
          mcpServers: {
            "doc-search": {
              command: "node",
              args: [mcpServerPath],
            },
          },
        };

        fs.writeFileSync(
          mcpJsonPath,
          JSON.stringify(mcpConfig, null, 2) + "\n",
          "utf8",
        );

        const uri = vscode.Uri.file(mcpJsonPath);
        await vscode.window.showTextDocument(uri);
        vscode.window.showInformationMessage(
          `Doc Search: .mcp.json written to workspace root.`,
        );
      },
    ),
  );
}
