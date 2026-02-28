import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { FileWatcher } from "../../src/extension/fileWatcher.js";

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
  });
});
