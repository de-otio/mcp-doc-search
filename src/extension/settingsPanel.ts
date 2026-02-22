import * as vscode from "vscode";
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
  private disposed = false;

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

          this.panel.webview.postMessage({
            type: "saveResult",
            ok: true,
          });

          const reload = await vscode.window.showInformationMessage(
            "Doc Search: Settings saved. Reload window to apply?",
            "Reload",
          );
          if (reload === "Reload") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
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

      case "testConnection": {
        try {
          const { provider, ollamaUrl, ollamaModel, openaiApiKey } = msg;
          if (provider === "ollama") {
            const embedder = new OllamaEmbedder(ollamaUrl, ollamaModel);
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
</style>
</head>
<body>
  <h1>Doc Search Settings</h1>

  <h2>Embedding Provider</h2>
  <div class="field">
    <label for="embedProvider">Provider</label>
    <div class="hint">Local works offline with no setup. Ollama and OpenAI offer higher quality.</div>
    <select id="embedProvider">
      <option value="local">Local (all-MiniLM-L6-v2, offline)</option>
      <option value="ollama">Ollama</option>
      <option value="openai">OpenAI</option>
    </select>
  </div>

  <div id="ollamaSection" class="provider-section">
    <div class="field">
      <label for="ollamaUrl">Ollama URL</label>
      <input type="text" id="ollamaUrl" placeholder="http://localhost:11434">
    </div>
    <div class="field">
      <label for="ollamaModel">Model</label>
      <input type="text" id="ollamaModel" placeholder="nomic-embed-text">
    </div>
    <button class="btn-secondary" id="testOllama">Test Connection</button>
  </div>

  <div id="openaiSection" class="provider-section">
    <div class="field">
      <label for="openaiApiKey">API Key</label>
      <input type="password" id="openaiApiKey" placeholder="sk-...">
      <div class="warning">Stored in .vscode/settings.json — add it to .gitignore.</div>
    </div>
    <button class="btn-secondary" id="testOpenai">Test Connection</button>
  </div>

  <h2>Documentation</h2>
  <div class="field">
    <label for="docGlob">File Pattern</label>
    <div class="hint">Glob pattern relative to workspace root.</div>
    <input type="text" id="docGlob" placeholder="doc/**/*.md">
  </div>
  <div class="field">
    <label for="indexDir">Index Directory</label>
    <div class="hint">Where the vector index is stored, relative to workspace root.</div>
    <input type="text" id="indexDir" placeholder=".claude/doc-index">
  </div>

  <h2>Chunking</h2>
  <div class="field">
    <label for="headingDepth">Heading Depth</label>
    <div class="hint">Split on # only (1) or both # and ## (2).</div>
    <select id="headingDepth">
      <option value="1">1 — split on # only</option>
      <option value="2">2 — split on # and ##</option>
    </select>
  </div>
  <div class="field">
    <label for="maxChunkChars">Max Chunk Characters</label>
    <input type="number" id="maxChunkChars" min="500" max="32000">
  </div>

  <h2>Behavior</h2>
  <div class="field checkbox-row">
    <input type="checkbox" id="autoReindex">
    <label for="autoReindex">Auto-reindex on file save</label>
  </div>

  <div class="btn-row">
    <button class="btn-primary" id="saveBtn">Save Settings</button>
  </div>

  <div id="status"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const providerSelect = $("embedProvider");
    const ollamaSection = $("ollamaSection");
    const openaiSection = $("openaiSection");
    const status = $("status");

    function toggleSections() {
      const v = providerSelect.value;
      ollamaSection.classList.toggle("visible", v === "ollama");
      openaiSection.classList.toggle("visible", v === "openai");
    }
    providerSelect.addEventListener("change", toggleSections);

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
      vscode.postMessage({ type: "saveConfig", config: collectConfig() });
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
      if (msg.type === "saveResult") {
        if (msg.ok) showStatus("Settings saved.", true);
        else showStatus("Save failed: " + msg.error, false);
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
