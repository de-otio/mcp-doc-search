import * as vscode from "vscode";
import { ReindexInProgressError, type Indexer } from "../core/indexer.js";
import type { StatusBarManager } from "./statusBar.js";

const DEBOUNCE_MS = 2000;

/**
 * How long to wait before retrying when another reindex holds the lock.
 * Each attempt is a single failed `open(O_EXCL)`, so polling is cheap; the
 * holder may be this process's own start-up catch-up run, a previous flush,
 * or a CLI / MCP reindex in another process, and any of them can take
 * minutes on a large corpus.
 */
export const REINDEX_RETRY_MS = 10_000;

export class FileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    workspaceRoot: string,
    docGlob: string,
    private indexer: Indexer,
    private statusBar: StatusBarManager,
  ) {
    const pattern = new vscode.RelativePattern(workspaceRoot, docGlob);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange(() => this.schedule());
    this.watcher.onDidCreate(() => this.schedule());
    this.watcher.onDidDelete(() => this.schedule());
  }

  private schedule(delayMs = DEBOUNCE_MS): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), delayMs);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;

    this.statusBar.setIndexing();
    try {
      await this.indexer.reindex(false);
      this.statusBar.setReady();
    } catch (err) {
      if (err instanceof ReindexInProgressError) {
        // Not a failure: a reindex is running, so "Indexing…" is the truthful
        // state. Retry once it has released the lock — the retry is what
        // eventually sets the bar back to ready, since the holder may live in
        // another process and never report to this status bar.
        this.schedule(REINDEX_RETRY_MS);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
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
