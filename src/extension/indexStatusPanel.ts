import * as vscode from "vscode";
import type { Indexer } from "../core/indexer.js";
import { getNonce } from "./utils.js";

export class IndexStatusPanel {
  private static instance: IndexStatusPanel | undefined;
  /** True while any reindex (from command or panel) is running. */
  static busy = false;
  private readonly panel: vscode.WebviewPanel;
  private readonly indexer: Indexer;

  static reset(): void {
    this.instance = undefined;
  }

  /** Called by the reindex command to push progress into the panel if it's open. */
  static notifyProgress(phase: string, processed?: number, total?: number): void {
    IndexStatusPanel.busy = true;
    IndexStatusPanel.instance?.panel.webview.postMessage({
      type: "indexing",
      phase,
      processed,
      total,
    });
  }

  static async notifyDone(stats: {
    indexed: number;
    totalChunks: number;
    skipped: number;
    durationMs: number;
  }): Promise<void> {
    IndexStatusPanel.busy = false;
    const inst = IndexStatusPanel.instance;
    if (!inst) return;
    await inst.sendStatus();
    inst.panel.webview.postMessage({ type: "reindexDone", stats });
  }

  static notifyError(message: string): void {
    IndexStatusPanel.busy = false;
    IndexStatusPanel.instance?.panel.webview.postMessage({ type: "reindexError", message });
  }

  static createOrShow(context: vscode.ExtensionContext, indexer: Indexer): void {
    if (IndexStatusPanel.instance) {
      IndexStatusPanel.instance.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "docSearchIndexStatus",
      "Doc Search: Index Status",
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    IndexStatusPanel.instance = new IndexStatusPanel(panel, context, indexer);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    indexer: Indexer,
  ) {
    this.panel = panel;
    this.indexer = indexer;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      IndexStatusPanel.instance = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      context.subscriptions,
    );
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "refresh":
        await this.sendStatus();
        // If a reindex is already running, restore the indexing state in the panel
        if (IndexStatusPanel.busy) {
          this.panel.webview.postMessage({ type: "indexing", phase: "scanning" });
        }
        break;

      case "reindex":
        await this.runReindex(msg.force);
        break;
    }
  }

  private async runReindex(force: boolean): Promise<void> {
    if (IndexStatusPanel.busy) return;
    IndexStatusPanel.busy = true;
    this.panel.webview.postMessage({ type: "indexing", phase: "scanning" });
    try {
      const stats = await this.indexer.reindex(force, (processed, total, _file, phase) => {
        try {
          this.panel.webview.postMessage({ type: "indexing", phase, processed, total });
        } catch {
          // panel disposed during reindex
        }
      });
      IndexStatusPanel.busy = false;
      await this.sendStatus();
      this.panel.webview.postMessage({ type: "reindexDone", stats });
      this.panel.reveal();
    } catch (err) {
      IndexStatusPanel.busy = false;
      const message = err instanceof Error ? err.message : String(err);
      try {
        this.panel.webview.postMessage({ type: "reindexError", message });
      } catch {
        // panel disposed
      }
    }
  }

  private async sendStatus(): Promise<void> {
    try {
      const status = await this.indexer.getStatus();
      const provider = vscode.workspace
        .getConfiguration("docSearch")
        .get<string>("embedProvider", "local");
      this.panel.webview.postMessage({
        type: "status",
        status: {
          ...status,
          lastIndexed: status.lastIndexed ? status.lastIndexed.toISOString() : null,
        },
        embedProvider: provider,
      });
    } catch (err) {
      this.panel.webview.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
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
<title>Doc Search: Index Status</title>
<style nonce="${nonce}">
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 20px;
    max-width: 560px;
  }
  .header-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 16px;
  }
  h1 { font-size: 1.4em; margin: 0; }
  .btn-refresh {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-foreground);
    opacity: 0.55;
    font-size: 1.1em;
    padding: 2px 4px;
    line-height: 1;
  }
  .btn-refresh:hover { opacity: 1; }

  /* Status badge */
  .badge {
    display: inline-block;
    padding: 3px 12px;
    border-radius: 10px;
    font-size: 0.85em;
    font-weight: 600;
    margin-bottom: 20px;
  }
  .badge-ok   { background: var(--vscode-testing-iconPassed);      color: var(--vscode-editor-background); }
  .badge-warn { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
  .badge-none { background: var(--vscode-testing-iconFailed);       color: var(--vscode-editor-background); }

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 20px;
  }
  .stat-card {
    padding: 10px 14px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
  }
  .stat-label {
    font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 2px;
  }
  .stat-value {
    font-size: 1.7em;
    font-weight: 600;
    line-height: 1.2;
  }
  .stat-card.attention .stat-value { color: var(--vscode-editorWarning-foreground); }

  /* Meta rows */
  .meta {
    display: flex;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 0.9em;
  }
  .meta-label {
    color: var(--vscode-descriptionForeground);
    min-width: 120px;
    flex-shrink: 0;
  }
  code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
    background: var(--vscode-editor-background);
    padding: 1px 4px;
    border-radius: 2px;
    border: 1px solid var(--vscode-widget-border);
  }

  hr {
    border: none;
    border-top: 1px solid var(--vscode-widget-border);
    margin: 20px 0;
  }

  /* Buttons */
  .btn-row { display: flex; gap: 8px; align-items: center; }
  button {
    padding: 8px 16px;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
  }
  button:disabled { opacity: 0.45; cursor: default; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .hint {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin: 8px 0 0;
  }

  #loading { color: var(--vscode-descriptionForeground); }
  #content { display: none; }
  #errorMsg { color: var(--vscode-editorError-foreground); display: none; }
  #indexingMsg {
    display: none;
    color: var(--vscode-descriptionForeground);
    margin-top: 12px;
  }
  #resultMsg {
    display: none;
    margin-top: 12px;
    font-size: 0.9em;
  }
  #resultMsg.result-ok   { color: var(--vscode-testing-iconPassed); }
  #resultMsg.result-warn { color: var(--vscode-editorWarning-foreground); }
  #resultMsg.result-err  { color: var(--vscode-editorError-foreground); }
</style>
</head>
<body>
  <div class="header-row">
    <h1>Index Status</h1>
    <button class="btn-refresh" id="refreshBtn" title="Refresh">&#8635;</button>
  </div>

  <p id="loading">Loading…</p>
  <p id="errorMsg"></p>
  <p id="indexingMsg"></p>
  <p id="resultMsg"></p>

  <div id="content">
    <div id="badge" class="badge"></div>

    <div class="stats-grid">
      <div class="stat-card" id="cardFiles">
        <div class="stat-label">Files found</div>
        <div class="stat-value" id="statFiles">—</div>
      </div>
      <div class="stat-card" id="cardChunks">
        <div class="stat-label">Indexed chunks</div>
        <div class="stat-value" id="statChunks">—</div>
      </div>
      <div class="stat-card" id="cardChanged">
        <div class="stat-label">Changed</div>
        <div class="stat-value" id="statChanged">—</div>
      </div>
      <div class="stat-card" id="cardNew">
        <div class="stat-label">New files</div>
        <div class="stat-value" id="statNew">—</div>
      </div>
    </div>

    <div class="meta">
      <span class="meta-label">Last indexed</span>
      <span id="metaLastIndexed">—</span>
    </div>
    <div class="meta">
      <span class="meta-label">File pattern</span>
      <code id="metaGlob"></code>
    </div>
    <div class="meta">
      <span class="meta-label">Embed provider</span>
      <span id="metaProvider">—</span>
    </div>

    <hr>

    <div class="btn-row">
      <button class="btn-primary"   id="incrementalBtn">Incremental Reindex</button>
      <button class="btn-secondary" id="fullBtn">Full Reindex</button>
    </div>
    <p class="hint" id="actionHint"></p>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const PROVIDER_LABELS = {
      local:  "Built-in (local)",
      ollama: "Ollama",
      openai: "OpenAI",
    };

    function fmt(n) { return Number(n).toLocaleString(); }

    function formatDate(iso) {
      if (!iso) return "Never";
      return new Date(iso).toLocaleString();
    }

    function render({ status, embedProvider }) {
      const { totalFiles, cachedFiles, changedFiles, newFiles, deletedFiles,
              chunkCount, needsReindex, docGlob, lastIndexed } = status;

      // Badge
      const badge = $("badge");
      const neverIndexed = chunkCount === 0 && cachedFiles === 0;
      if (neverIndexed) {
        badge.textContent = "Not yet indexed";
        badge.className = "badge badge-none";
      } else if (needsReindex) {
        badge.textContent = "Reindex needed";
        badge.className = "badge badge-warn";
      } else {
        badge.textContent = "Up to date";
        badge.className = "badge badge-ok";
      }

      // Stats
      $("statFiles").textContent   = fmt(totalFiles);
      $("statChunks").textContent  = fmt(chunkCount);
      $("statChanged").textContent = fmt(changedFiles);
      $("statNew").textContent     = fmt(newFiles);

      $("cardChanged").className = "stat-card" + (changedFiles > 0 ? " attention" : "");
      $("cardNew").className     = "stat-card" + (newFiles     > 0 ? " attention" : "");

      // Meta
      $("metaLastIndexed").textContent = formatDate(lastIndexed);
      $("metaGlob").textContent        = docGlob;
      $("metaProvider").textContent    = PROVIDER_LABELS[embedProvider] || embedProvider;

      // Action buttons + hint
      const hasChanges = changedFiles > 0 || newFiles > 0;
      incrementalEnabled = hasChanges;
      $("incrementalBtn").disabled = !hasChanges;

      if (neverIndexed) {
        $("actionHint").textContent =
          "No index exists yet — run a Full Reindex to get started.";
      } else if (!hasChanges) {
        $("actionHint").textContent =
          "All files are up to date. Use Full Reindex to rebuild from scratch.";
      } else {
        const n = changedFiles + newFiles;
        $("actionHint").textContent =
          n + " file" + (n === 1 ? "" : "s") + " will be re-embedded.";
      }

      $("loading").style.display = "none";
      $("content").style.display = "block";
    }

    $("refreshBtn").addEventListener("click", () => {
      $("loading").style.display = "block";
      $("content").style.display = "none";
      vscode.postMessage({ type: "refresh" });
    });

    function setIndexing(busy) {
      $("incrementalBtn").disabled = busy || !incrementalEnabled;
      $("fullBtn").disabled = busy;
      $("refreshBtn").disabled = busy;
      if (busy) {
        const badge = $("badge");
        badge.textContent = "Indexing\u2026";
        badge.className = "badge badge-warn";
        $("loading").style.display = "none";
        $("content").style.display = "block";
      }
    }

    let incrementalEnabled = false;

    $("incrementalBtn").addEventListener("click", () => {
      $("resultMsg").style.display = "none";
      vscode.postMessage({ type: "reindex", force: false });
    });

    $("fullBtn").addEventListener("click", () => {
      $("resultMsg").style.display = "none";
      vscode.postMessage({ type: "reindex", force: true });
    });

    window.addEventListener("message", (e) => {
      const msg = e.data;

      if (msg.type === "status") {
        render(msg);
        setIndexing(false);
        $("indexingMsg").style.display = "none";
      }

      if (msg.type === "error") {
        $("loading").style.display = "none";
        $("errorMsg").style.display = "block";
        $("errorMsg").textContent = "Error: " + msg.message;
      }

      if (msg.type === "indexing") {
        setIndexing(true);
        $("indexingMsg").style.display = "block";
        const { phase, processed, total } = msg;
        if (phase === "scanning") {
          $("indexingMsg").textContent = "Scanning files…";
        } else if (phase === "loading") {
          $("indexingMsg").textContent = total > 0
            ? "Loading AI model… (0 / " + total + " files)"
            : "Loading AI model…";
        } else {
          $("indexingMsg").textContent = processed + " / " + total + " files indexed…";
        }
      }

      if (msg.type === "reindexDone") {
        $("indexingMsg").style.display = "none";
        const { indexed, totalChunks, skipped } = msg.stats;
        const el = $("resultMsg");
        el.style.display = "block";
        if (indexed === 0 && skipped === 0) {
          el.className = "result-warn";
          el.textContent = "No documents found matching the file pattern.";
        } else if (indexed === 0) {
          el.className = "result-ok";
          el.textContent = "All " + skipped + " file(s) already up to date — nothing to reindex.";
        } else {
          el.className = "result-ok";
          el.textContent = "Done: " + indexed + " file(s) indexed, " + totalChunks + " chunk(s), " + skipped + " skipped.";
        }
      }

      if (msg.type === "reindexError") {
        $("indexingMsg").style.display = "none";
        setIndexing(false);
        const el = $("resultMsg");
        el.style.display = "block";
        el.className = "result-err";
        el.textContent = "Reindex failed: " + msg.message;
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
