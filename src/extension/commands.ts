import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { Indexer } from "../core/indexer.js";
import type { EmbedProvider } from "../core/types.js";
import { validateConfig } from "../core/types.js";
import { createEmbedProvider } from "../core/embedder.js";
import type { LanceVectorStore } from "../core/vectorstore.js";
import type { ExtensionConfig } from "./config.js";
import { readConfig, readOpenAIApiKey } from "./config.js";
import type { StatusBarManager } from "./statusBar.js";
import { SearchPanel } from "./searchPanel.js";
import { SettingsPanel } from "./settingsPanel.js";
import { IndexStatusPanel } from "./indexStatusPanel.js";
import { McpSetupPanel } from "./mcpSetupPanel.js";
import { ensureGitignored } from "../core/gitignore.js";

interface CommandDeps {
  context: vscode.ExtensionContext;
  indexer: Indexer;
  store: LanceVectorStore;
  embedProvider: EmbedProvider;
  statusBar: StatusBarManager;
  workspaceRoot: string;
  config: ExtensionConfig;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { store, statusBar, workspaceRoot } = deps;

  context.subscriptions.push(
    vscode.commands.registerCommand("docSearch.search", async () => {
      // Re-read config so the search uses whichever provider is currently configured
      const apiKey = await readOpenAIApiKey(deps.context.secrets);
      const freshConfig = readConfig(apiKey);
      const freshEmbedProvider = createEmbedProvider(freshConfig);
      SearchPanel.createOrShow(context, {
        workspaceRoot,
        store,
        embedProvider: freshEmbedProvider,
      });
    }),

    vscode.commands.registerCommand("docSearch.reindex", async (forceArg?: boolean) => {
      let force: boolean;
      if (forceArg !== undefined) {
        force = forceArg;
      } else {
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
        force = choice.force;
      }

      // Re-read config so provider changes take effect without a window reload
      const apiKey = await readOpenAIApiKey(deps.context.secrets);
      const freshConfig = readConfig(apiKey);
      const freshEmbedProvider = createEmbedProvider(freshConfig);
      const freshIndexerConfig = validateConfig(
        {
          workspaceRoot,
          docGlob: freshConfig.docGlob,
          indexDir: path.join(workspaceRoot, freshConfig.indexDir),
          maxChunkChars: freshConfig.maxChunkChars,
          headingDepth: freshConfig.headingDepth,
        },
        freshEmbedProvider,
      );
      const freshIndexer = new Indexer(freshIndexerConfig, store);

      statusBar.setIndexing();
      IndexStatusPanel.notifyProgress("scanning");
      try {
        const stats = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Doc Search",
            cancellable: false,
          },
          async (progress) => {
            let lastIncrement = 0;
            return freshIndexer.reindex(force, (processed, total, file, phase) => {
              const baseName = file ? path.basename(file) : "";
              if (phase === "scanning") {
                progress.report({ message: "Scanning files…" });
              } else if (phase === "loading") {
                progress.report({
                  message:
                    total > 0 ? `Loading AI model… (0 / ${total} files)` : "Loading AI model…",
                });
              } else {
                const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
                const increment = pct - lastIncrement;
                lastIncrement = pct;
                progress.report({
                  message: `${processed} / ${total} files — ${baseName}`,
                  increment,
                });
              }
              IndexStatusPanel.notifyProgress(phase, processed, total);
            });
          },
        );

        statusBar.setReady();
        await IndexStatusPanel.notifyDone(stats);
        vscode.window.showInformationMessage(
          `Doc Search: Indexed ${stats.indexed} file(s), ${stats.totalChunks} chunk(s) in ${stats.durationMs}ms (${stats.skipped} skipped).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        statusBar.setError(`Reindex failed: ${msg}`);
        IndexStatusPanel.notifyError(msg);
        vscode.window.showErrorMessage(`Doc Search: Reindex failed — ${msg}`);
      }
    }),

    vscode.commands.registerCommand("docSearch.openIndexStatus", () => {
      IndexStatusPanel.createOrShow(context, deps.indexer);
    }),

    vscode.commands.registerCommand("docSearch.openSettings", () => {
      SettingsPanel.createOrShow(context);
    }),

    vscode.commands.registerCommand("docSearch.openWalkthrough", () => {
      vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        "de-otio-org.mcp-doc-search#docSearch.getStarted",
        false,
      );
    }),

    vscode.commands.registerCommand("docSearch.generateMcpJson", async () => {
      const extensionDir = context.extensionPath;
      const mcpServerPath = path.join(extensionDir, "dist", "mcp-server.js");
      const mcpJsonPath = path.join(workspaceRoot, ".mcp.json");

      const env: Record<string, string> = {
        DOC_SEARCH_WORKSPACE: workspaceRoot,
      };

      let mcpConfig: Record<string, unknown> = {};
      if (fs.existsSync(mcpJsonPath)) {
        try {
          mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
        } catch {
          // If the file is malformed, start fresh
        }
      }

      const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) ?? {};
      mcpServers["doc-search"] = {
        command: "node",
        args: [mcpServerPath],
        env,
      };
      mcpConfig.mcpServers = mcpServers;

      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
      ensureGitignored(workspaceRoot, ".mcp.json");

      McpSetupPanel.createOrShow(context, { mcpServerPath, env });
    }),
  );
}
