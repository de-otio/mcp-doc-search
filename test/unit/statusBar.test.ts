import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { StatusBarManager } from "../../src/extension/statusBar.js";

describe("StatusBar", () => {
  let mockStatusBarItem: any;
  let context: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStatusBarItem = {
      text: "",
      tooltip: "",
      color: undefined,
      command: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };

    vi.mocked(vscode.window.createStatusBarItem).mockReturnValue(
      mockStatusBarItem,
    );

    context = {
      subscriptions: [],
    };
  });

  describe("StatusBarManager", () => {
    it("should create status bar item with correct alignment", () => {
      new StatusBarManager(context);

      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
        vscode.StatusBarAlignment.Left,
        expect.any(Number),
      );
    });

    it("should show ready state", () => {
      const manager = new StatusBarManager(context);
      manager.setReady();

      expect(mockStatusBarItem.text).toContain("✓");
      expect(mockStatusBarItem.color).toBeUndefined();
    });

    it("should show indexing state", () => {
      const manager = new StatusBarManager(context);
      manager.setIndexing();

      expect(mockStatusBarItem.text).toMatch(/Indexing|⟳/);
    });

    it("should show error state with red color", () => {
      const manager = new StatusBarManager(context);
      manager.setError("Test error");

      expect(mockStatusBarItem.color).toBeDefined();
    });

    it("should dispose status bar item", () => {
      const manager = new StatusBarManager(context);
      manager.dispose();

      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });
  });
});
