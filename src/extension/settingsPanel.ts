import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { OllamaEmbedder, OpenAIEmbedder } from "../core/embedder.js";
import { parseExtraRoots } from "../core/extraRoots.js";
import { getNonce } from "./utils.js";

/** SecretStorage key for the OpenAI API key. Single source of truth. */
const OPENAI_SECRET_KEY = "docSearch.openaiApiKey";

/** Row shape exchanged with the webview's external-folders editor. */
interface ExtraRootRow {
  name: string;
  path: string;
  glob: string;
}

/**
 * Coerce the raw extraRoots setting into rows the webview can render.
 * Malformed entries are kept (as far as they can be stringified) so the
 * user can see and fix them in the editor rather than having them
 * silently vanish; authoritative validation stays in parseExtraRoots.
 */
export function extraRootsToRows(raw: unknown): ExtraRootRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is Record<string, unknown> => typeof e === "object" && e !== null && !Array.isArray(e),
    )
    .map((e) => ({
      name: typeof e.name === "string" ? e.name : "",
      path: typeof e.path === "string" ? e.path : "",
      glob: typeof e.glob === "string" ? e.glob : "",
    }));
}

/**
 * Sanitize rows coming back from the webview into the persisted setting
 * shape: trimmed strings, `glob` omitted when empty (so the engine default
 * applies), fully-empty rows dropped.
 */
export function rowsToExtraRoots(
  raw: unknown,
): Array<{ name: string; path: string; glob?: string }> {
  return extraRootsToRows(raw)
    .map((row) => {
      const entry: { name: string; path: string; glob?: string } = {
        name: row.name.trim(),
        path: row.path.trim(),
      };
      const glob = row.glob.trim();
      if (glob) entry.glob = glob;
      return entry;
    })
    .filter((e) => e.name || e.path || e.glob);
}

export class SettingsPanel {
  private static instance: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly secrets: vscode.SecretStorage;
  private disposed = false;

  static reset(): void {
    this.instance = undefined;
  }

  static createOrShow(context: vscode.ExtensionContext): void {
    if (SettingsPanel.instance) {
      SettingsPanel.instance.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "docSearchSettings",
      "Doc Search Settings",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SettingsPanel.instance = new SettingsPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.secrets = context.secrets;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      this.disposed = true;
      SettingsPanel.instance = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      context.subscriptions,
    );
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case "ready": {
        const cfg = vscode.workspace.getConfiguration("docSearch");
        // H3: read the OpenAI key from SecretStorage, not from settings.json.
        // The cfg.get("openaiApiKey", "") path is intentionally absent here so
        // a stale settings.json value can't leak into the panel.
        const openaiApiKey = (await this.secrets.get(OPENAI_SECRET_KEY)) ?? "";
        this.panel.webview.postMessage({
          type: "config",
          config: {
            docGlob: cfg.get("docGlob", "doc/**/*.md"),
            indexDir: cfg.get("indexDir", ".doc-search-index"),
            headingDepth: cfg.get("headingDepth", 2),
            maxChunkChars: cfg.get("maxChunkChars", 4000),
            embedProvider: cfg.get("embedProvider", "local"),
            ollamaUrl: cfg.get("ollamaUrl", "http://localhost:11434"),
            ollamaModel: cfg.get("ollamaModel", "nomic-embed-text"),
            openaiApiKey,
            autoReindex: cfg.get("autoReindex", true),
            extraRoots: extraRootsToRows(cfg.get("extraRoots", [])),
          },
        });
        break;
      }

      case "saveConfig": {
        const cfg = vscode.workspace.getConfiguration("docSearch");
        const target = vscode.ConfigurationTarget.Workspace;
        try {
          const oldProvider = cfg.get("embedProvider", "local");
          const oldOllamaModel = cfg.get("ollamaModel", "nomic-embed-text");

          await cfg.update("docGlob", msg.config.docGlob, target);
          await cfg.update("indexDir", msg.config.indexDir, target);
          await cfg.update("headingDepth", msg.config.headingDepth, target);
          await cfg.update("maxChunkChars", msg.config.maxChunkChars, target);
          await cfg.update("embedProvider", msg.config.embedProvider, target);
          await cfg.update("ollamaUrl", msg.config.ollamaUrl, target);
          await cfg.update("ollamaModel", msg.config.ollamaModel, target);
          await cfg.update("autoReindex", msg.config.autoReindex, target);

          // External roots: persist as-typed (trimmed, empty rows dropped);
          // remove the setting entirely when the list is empty. Validation
          // stays in parseExtraRoots — its warnings are surfaced below so
          // the user learns which entries the engine will ignore.
          const extraRoots = rowsToExtraRoots(msg.config.extraRoots);
          await cfg.update("extraRoots", extraRoots.length ? extraRoots : undefined, target);
          const rootWarnings = parseExtraRoots(extraRoots).warnings;

          // H3: persist the OpenAI key to SecretStorage only. Empty string
          // deletes the secret so the user can clear it from the UI.
          const newKey = typeof msg.config.openaiApiKey === "string" ? msg.config.openaiApiKey : "";
          if (newKey) {
            await this.secrets.store(OPENAI_SECRET_KEY, newKey);
          } else {
            await this.secrets.delete(OPENAI_SECRET_KEY);
          }
          // Belt-and-braces: if a value still lingers in settings.json from a
          // pre-migration install, clear it. Older versions wrote here and
          // the migration in extension/config.ts also clears it, but a panel
          // save is the user's clear intent — re-assert the invariant.
          if (cfg.get("openaiApiKey", "")) {
            await cfg.update("openaiApiKey", undefined, target);
          }

          const providerChanged =
            oldProvider !== msg.config.embedProvider ||
            (msg.config.embedProvider === "ollama" && oldOllamaModel !== msg.config.ollamaModel);

          this.panel.webview.postMessage({
            type: "saveResult",
            ok: true,
            providerChanged,
            rootWarnings,
          });
          if (providerChanged) {
            // Reindex immediately with the new provider — no window reload needed
            vscode.commands.executeCommand("docSearch.reindex", true);
          }
        } catch (err) {
          this.panel.webview.postMessage({
            type: "saveResult",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "reloadWindow": {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
      }

      case "reindex": {
        vscode.commands.executeCommand("docSearch.openIndexStatus");
        vscode.commands.executeCommand("docSearch.reindex", false);
        this.panel.dispose();
        break;
      }

      case "openSearch": {
        this.panel.dispose();
        vscode.commands.executeCommand("docSearch.search");
        break;
      }

      case "checkOllama": {
        const url = (msg.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
        let running = false;
        let installed: boolean;

        // Check if server is reachable
        try {
          const res = await fetch(url);
          running = res.ok;
          installed = true;
        } catch {
          // Server not reachable — check if binary is on PATH
          installed = await new Promise<boolean>((resolve) => {
            execFile("ollama", ["--version"], (err) => resolve(!err));
          });
        }

        this.panel.webview.postMessage({
          type: "ollamaStatus",
          running,
          installed,
        });
        break;
      }

      case "openUrl": {
        // L1: defense-in-depth. The webview is trusted (we own its HTML and
        // enforce CSP via nonce), but we still validate the scheme so a
        // future bug or HTML injection in any walkthrough/help content
        // can't pivot openUrl into file://, vscode://, javascript:, etc.
        // Only http(s) URLs are passed to openExternal; anything else is
        // dropped silently.
        const rawUrl = typeof msg.url === "string" ? msg.url : "";
        let parsed: URL | null;
        try {
          parsed = new URL(rawUrl);
        } catch {
          parsed = null;
        }
        if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
          vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
        }
        break;
      }

      case "testConnection": {
        try {
          const { provider, ollamaUrl, ollamaModel, openaiApiKey } = msg;
          if (provider === "ollama") {
            const embedder = new OllamaEmbedder(ollamaModel, ollamaUrl);
            await embedder.embed(["test connection"]);
          } else if (provider === "openai") {
            const embedder = new OpenAIEmbedder(openaiApiKey);
            await embedder.embed(["test connection"]);
          }
          this.panel.webview.postMessage({ type: "testResult", ok: true });
        } catch (err) {
          this.panel.webview.postMessage({
            type: "testResult",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
<title>Doc Search Settings</title>
<style nonce="${nonce}">
  :root {
    --gap: 12px;
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 20px;
    max-width: 600px;
  }
  h1 { font-size: 1.4em; margin-bottom: 20px; }
  h2 {
    font-size: 1.1em;
    margin: 20px 0 10px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-widget-border);
  }
  label {
    display: block;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .hint {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }
  .field { margin-bottom: var(--gap); }
  input[type="text"], input[type="number"], input[type="password"], select {
    width: 100%;
    padding: 6px 8px;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
  }
  select { appearance: auto; }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .checkbox-row label { margin: 0; font-weight: normal; }
  .provider-section { display: none; padding: 10px; margin-bottom: var(--gap);
    background: var(--vscode-editor-background); border-radius: 4px;
    border: 1px solid var(--vscode-widget-border); }
  .provider-section.visible { display: block; }
  .ollama-status {
    padding: 8px 10px;
    border-radius: 4px;
    margin-bottom: 10px;
    font-size: 0.9em;
    display: none;
  }
  .ollama-status.running {
    display: block;
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-editor-background);
  }
  .ollama-status.not-running {
    display: block;
    background: var(--vscode-editorWarning-foreground);
    color: var(--vscode-editor-background);
  }
  .ollama-status.not-installed {
    display: block;
    background: var(--vscode-testing-iconFailed);
    color: var(--vscode-editor-background);
  }
  .setup-steps ol { margin: 8px 0; padding-left: 20px; }
  .setup-steps li { margin-bottom: 6px; }
  .setup-steps li.done { opacity: 0.5; text-decoration: line-through; }
  .setup-steps a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .warning {
    font-size: 0.85em;
    color: var(--vscode-editorWarning-foreground);
    margin-top: 4px;
  }
  .btn-row { display: flex; gap: 8px; margin-top: 20px; }
  button {
    padding: 8px 16px;
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
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #status {
    margin-top: 12px;
    padding: 8px;
    border-radius: 2px;
    display: none;
  }
  #status.success {
    display: block;
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-editor-background);
  }
  #status.error {
    display: block;
    background: var(--vscode-testing-iconFailed);
    color: var(--vscode-editor-background);
  }
  .section-divider {
    border: none;
    border-top: 1px solid var(--vscode-widget-border);
    margin: 28px 0 0;
  }
  #whatNext h2 { margin-top: 20px; }
  #whatNext p { margin: 4px 0 14px; }
  .saved-banner {
    display: none;
    margin-top: 12px;
    padding: 8px 12px;
    border-radius: 2px;
    background: var(--vscode-inputValidation-infoBackground);
    border: 1px solid var(--vscode-inputValidation-infoBorder);
    font-size: 0.9em;
  }
  .saved-banner.visible { display: flex; align-items: center; gap: 10px; }
  .btn-inline {
    padding: 2px 10px;
    border: 1px solid var(--vscode-button-background);
    border-radius: 2px;
    background: transparent;
    color: var(--vscode-button-background);
    cursor: pointer;
    font-size: var(--vscode-font-size);
    white-space: nowrap;
  }
  .btn-inline:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .root-row {
    display: grid;
    grid-template-columns: 1fr 2fr 1.4fr auto;
    gap: 6px;
    margin-bottom: 6px;
    align-items: center;
  }
  .root-row input { width: 100%; }
  .root-row .btn-remove {
    padding: 4px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .root-header {
    display: grid;
    grid-template-columns: 1fr 2fr 1.4fr auto;
    gap: 6px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin: 8px 0 4px;
  }
  .root-header span:last-child { visibility: hidden; }
</style>
</head>
<body>
  <h1>Doc Search Settings</h1>

  <h2>Search Engine</h2>
  <p class="hint">
    Doc Search reads your markdown files and builds a search index so you can find
    relevant passages by meaning, not just keywords. To do this it needs an AI model
    that converts text into numbers it can compare — choose one below.
  </p>
  <div class="field">
    <label for="embedProvider">AI model source</label>
    <select id="embedProvider">
      <option value="local">Built-in (works offline, no account needed) — recommended</option>
      <option value="ollama">Ollama (self-hosted, higher accuracy)</option>
      <option value="openai">OpenAI (cloud, highest accuracy, costs money)</option>
    </select>
  </div>

  <div id="localInfo" class="provider-section">
    <p>
      Uses a small AI model (all-MiniLM-L6-v2) that runs entirely on your machine.
      No internet connection, no account, and no ongoing cost. Good accuracy for
      most documentation. The model file (~22 MB) is downloaded automatically the
      first time you index.
    </p>
  </div>

  <div id="ollamaSection" class="provider-section">
    <p>
      Uses <a href="https://ollama.com">Ollama</a>, a free tool that runs AI models
      locally. Higher accuracy than the built-in model.
    </p>

    <div id="ollamaStatus" class="ollama-status"></div>

    <div id="ollamaSetup" class="setup-steps">
      <p><strong>Setup checklist:</strong></p>
      <ol>
        <li id="stepInstall">
          <span>Install Ollama</span> —
          <a href="#" id="downloadOllama">open download page</a>
        </li>
        <li id="stepRun">
          <span>Start Ollama</span> — launch the Ollama app, or run
          <code>ollama serve</code> in a terminal
        </li>
        <li id="stepPull">
          <span>Download the model</span> — run
          <code>ollama pull nomic-embed-text</code> in a terminal
        </li>
      </ol>
      <button class="btn-secondary" id="recheckOllama">Re-check</button>
    </div>

    <div id="ollamaConfig" style="display:none">
      <div class="field">
        <label for="ollamaUrl">Ollama server address</label>
        <div class="hint">Leave as default unless you changed Ollama's port.</div>
        <input type="text" id="ollamaUrl" placeholder="http://localhost:11434">
      </div>
      <div class="field">
        <label for="ollamaModel">Model name</label>
        <input type="text" id="ollamaModel" placeholder="nomic-embed-text">
      </div>
      <button class="btn-secondary" id="testOllama">Test Connection</button>
    </div>
  </div>

  <div id="openaiSection" class="provider-section">
    <p>
      Uses OpenAI's embedding API for the highest accuracy. Requires an OpenAI
      account and API key. Costs approximately $0.02 per million tokens indexed
      (a typical documentation set costs a fraction of a cent).
    </p>
    <div class="field">
      <label for="openaiApiKey">OpenAI API key</label>
      <div class="hint">Found at platform.openai.com → API keys.</div>
      <input type="password" id="openaiApiKey" placeholder="sk-...">
      <div class="hint">Stored in VS Code's SecretStorage (the OS keychain), never in settings.json. For the MCP server and CLI, set the <code>OPENAI_API_KEY</code> environment variable in your <code>.mcp.json</code>.</div>
    </div>
    <button class="btn-secondary" id="testOpenai">Test Connection</button>
  </div>

  <h2>Which files to search</h2>
  <div class="field">
    <label for="docGlob">File pattern</label>
    <div class="hint">
      A pattern describing which markdown files to index, relative to your workspace root.
      Use <code>**</code> to match any folder. Examples:
      <code>docs/**/*.md</code> — all .md files under a docs/ folder;
      <code>**/*.md</code> — every .md file in the project.
    </div>
    <input type="text" id="docGlob" placeholder="doc/**/*.md">
  </div>
  <div class="field">
    <label for="indexDir">Search index location</label>
    <div class="hint">
      By default the index is stored <strong>globally</strong> under <code>~/.doc-search</code> —
      outside your project, so nothing is committed and no <code>.gitignore</code> change is needed.
      Leave this at the default to keep that. Entering a custom folder switches to legacy
      <strong>in-tree</strong> storage at that path inside your workspace (and adds it to
      <code>.gitignore</code>).
    </div>
    <input type="text" id="indexDir" placeholder=".doc-search-index">
  </div>

  <h2>External folders</h2>
  <div class="hint">
    Folders <strong>outside this workspace</strong> to index alongside your docs —
    e.g. a locally cloned vendor-docs repo. Results show up as
    <code>ext://&lt;name&gt;/…</code>. Path must be absolute (a leading <code>~</code> works);
    the pattern defaults to <code>**/*.{md,mdx}</code>.
  </div>
  <div class="warning">
    Each folder here becomes readable by doc-search MCP clients. Only add folders
    you're happy to expose to AI assistants in this workspace.
  </div>
  <div id="extraRootRows"></div>
  <div class="btn-row" style="margin-top:8px">
    <button class="btn-secondary" id="addRootBtn">Add folder</button>
  </div>

  <h2>Behavior</h2>
  <div class="field checkbox-row">
    <input type="checkbox" id="autoReindex">
    <label for="autoReindex">Automatically update search index when a file is saved</label>
  </div>

  <h2>Advanced</h2>
  <div class="field">
    <label for="headingDepth">How to split documents</label>
    <div class="hint">
      Long documents are split into smaller sections before indexing so search results
      point to the right part of a page.
    </div>
    <select id="headingDepth">
      <option value="2">Split on top-level and second-level headings (# and ##) — recommended</option>
      <option value="1">Split on top-level headings only (#)</option>
    </select>
  </div>
  <div class="field">
    <label for="maxChunkChars">Maximum section length (characters)</label>
    <div class="hint">Sections longer than this are truncated. Larger values index more context but may reduce search precision.</div>
    <input type="number" id="maxChunkChars" min="500" max="32000">
  </div>

  <div class="btn-row">
    <button class="btn-primary" id="saveBtn">Save Settings</button>
  </div>

  <div id="status"></div>

  <hr class="section-divider">

  <div id="whatNext">
    <h2>What to do next</h2>
    <p>
      Once your settings are correct, build the search index.
      Doc Search will read your markdown files and make them instantly searchable by meaning.
    </p>
    <div class="btn-row">
      <button class="btn-primary" id="reindexBtn">Build Search Index</button>
      <button class="btn-secondary" id="searchBtn">Search Docs</button>
    </div>
    <div id="providerHint" class="hint" style="margin-top:8px"></div>
    <div id="savedBanner" class="saved-banner">
      Settings saved. Reload the window for changes to take effect.
      <button class="btn-inline" id="reloadBtn">Reload now</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const providerSelect = $("embedProvider");
    const localInfo = $("localInfo");
    const ollamaSection = $("ollamaSection");
    const openaiSection = $("openaiSection");
    const status = $("status");

    const ollamaStatus = $("ollamaStatus");
    const ollamaSetup = $("ollamaSetup");
    const ollamaConfig = $("ollamaConfig");

    const providerHints = {
      local: "The first build downloads the AI model (~22 MB). Subsequent builds are fast.",
      ollama: "Indexing speed depends on your machine. Large doc sets may take a few minutes.",
      openai: "Indexing makes API calls to OpenAI. Large doc sets may take a minute and incur a small cost.",
    };

    function toggleSections() {
      const v = providerSelect.value;
      localInfo.classList.toggle("visible", v === "local");
      ollamaSection.classList.toggle("visible", v === "ollama");
      openaiSection.classList.toggle("visible", v === "openai");
      $("providerHint").textContent = providerHints[v] || "";
      if (v === "ollama") {
        vscode.postMessage({ type: "checkOllama", ollamaUrl: $("ollamaUrl").value });
      }
    }
    providerSelect.addEventListener("change", toggleSections);

    function updateOllamaStatus(running, installed) {
      ollamaStatus.style.display = "block";
      ollamaStatus.className = "ollama-status";
      if (running) {
        ollamaStatus.textContent = "Ollama is running and ready.";
        ollamaStatus.classList.add("running");
        ollamaSetup.style.display = "none";
        ollamaConfig.style.display = "block";
      } else if (installed) {
        ollamaStatus.textContent = "Ollama is installed but not running.";
        ollamaStatus.classList.add("not-running");
        $("stepInstall").classList.add("done");
        $("stepRun").classList.remove("done");
        $("stepPull").classList.remove("done");
        ollamaSetup.style.display = "block";
        ollamaConfig.style.display = "none";
      } else {
        ollamaStatus.textContent = "Ollama is not installed.";
        ollamaStatus.classList.add("not-installed");
        $("stepInstall").classList.remove("done");
        $("stepRun").classList.remove("done");
        $("stepPull").classList.remove("done");
        ollamaSetup.style.display = "block";
        ollamaConfig.style.display = "none";
      }
    }

    $("downloadOllama").addEventListener("click", (e) => {
      e.preventDefault();
      vscode.postMessage({ type: "openUrl", url: "https://ollama.com/download" });
    });

    $("recheckOllama").addEventListener("click", () => {
      ollamaStatus.textContent = "Checking...";
      ollamaStatus.className = "ollama-status running";
      ollamaStatus.style.display = "block";
      vscode.postMessage({ type: "checkOllama", ollamaUrl: $("ollamaUrl").value });
    });

    function showStatus(msg, ok) {
      status.textContent = msg;
      status.className = ok ? "success" : "error";
    }

    function clearStatus() {
      status.textContent = "";
      status.className = "";
    }

    // --- External folders editor -----------------------------------------
    const rootRows = $("extraRootRows");

    function addRootRow(root) {
      if (!rootRows.querySelector(".root-header")) {
        const header = document.createElement("div");
        header.className = "root-header";
        for (const label of ["Name", "Folder", "Pattern (optional)", "x"]) {
          const span = document.createElement("span");
          span.textContent = label;
          header.appendChild(span);
        }
        rootRows.appendChild(header);
      }
      const row = document.createElement("div");
      row.className = "root-row";
      const mk = (cls, placeholder, value) => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = cls;
        input.placeholder = placeholder;
        input.value = value || "";
        row.appendChild(input);
        return input;
      };
      mk("root-name", "vendor-docs", root && root.name);
      mk("root-path", "~/repos/vendor/docs", root && root.path);
      mk("root-glob", "**/*.{md,mdx}", root && root.glob);
      const remove = document.createElement("button");
      remove.className = "btn-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        row.remove();
        if (!rootRows.querySelector(".root-row")) {
          const header = rootRows.querySelector(".root-header");
          if (header) header.remove();
        }
      });
      row.appendChild(remove);
      rootRows.appendChild(row);
    }

    function collectExtraRoots() {
      return Array.from(rootRows.querySelectorAll(".root-row")).map((row) => ({
        name: row.querySelector(".root-name").value,
        path: row.querySelector(".root-path").value,
        glob: row.querySelector(".root-glob").value,
      }));
    }

    function applyExtraRoots(roots) {
      rootRows.textContent = "";
      for (const root of roots || []) addRootRow(root);
    }

    $("addRootBtn").addEventListener("click", () => addRootRow());

    function collectConfig() {
      return {
        docGlob: $("docGlob").value,
        indexDir: $("indexDir").value,
        headingDepth: parseInt($("headingDepth").value, 10),
        maxChunkChars: parseInt($("maxChunkChars").value, 10),
        embedProvider: providerSelect.value,
        ollamaUrl: $("ollamaUrl").value,
        ollamaModel: $("ollamaModel").value,
        openaiApiKey: $("openaiApiKey").value,
        autoReindex: $("autoReindex").checked,
        extraRoots: collectExtraRoots(),
      };
    }

    function applyConfig(cfg) {
      $("docGlob").value = cfg.docGlob;
      $("indexDir").value = cfg.indexDir;
      $("headingDepth").value = String(cfg.headingDepth);
      $("maxChunkChars").value = cfg.maxChunkChars;
      providerSelect.value = cfg.embedProvider;
      $("ollamaUrl").value = cfg.ollamaUrl;
      $("ollamaModel").value = cfg.ollamaModel;
      $("openaiApiKey").value = cfg.openaiApiKey;
      $("autoReindex").checked = cfg.autoReindex;
      applyExtraRoots(cfg.extraRoots);
      toggleSections();
    }

    $("saveBtn").addEventListener("click", () => {
      clearStatus();
      $("saveBtn").disabled = true;
      $("saveBtn").textContent = "Saving…";
      vscode.postMessage({ type: "saveConfig", config: collectConfig() });
    });

    $("reindexBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "reindex" });
    });

    $("searchBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "openSearch" });
    });

    $("reloadBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "reloadWindow" });
    });

    $("testOllama").addEventListener("click", () => {
      showStatus("Testing Ollama connection...", true);
      vscode.postMessage({
        type: "testConnection",
        provider: "ollama",
        ollamaUrl: $("ollamaUrl").value,
        ollamaModel: $("ollamaModel").value,
      });
    });

    $("testOpenai").addEventListener("click", () => {
      showStatus("Testing OpenAI connection...", true);
      vscode.postMessage({
        type: "testConnection",
        provider: "openai",
        openaiApiKey: $("openaiApiKey").value,
      });
    });

    window.addEventListener("message", (e) => {
      const msg = e.data;
      if (msg.type === "config") applyConfig(msg.config);
      if (msg.type === "ollamaStatus") updateOllamaStatus(msg.running, msg.installed);
      if (msg.type === "saveResult") {
        if (msg.ok) {
          clearStatus();
          if (msg.rootWarnings && msg.rootWarnings.length) {
            showStatus(
              "Saved, but some external folders will be ignored: " + msg.rootWarnings.join(" "),
              false,
            );
          }
          if (!msg.providerChanged) {
            $("savedBanner").classList.add("visible");
          }
          $("whatNext").scrollIntoView({ behavior: "smooth" });
          $("saveBtn").disabled = false;
          $("saveBtn").textContent = "Save Settings";
        } else {
          showStatus("Save failed: " + msg.error, false);
          $("saveBtn").disabled = false;
          $("saveBtn").textContent = "Save Settings";
        }
      }
      if (msg.type === "testResult") {
        if (msg.ok) showStatus("Connection successful!", true);
        else showStatus("Connection failed: " + msg.error, false);
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
