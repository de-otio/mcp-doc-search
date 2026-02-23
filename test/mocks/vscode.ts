// Minimal mock of vscode module APIs needed by extension code
import { vi } from "vitest";

export const workspace = {
  getConfiguration: vi.fn(),
  createFileSystemWatcher: vi.fn(),
  workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
};

export const window = {
  createWebviewPanel: vi.fn(),
  createStatusBarItem: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  withProgress: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};

export const Uri = {
  file: vi.fn((p: string) => ({ fsPath: p })),
  joinPath: vi.fn(),
};

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ThemeColor = vi.fn();
export const ViewColumn = { One: 1 };
export const ProgressLocation = { Notification: 15 };
export const env = { clipboard: { writeText: vi.fn() } };
export const RelativePattern = vi.fn();
export const ExtensionContext = class {
  secrets = { store: vi.fn(), get: vi.fn(), delete: vi.fn() };
  subscriptions: any[] = [];
  extensionPath = "/mock/extension";
};
