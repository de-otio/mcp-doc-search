import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { FileWatcher, REINDEX_RETRY_MS } from "../../src/extension/fileWatcher.js";
import { ReindexInProgressError } from "../../src/core/indexer.js";

vi.useFakeTimers();

describe("FileWatcher", () => {
  let mockWatcher: any;
  let mockIndexer: any;
  let mockStatusBar: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWatcher = {
      onDidChange: vi.fn((handler) => ({
        dispose: vi.fn(),
      })),
      onDidCreate: vi.fn((handler) => ({
        dispose: vi.fn(),
      })),
      onDidDelete: vi.fn((handler) => ({
        dispose: vi.fn(),
      })),
      dispose: vi.fn(),
    };

    mockIndexer = {
      reindex: vi.fn().mockResolvedValue({
        indexed: 1,
        skipped: 0,
        failedFiles: 0,
        totalChunks: 5,
        durationMs: 100,
      }),
    };

    mockStatusBar = {
      setIndexing: vi.fn(),
      setReady: vi.fn(),
      setError: vi.fn(),
    };

    vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(mockWatcher);
  });

  describe("FileWatcher", () => {
    it("should create file watcher with docGlob pattern", () => {
      new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);

      expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith(expect.any(Object));
    });

    it("should register change listeners", () => {
      new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);

      expect(mockWatcher.onDidChange).toHaveBeenCalled();
      expect(mockWatcher.onDidCreate).toHaveBeenCalled();
      expect(mockWatcher.onDidDelete).toHaveBeenCalled();
    });

    it("should debounce rapid file changes", async () => {
      const watcher = new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);

      // Get the registered handlers
      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      if (changeHandler) {
        changeHandler({ fsPath: "/workspace/doc/test1.md" });
        changeHandler({ fsPath: "/workspace/doc/test2.md" });
        changeHandler({ fsPath: "/workspace/doc/test3.md" });

        // Reindex should not be called yet (debounced)
        expect(mockIndexer.reindex).not.toHaveBeenCalled();

        // Advance timers to trigger debounce
        vi.advanceTimersByTime(2000);

        expect(mockIndexer.reindex).toHaveBeenCalledWith(false);
      }
    });

    it("should update status bar during reindex", async () => {
      const watcher = new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);

      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      if (changeHandler) {
        changeHandler({ fsPath: "/workspace/doc/test.md" });
        await vi.runAllTimersAsync();

        expect(mockStatusBar.setIndexing).toHaveBeenCalled();
        expect(mockStatusBar.setReady).toHaveBeenCalled();
      }
    });

    it("should dispose watcher and clear timers", () => {
      const watcher = new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);

      watcher.dispose();

      expect(mockWatcher.dispose).toHaveBeenCalled();
    });

    it("should clear an active debounce timer on dispose", () => {
      const watcher = new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);
      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      changeHandler({ fsPath: "/workspace/doc/x.md" });
      // Now there's a pending timer; dispose should cancel it.
      watcher.dispose();
      vi.advanceTimersByTime(3000);

      // Reindex was never called because dispose cancelled the timer.
      expect(mockIndexer.reindex).not.toHaveBeenCalled();
    });

    it("should set error on the status bar when reindex throws an Error", async () => {
      mockIndexer.reindex.mockRejectedValue(new Error("disk full"));
      new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);
      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      changeHandler({ fsPath: "/workspace/doc/x.md" });
      await vi.runAllTimersAsync();

      expect(mockStatusBar.setError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
      expect(mockStatusBar.setReady).not.toHaveBeenCalled();
    });

    it("should retry instead of reporting an error when another reindex holds the lock", async () => {
      // First attempt collides with a running reindex (e.g. the start-up
      // catch-up run); the retry after the lock is released succeeds.
      mockIndexer.reindex
        .mockRejectedValueOnce(new ReindexInProgressError(4242, "2026-09-13T06:14:05.451Z"))
        .mockResolvedValueOnce({
          indexed: 1,
          skipped: 0,
          failedFiles: 0,
          totalChunks: 5,
          durationMs: 100,
        });
      new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);
      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      changeHandler({ fsPath: "/workspace/doc/x.md" });
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockIndexer.reindex).toHaveBeenCalledTimes(1);
      expect(mockStatusBar.setError).not.toHaveBeenCalled();
      expect(mockStatusBar.setReady).not.toHaveBeenCalled();
      expect(mockStatusBar.setIndexing).toHaveBeenCalledTimes(1);

      // Not retried before the retry interval has elapsed.
      await vi.advanceTimersByTimeAsync(REINDEX_RETRY_MS - 1);
      expect(mockIndexer.reindex).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(mockIndexer.reindex).toHaveBeenCalledTimes(2);
      expect(mockStatusBar.setReady).toHaveBeenCalledTimes(1);
      expect(mockStatusBar.setError).not.toHaveBeenCalled();
    });

    it("should keep retrying while the other reindex is still running", async () => {
      mockIndexer.reindex.mockRejectedValue(
        new ReindexInProgressError(4242, "2026-09-13T06:14:05.451Z"),
      );
      const watcher = new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);
      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      changeHandler({ fsPath: "/workspace/doc/x.md" });
      await vi.advanceTimersByTimeAsync(2000 + REINDEX_RETRY_MS * 3);

      expect(mockIndexer.reindex).toHaveBeenCalledTimes(4);
      expect(mockStatusBar.setError).not.toHaveBeenCalled();
      // The retry loop is still armed; drop it so it can't bleed into later tests.
      watcher.dispose();
    });

    it("should coalesce a new change into a pending retry", async () => {
      mockIndexer.reindex
        .mockRejectedValueOnce(new ReindexInProgressError(4242, "2026-09-13T06:14:05.451Z"))
        .mockResolvedValue({
          indexed: 1,
          skipped: 0,
          failedFiles: 0,
          totalChunks: 5,
          durationMs: 100,
        });
      new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);
      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      changeHandler({ fsPath: "/workspace/doc/x.md" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockIndexer.reindex).toHaveBeenCalledTimes(1);

      // A change arriving mid-wait replaces the retry with a normal debounce:
      // one reindex, not two.
      changeHandler({ fsPath: "/workspace/doc/y.md" });
      await vi.advanceTimersByTimeAsync(REINDEX_RETRY_MS + 2000);
      expect(mockIndexer.reindex).toHaveBeenCalledTimes(2);
      expect(mockStatusBar.setReady).toHaveBeenCalledTimes(1);
    });

    it("should cancel a pending retry on dispose", async () => {
      mockIndexer.reindex.mockRejectedValue(
        new ReindexInProgressError(4242, "2026-09-13T06:14:05.451Z"),
      );
      const watcher = new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);
      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      changeHandler({ fsPath: "/workspace/doc/x.md" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockIndexer.reindex).toHaveBeenCalledTimes(1);

      watcher.dispose();
      await vi.advanceTimersByTimeAsync(REINDEX_RETRY_MS * 2);
      expect(mockIndexer.reindex).toHaveBeenCalledTimes(1);
    });

    it("should set error on the status bar when reindex throws a non-Error", async () => {
      mockIndexer.reindex.mockRejectedValue("string error");
      new FileWatcher("/workspace", "doc/**/*.md", mockIndexer, mockStatusBar);
      const changeHandler = vi.mocked(mockWatcher.onDidChange).mock.calls[0]?.[0];

      changeHandler({ fsPath: "/workspace/doc/x.md" });
      await vi.runAllTimersAsync();

      expect(mockStatusBar.setError).toHaveBeenCalledWith(expect.stringContaining("string error"));
    });
  });
});
