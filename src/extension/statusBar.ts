import * as vscode from "vscode";

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.setReady();
    this.item.show();
    context.subscriptions.push(this);
  }

  setReady(): void {
    this.item.text = "$(search) DocSearch";
    this.item.tooltip = "Click to search documentation";
    this.item.command = "docSearch.search";
    this.item.backgroundColor = undefined;
  }

  setIndexing(): void {
    this.item.text = "$(loading~spin) Indexing...";
    this.item.tooltip = "Indexing documentation files";
    this.item.command = undefined;
    this.item.backgroundColor = undefined;
  }

  setError(message: string): void {
    this.item.text = "$(error) DocSearch";
    this.item.tooltip = message;
    this.item.command = "docSearch.reindex";
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  }

  dispose(): void {
    this.item.dispose();
  }
}
