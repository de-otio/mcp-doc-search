import * as vscode from "vscode";
import { search } from "../core/searcher.js";
import type { EmbedProvider } from "../core/types.js";
import type { LanceVectorStore } from "../core/vectorstore.js";

const DEBOUNCE_MS = 300;
const RESULT_COUNT = 10;
const EXCERPT_MAX = 120;

interface SearchQuickPickItem extends vscode.QuickPickItem {
  lineStart: number;
  filePath: string;
}

interface SearchDeps {
  workspaceRoot: string;
  store: LanceVectorStore;
  embedProvider: EmbedProvider;
}

export async function showSearchQuickPick(deps: SearchDeps): Promise<void> {
  const { workspaceRoot, store, embedProvider } = deps;

  const qp = vscode.window.createQuickPick<SearchQuickPickItem>();
  qp.placeholder = "Search documentation...";
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;

  let timer: ReturnType<typeof setTimeout> | undefined;

  qp.onDidChangeValue((query) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    qp.items = [];
    if (!query.trim()) return;

    qp.busy = true;
    timer = setTimeout(async () => {
      try {
        const results = await search(query, RESULT_COUNT, store, embedProvider);
        qp.items = results.map((r) => ({
          label: `$(file) ${r.heading}`,
          description: r.file,
          detail: r.excerpt.slice(0, EXCERPT_MAX),
          lineStart: r.lineStart,
          filePath: r.file,
        }));
      } catch {
        qp.items = [];
      } finally {
        qp.busy = false;
      }
    }, DEBOUNCE_MS);
  });

  qp.onDidAccept(async () => {
    const selected = qp.selectedItems[0];
    if (!selected) return;
    qp.hide();

    const absPath = vscode.Uri.joinPath(
      vscode.Uri.file(workspaceRoot),
      selected.filePath,
    );
    const lineStart = selected.lineStart;
    await vscode.window.showTextDocument(absPath, {
      selection: new vscode.Range(lineStart, 0, lineStart, 0),
    });
  });

  qp.onDidHide(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    qp.dispose();
  });

  qp.show();
}
