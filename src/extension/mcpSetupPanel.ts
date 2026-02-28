import * as vscode from "vscode";
import { getNonce } from "./utils.js";

interface McpSetupDeps {
  mcpServerPath: string;
  env: Record<string, string>;
}

export class McpSetupPanel {
  private static instance: McpSetupPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static reset(): void {
    this.instance = undefined;
  }

  static createOrShow(context: vscode.ExtensionContext, deps: McpSetupDeps): void {
    if (McpSetupPanel.instance) {
      McpSetupPanel.instance.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "docSearchMcpSetup",
      "MCP Setup — Doc Search",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    McpSetupPanel.instance = new McpSetupPanel(panel, context, deps);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    deps: McpSetupDeps,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(deps);

    this.panel.onDidDispose(() => {
      McpSetupPanel.instance = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      context.subscriptions,
    );
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case "copy": {
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage("Copied to clipboard.");
        break;
      }
    }
  }

  private getHtml(deps: McpSetupDeps): string {
    const nonce = getNonce();
    const { mcpServerPath, env } = deps;

    // Build the various config snippets
    const claudeCodeJson = JSON.stringify(
      {
        mcpServers: {
          "doc-search": { command: "node", args: [mcpServerPath], env },
        },
      },
      null,
      2,
    );

    const envFlags = Object.entries(env)
      .map(([k, v]) => `-e ${k}="${v}"`)
      .join(" \\\n  ");
    const claudeCliCmd = `claude mcp add doc-search \\\n  -s project \\\n  ${envFlags} \\\n  -- node "${mcpServerPath}"`;

    const continueYaml = `name: Doc Search MCP\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: Doc Search\n    type: stdio\n    command: node\n    args:\n      - "${mcpServerPath}"\n    env:\n${Object.entries(
      env,
    )
      .map(([k, v]) => `      ${k}: "${v}"`)
      .join("\n")}`;

    const kilocodeJson = JSON.stringify(
      {
        mcpServers: {
          "doc-search": { command: "node", args: [mcpServerPath], env },
        },
      },
      null,
      2,
    );

    const vscodeNativeJson = JSON.stringify(
      {
        servers: {
          "doc-search": {
            type: "stdio",
            command: "node",
            args: [mcpServerPath],
            env,
          },
        },
      },
      null,
      2,
    );

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MCP Setup</title>
<style nonce="${nonce}">
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 20px;
    max-width: 750px;
  }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .subtitle {
    color: var(--vscode-descriptionForeground);
    margin-bottom: 20px;
  }
  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--vscode-widget-border);
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .tab {
    padding: 8px 16px;
    cursor: pointer;
    border: 1px solid transparent;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--vscode-descriptionForeground);
    font-size: var(--vscode-font-size);
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--vscode-foreground);
  }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  h2 { font-size: 1.15em; margin: 0 0 12px; }
  h3 {
    font-size: 1em;
    margin: 16px 0 8px;
    color: var(--vscode-foreground);
  }
  p, li { line-height: 1.5; }
  ol, ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
  .step-num {
    display: inline-block;
    width: 22px;
    height: 22px;
    line-height: 22px;
    text-align: center;
    border-radius: 50%;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 0.8em;
    font-weight: 600;
    margin-right: 6px;
  }
  .code-block {
    position: relative;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
    padding: 12px 14px;
    margin: 8px 0 16px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-all;
    overflow-x: auto;
  }
  .copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 3px 8px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    font-size: 0.8em;
  }
  .copy-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  code {
    background: var(--vscode-editor-background);
    padding: 1px 4px;
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.95em;
  }
  .note {
    background: var(--vscode-inputValidation-infoBackground);
    border: 1px solid var(--vscode-inputValidation-infoBorder);
    border-radius: 4px;
    padding: 10px 14px;
    margin: 12px 0;
    font-size: 0.9em;
  }
  .success-banner {
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-editor-background);
    padding: 10px 14px;
    border-radius: 4px;
    margin-bottom: 16px;
    font-weight: 600;
  }
</style>
</head>
<body>
  <h1>MCP Setup</h1>
  <p class="subtitle">
    Connect your AI coding assistant to Doc Search via the Model Context Protocol.
    Choose your tool below for setup instructions.
  </p>

  <div class="success-banner">.mcp.json has been written to your workspace root.</div>

  <div class="tab-bar">
    <button class="tab active" data-tab="claude-ext">Claude Code Extension</button>
    <button class="tab" data-tab="claude-cli">Claude Code CLI</button>
    <button class="tab" data-tab="vscode-native">VS Code Copilot</button>
    <button class="tab" data-tab="continue">Continue</button>
    <button class="tab" data-tab="kilocode">Kilo Code</button>
  </div>

  <!-- Claude Code Extension -->
  <div id="claude-ext" class="tab-content active">
    <h2>Claude Code VS Code Extension</h2>
    <p>The Claude Code extension automatically reads <code>.mcp.json</code> from your workspace root. The file has already been generated.</p>

    <h3><span class="step-num">1</span> Reload the window</h3>
    <p>Open the command palette (<code>Cmd+Shift+P</code>) and run <strong>Developer: Reload Window</strong> so Claude Code detects the new config.</p>

    <h3><span class="step-num">2</span> Approve the MCP server</h3>
    <p>The first time, Claude Code will show a prompt asking you to approve the project-scoped MCP server. Click <strong>Allow</strong>.</p>

    <h3><span class="step-num">3</span> Verify</h3>
    <p>Open Claude Code and ask:</p>
    <div class="code-block"><button class="copy-btn" data-copy="Search my docs for getting started">Copy</button>Search my docs for getting started</div>
    <p>Claude will call the <code>search_docs</code> tool and return results from your documentation.</p>

    <div class="note">
      The generated <code>.mcp.json</code> file is at your workspace root. You can commit it to version control so your team gets the same setup.
    </div>

    <h3>Generated .mcp.json</h3>
    <div class="code-block"><button class="copy-btn" data-copy="${escapeAttr(claudeCodeJson)}">Copy</button>${escapeHtml(claudeCodeJson)}</div>
  </div>

  <!-- Claude Code CLI -->
  <div id="claude-cli" class="tab-content">
    <h2>Claude Code CLI</h2>
    <p>The CLI also reads <code>.mcp.json</code> from the workspace root automatically. Since the file has been generated, you can simply run <code>claude</code> from this workspace.</p>

    <h3><span class="step-num">1</span> Start Claude Code</h3>
    <div class="code-block"><button class="copy-btn" data-copy="cd ${escapeAttr(env.DOC_SEARCH_WORKSPACE)}\nclaude">Copy</button>cd ${escapeHtml(env.DOC_SEARCH_WORKSPACE)}
claude</div>

    <h3><span class="step-num">2</span> Verify</h3>
    <p>Ask Claude to search your docs. It will find and use the <code>search_docs</code> tool automatically.</p>

    <h3>Alternative: add via CLI command</h3>
    <p>If you prefer to add the server explicitly (or want it in user scope rather than project scope):</p>
    <div class="code-block"><button class="copy-btn" data-copy="${escapeAttr(claudeCliCmd)}">Copy</button>${escapeHtml(claudeCliCmd)}</div>

    <p>To verify it was added:</p>
    <div class="code-block"><button class="copy-btn" data-copy="claude mcp list">Copy</button>claude mcp list</div>
  </div>

  <!-- VS Code Native MCP (Copilot) -->
  <div id="vscode-native" class="tab-content">
    <h2>VS Code Native MCP (GitHub Copilot)</h2>
    <p>VS Code has built-in MCP support for GitHub Copilot. It uses a different config file: <code>.vscode/mcp.json</code>.</p>

    <h3><span class="step-num">1</span> Create <code>.vscode/mcp.json</code></h3>
    <p>Create the file <code>.vscode/mcp.json</code> in your workspace with this content:</p>
    <div class="code-block"><button class="copy-btn" data-copy="${escapeAttr(vscodeNativeJson)}">Copy</button>${escapeHtml(vscodeNativeJson)}</div>

    <h3><span class="step-num">2</span> Start the server</h3>
    <p>Open the command palette (<code>Cmd+Shift+P</code>) and run <strong>MCP: List Servers</strong>. You should see <strong>doc-search</strong> listed. Click <strong>Start</strong> if it isn't already running.</p>

    <h3><span class="step-num">3</span> Use in Copilot Chat</h3>
    <p>Open Copilot Chat in <strong>Agent mode</strong> and ask it to search your docs. Copilot will call the MCP tools.</p>

    <div class="note">
      VS Code native MCP uses <code>.vscode/mcp.json</code> with a <code>"servers"</code> key (not <code>"mcpServers"</code>). This is a different format from <code>.mcp.json</code>.
    </div>
  </div>

  <!-- Continue -->
  <div id="continue" class="tab-content">
    <h2>Continue Extension</h2>
    <p>Continue reads MCP server configs from YAML files in <code>.continue/mcpServers/</code>.</p>

    <h3><span class="step-num">1</span> Create the config file</h3>
    <p>Create <code>.continue/mcpServers/doc-search.yaml</code> in your workspace with:</p>
    <div class="code-block"><button class="copy-btn" data-copy="${escapeAttr(continueYaml)}">Copy</button>${escapeHtml(continueYaml)}</div>

    <h3><span class="step-num">2</span> Reload Continue</h3>
    <p>Open the command palette (<code>Cmd+Shift+P</code>) and run <strong>Developer: Reload Window</strong>, or restart VS Code.</p>

    <h3><span class="step-num">3</span> Use in Agent mode</h3>
    <p>MCP tools are available in Continue's <strong>Agent mode</strong>. Ask Continue to search your docs and it will use the <code>search_docs</code> tool.</p>

    <div class="note">
      Continue uses YAML format with a <code>mcpServers</code> array (not an object). Each server needs <code>type: stdio</code> explicitly.
    </div>
  </div>

  <!-- Kilo Code -->
  <div id="kilocode" class="tab-content">
    <h2>Kilo Code Extension</h2>
    <p>Kilo Code reads project-level MCP config from <code>.kilocode/mcp.json</code>.</p>

    <h3><span class="step-num">1</span> Create <code>.kilocode/mcp.json</code></h3>
    <p>Create the file <code>.kilocode/mcp.json</code> in your workspace root with:</p>
    <div class="code-block"><button class="copy-btn" data-copy="${escapeAttr(kilocodeJson)}">Copy</button>${escapeHtml(kilocodeJson)}</div>

    <h3><span class="step-num">2</span> Reload</h3>
    <p>Kilo Code automatically detects <code>.kilocode/mcp.json</code>. Reload the window or restart VS Code to pick it up.</p>

    <h3><span class="step-num">3</span> Verify</h3>
    <p>Open Kilo Code settings (<strong>Agent Behaviour > MCP Servers</strong>) and confirm <strong>doc-search</strong> appears in the server list.</p>

    <div class="note">
      You can also configure globally via <strong>Edit Global MCP</strong> in Kilo Code settings, which writes to <code>mcp_settings.json</code>.
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Tab switching
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById(tab.dataset.tab).classList.add("active");
      });
    });

    // Copy buttons
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".copy-btn");
      if (!btn) return;
      const text = btn.dataset.copy;
      vscode.postMessage({ type: "copy", text });
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
