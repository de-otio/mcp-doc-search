import * as vscode from "vscode";
import { search } from "../core/searcher.js";
import { isSafeRelativeRef } from "../core/safePath.js";
import type { EmbedProvider } from "../core/types.js";
import type { LanceVectorStore } from "../core/vectorstore.js";
import { getNonce } from "./utils.js";

const RESULT_COUNT = 10;

interface SearchDeps {
  workspaceRoot: string;
  store: LanceVectorStore;
  embedProvider: EmbedProvider;
}

export class SearchPanel {
  private static instance: SearchPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly deps: SearchDeps;
  private disposed = false;

  static reset(): void {
    this.instance = undefined;
  }

  static createOrShow(context: vscode.ExtensionContext, deps: SearchDeps): void {
    if (SearchPanel.instance) {
      SearchPanel.instance.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "docSearchResults",
      "Doc Search",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SearchPanel.instance = new SearchPanel(panel, context, deps);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    deps: SearchDeps,
  ) {
    this.panel = panel;
    this.deps = deps;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      this.disposed = true;
      SearchPanel.instance = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      context.subscriptions,
    );
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case "search": {
        const query = msg.query?.trim();
        if (!query || this.disposed) return;
        if (!this.disposed) this.panel.webview.postMessage({ type: "searching" });
        try {
          const results = await search(
            query,
            RESULT_COUNT,
            this.deps.store,
            this.deps.embedProvider,
          );
          if (!this.disposed) {
            this.panel.webview.postMessage({ type: "results", query, results });
          }
        } catch (err) {
          if (!this.disposed) {
            this.panel.webview.postMessage({
              type: "results",
              query,
              results: [],
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        break;
      }

      case "openResult": {
        // L1: validate msg.file before joining onto workspaceRoot. The
        // webview is trusted today, but a future render bug could turn a
        // search result path into ../../etc/passwd. isSafeRelativeRef
        // rejects absolute paths and any `..` segment.
        if (typeof msg.file !== "string" || !isSafeRelativeRef(msg.file)) break;
        const absPath = vscode.Uri.joinPath(vscode.Uri.file(this.deps.workspaceRoot), msg.file);
        await vscode.commands.executeCommand("markdown.showPreviewToSide", absPath);
        break;
      }
    }
  }

  private getHtml(): string {
    const nonce = getNonce();
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Doc Search</title>
<style nonce="${nonce}">
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 20px;
    max-width: 700px;
  }
  h1 { font-size: 1.4em; margin-bottom: 16px; }
  .search-bar {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }
  .search-bar input {
    flex: 1;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-size: var(--vscode-font-size);
  }
  .search-bar input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  button {
    padding: 6px 14px;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  #statusMsg {
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    display: none;
  }
  #statusMsg.visible { display: block; }
  #statusMsg.error { color: var(--vscode-errorForeground); }
  .result-item {
    padding: 10px 12px;
    margin-bottom: 8px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .result-item:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
  }
  .result-heading {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .result-file {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }
  .result-excerpt {
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
    white-space: pre-wrap;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }
</style>
</head>
<body>
  <h1>Search Documentation</h1>
  <div class="search-bar">
    <input type="text" id="queryInput" placeholder="Search documentation..." autofocus>
    <button class="btn-primary" id="searchBtn">Search</button>
  </div>
  <p id="statusMsg"></p>
  <div id="results"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const queryInput = $("queryInput");
    const resultsDiv = $("results");
    const statusMsg = $("statusMsg");

    function doSearch() {
      const query = queryInput.value.trim();
      if (!query) return;
      vscode.postMessage({ type: "search", query });
    }

    queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });
    $("searchBtn").addEventListener("click", doSearch);

    resultsDiv.addEventListener("click", (e) => {
      const item = e.target.closest(".result-item");
      if (!item) return;
      vscode.postMessage({
        type: "openResult",
        file: item.dataset.file,
        lineStart: parseInt(item.dataset.line, 10),
      });
    });

    function escapeHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function escapeAttr(s) {
      return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    }

    window.addEventListener("message", (e) => {
      const msg = e.data;
      if (msg.type === "searching") {
        statusMsg.textContent = "Searching\u2026";
        statusMsg.className = "visible";
        resultsDiv.innerHTML = "";
      }
      if (msg.type === "results") {
        if (msg.error) {
          statusMsg.textContent = "Search failed: " + msg.error;
          statusMsg.className = "visible error";
          return;
        }
        if (msg.results.length === 0) {
          statusMsg.textContent = "No results for \\u201c" + escapeHtml(msg.query) + "\\u201d";
          statusMsg.className = "visible";
          return;
        }
        statusMsg.textContent = msg.results.length + " result(s)";
        statusMsg.className = "visible";
        resultsDiv.innerHTML = msg.results.map((r) =>
          '<div class="result-item" data-file="' + escapeAttr(r.file) + '" data-line="' + r.lineStart + '">'
          + '<div class="result-heading">' + escapeHtml(r.heading) + '</div>'
          + '<div class="result-file">' + escapeHtml(r.file) + ' \\u00b7 line ' + r.lineStart + ' \\u00b7 score ' + r.score + '</div>'
          + '<div class="result-excerpt">' + escapeHtml(r.excerpt.slice(0, 300)) + '</div>'
          + '</div>'
        ).join("");
      }
    });
  </script>
</body>
</html>`;
  }
}
