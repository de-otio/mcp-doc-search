import * as vscode from "vscode";
import type { Indexer } from "../core/indexer.js";
import type { StatusBarManager } from "./statusBar.js";

const DEBOUNCE_MS = 2000;

export class FileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher;
  private changed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    workspaceRoot: string,
    docGlob: string,
    private indexer: Indexer,
    private statusBar: StatusBarManager,
  ) {
    const pattern = new vscode.RelativePattern(workspaceRoot, docGlob);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange((uri) => this.schedule(uri.fsPath));
    this.watcher.onDidCreate((uri) => this.schedule(uri.fsPath));
    this.watcher.onDidDelete((uri) => this.schedule(uri.fsPath));
  }

  private schedule(filePath: string): void {
    this.changed.add(filePath);
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    this.changed.clear();

    this.statusBar.setIndexing();
    try {
      await this.indexer.reindex(false);
      this.statusBar.setReady();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      this.statusBar.setError(`Reindex failed: ${msg}`);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.watcher.dispose();
  }
}
