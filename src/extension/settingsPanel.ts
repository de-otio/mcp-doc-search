import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { OllamaEmbedder, OpenAIEmbedder } from "../core/embedder.js";

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class SettingsPanel {
  private static instance: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

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

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
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
        this.panel.webview.postMessage({
          type: "config",
          config: {
            docGlob: cfg.get("docGlob", "doc/**/*.md"),
            indexDir: cfg.get("indexDir", ".claude/doc-index"),
            headingDepth: cfg.get("headingDepth", 2),
            maxChunkChars: cfg.get("maxChunkChars", 4000),
            embedProvider: cfg.get("embedProvider", "local"),
            ollamaUrl: cfg.get("ollamaUrl", "http://localhost:11434"),
            ollamaModel: cfg.get("ollamaModel", "nomic-embed-text"),
            openaiApiKey: cfg.get("openaiApiKey", ""),
            autoReindex: cfg.get("autoReindex", true),
          },
        });
        break;
      }

      case "saveConfig": {
        const cfg = vscode.workspace.getConfiguration("docSearch");
        const target = vscode.ConfigurationTarget.Workspace;
        try {
          await cfg.update("docGlob", msg.config.docGlob, target);
          await cfg.update("indexDir", msg.config.indexDir, target);
          await cfg.update("headingDepth", msg.config.headingDepth, target);
          await cfg.update("maxChunkChars", msg.config.maxChunkChars, target);
          await cfg.update("embedProvider", msg.config.embedProvider, target);
          await cfg.update("ollamaUrl", msg.config.ollamaUrl, target);
          await cfg.update("ollamaModel", msg.config.ollamaModel, target);
          await cfg.update("openaiApiKey", msg.config.openaiApiKey, target);
          await cfg.update("autoReindex", msg.config.autoReindex, target);

          this.panel.webview.postMessage({ type: "saveResult", ok: true });
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
        this.panel.dispose();
        vscode.commands.executeCommand("docSearch.reindex");
        break;
      }

      case "openSearch": {
        this.panel.dispose();
        vscode.commands.executeCommand("docSearch.search");
        break;
      }

      case "checkOllama": {
        const url = (msg.ollamaUrl || "http://localhost:11434").replace(
          /\/$/,
          "",
        );
        let running = false;
        let installed = false;

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
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
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
      <div class="warning">This key is saved to .vscode/settings.json. Add that file to .gitignore to avoid accidentally sharing it.</div>
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
    <div class="hint">Folder where the search database is stored (relative to workspace root). You can usually leave this as the default.</div>
    <input type="text" id="indexDir" placeholder=".claude/doc-index">
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
      toggleSections();
    }

    $("saveBtn").addEventListener("click", () => {
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
          $("savedBanner").classList.add("visible");
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
