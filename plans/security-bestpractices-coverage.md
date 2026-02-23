# Plan: Security, Best Practices & 80% Test Coverage

## Overview

This plan addresses all findings from the project review, organized into four phases:

1. **Security fixes** (high severity)
2. **Best-practice improvements** (medium severity)
3. **CI/CD & tooling hardening**
4. **Test coverage: 0% → 80% on untested modules**

Current state: 3,231 LOC across 19 source files. Tests cover only `chunker`, `embedder`, `searcher` (~374 LOC). The remaining ~2,817 LOC across 15 files have 0% coverage.

---

## Phase 1 — Security Fixes (High Severity)

### 1.1 Use VS Code Secret Storage for API Keys

**Files:** `src/extension/config.ts`, `src/extension/settingsPanel.ts`, `src/extension/extension.ts`

- Replace `docSearch.openaiApiKey` workspace setting with `context.secrets` API.
- In `activate()`, pass `context.secrets` to config and panels.
- In `settingsPanel.ts`, add "Store API Key" button that calls `context.secrets.store("docSearch.openaiApiKey", value)`.
- In `config.ts`, read from secrets: `await context.secrets.get("docSearch.openaiApiKey")`.
- Remove the `openaiApiKey` entry from `package.json` contributes.configuration (or mark it deprecated with a migration path).
- For MCP server (`src/mcp/config.ts`), keep env-var `OPENAI_API_KEY` as the transport (secrets API not available outside VS Code).

**Migration:** On first activation after update, if the old setting exists, migrate it to secrets and clear the setting. Show an info message.

### 1.2 Cryptographic Nonce Generation

**Files:** `src/extension/searchPanel.ts`, `src/extension/indexStatusPanel.ts`, `src/extension/settingsPanel.ts`, `src/extension/mcpSetupPanel.ts`

- Replace all `getNonce()` implementations with:
  ```typescript
  import * as crypto from "crypto";
  function getNonce(): string {
    return crypto.randomBytes(16).toString("base64url");
  }
  ```
- Extract to a shared `src/extension/utils.ts` to eliminate the 4x duplication.

### 1.3 Path Traversal Validation

**Files:** `src/core/chunker.ts`, `src/core/indexer.ts`

- In `chunker.ts`, add at the top of `chunkMarkdown()`:
  ```typescript
  const rel = path.relative(workspaceRoot, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal blocked: ${absolutePath} is outside workspace`);
  }
  ```
- In `indexer.ts`, after computing `rel` from glob results, add the same guard.

### 1.4 LanceDB Query Sanitization

**File:** `src/core/vectorstore.ts`

- Check if LanceDB's `table.delete()` supports a filter object or parameterized API.
- If yes, switch to it. If not, improve escaping: reject file paths containing characters outside `[a-zA-Z0-9_./-]` and enforce maximum length.
- Add a helper: `function safeLanceFilter(file: string): string` with explicit validation.

### 1.5 MCP Tool Input Validation

**File:** `src/mcp/tools.ts`

- Add validation for `search_docs`:
  ```typescript
  const query = String(input.query ?? "").trim();
  if (!query) return { content: [{ type: "text", text: "Query is required." }] };
  const n = Math.max(1, Math.min(100, Math.floor(Number(input.n) || 5)));
  ```
- Add validation for `reindex_docs`:
  ```typescript
  const force = input.force === true;
  ```
- Cap `fetchN` in `searcher.ts` to `Math.min(n * 3, 300)`.

### 1.6 Config Value Validation

**Files:** `src/extension/config.ts`, `src/mcp/config.ts`

- Add a shared validation function in `src/core/types.ts`:
  ```typescript
  export function validateConfig(raw: Partial<IndexerConfig>): IndexerConfig {
    const headingDepth = raw.headingDepth === 1 ? 1 : 2;
    const maxChunkChars = Math.max(100, Math.min(50_000, Number(raw.maxChunkChars) || 4000));
    // ... validate docGlob is non-empty, indexDir is non-empty
  }
  ```
- Call from both `config.ts` files.

---

## Phase 2 — Best-Practice Improvements (Medium Severity)

### 2.1 Fix JSONC Parsing

**File:** `src/mcp/config.ts`

- Replace the fragile regex comment-stripping (`raw.replace(/\/\/.*$/gm, "")`) with a proper JSONC parser.
- Option A: Use `jsonc-parser` package (same one VS Code uses internally, zero deps, 15KB).
- Option B: Minimal hand-rolled approach that handles `//` inside strings.
- Recommended: Option A — add `jsonc-parser` as a production dependency.

### 2.2 LanceDB Connection Cleanup

**File:** `src/core/vectorstore.ts`

- Add a `close()` method:
  ```typescript
  async close(): Promise<void> {
    this.table = undefined;
    this.db = undefined;
  }
  ```
- Call from `extension.ts` `deactivate()` and MCP server shutdown.

### 2.3 Fetch Timeout & Retry for External Embedders

**File:** `src/core/embedder.ts`

- Add `AbortController` with 30s timeout to Ollama and OpenAI fetch calls.
- Add single retry on network error (not on 4xx):
  ```typescript
  async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 30_000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  ```

### 2.4 Surface Embedding Failures

**File:** `src/core/indexer.ts`

- Add `failedFiles: number` to `IndexStats` return type.
- Increment counter on embed errors instead of silently continuing.
- Return it in stats so UI and MCP can show "Indexed 42 files (3 failed)".

### 2.5 Remove Unused FileWatcher `changed` Set

**File:** `src/extension/fileWatcher.ts`

- The `changed` Set is populated but never consumed (full reindex is called regardless).
- Two options:
  - **Option A (simple):** Remove the Set entirely; keep the debounce-then-full-reindex pattern.
  - **Option B (incremental):** Pass the Set to `indexer.reindex()` to enable targeted reindexing.
- Recommended: Option A for now. Incremental reindex is a separate feature.

### 2.6 Consistent Panel Dispose Guards

**Files:** `src/extension/searchPanel.ts`, `src/extension/settingsPanel.ts`, `src/extension/indexStatusPanel.ts`, `src/extension/mcpSetupPanel.ts`

- Add `private disposed = false;` flag to each panel class.
- Set it `true` in `onDidDispose`.
- Guard all `postMessage` calls with `if (!this.disposed)`.
- Extract to shared pattern in `src/extension/utils.ts` if warranted.

### 2.7 Reduce `any` Usage

**Files:** `src/core/vectorstore.ts`, `src/core/embedder.ts`, `src/extension/searchPanel.ts`

- Define typed interfaces for:
  - LanceDB connection/table: `LanceConnection`, `LanceTable` (minimal shape interfaces)
  - Webview message protocol: `type SearchMessage = { type: "search"; query: string; n: number } | ...`
  - Embedder pipeline: `type Pipeline = (texts: string[], options?: unknown) => Promise<{ tolist(): number[][] }>`
- Replace `any` with these interfaces.

---

## Phase 3 — CI/CD & Tooling

### 3.1 Add ESLint

- Install: `@eslint/js`, `typescript-eslint`, `eslint-plugin-security`
- Create `eslint.config.mjs` with:
  - `@typescript-eslint/recommended`
  - `eslint-plugin-security/recommended`
  - Rules: `no-explicit-any: warn`, `no-unused-vars: error`
- Add script: `"lint:eslint": "eslint src/"`
- Update `"lint"` to run both Prettier and ESLint.

### 3.2 Create `.prettierrc`

- Document existing defaults explicitly so contributors know the rules:
  ```json
  {
    "printWidth": 100,
    "trailingComma": "all"
  }
  ```

### 3.3 Add CI Lint & Coverage Gates

**File:** `.github/workflows/build.yml`

- Add steps after `npm ci`:
  ```yaml
  - name: Lint
    run: npm run lint
  - name: Test with coverage
    run: npx vitest run --coverage --coverage.lines 80 --coverage.branches 70
  ```

### 3.4 Add Dependency Auditing

**File:** `.github/workflows/build.yml`

- Add step:
  ```yaml
  - name: Audit dependencies
    run: npm audit --audit-level=high
  ```
- Consider adding Dependabot config (`.github/dependabot.yml`).

---

## Phase 4 — Test Coverage (Target: 80% Overall)

### Current State

| Module                        | LOC | Coverage         |
| ----------------------------- | --- | ---------------- |
| core/chunker.ts               | 141 | ~98%             |
| core/embedder.ts              | 136 | 100%             |
| core/searcher.ts              | 97  | 100%             |
| core/types.ts                 | 73  | N/A (interfaces) |
| core/vectorstore.ts           | 152 | 0%               |
| core/indexer.ts               | 220 | 0%               |
| core/gitignore.ts             | 28  | 0%               |
| mcp/server.ts                 | 24  | 0%               |
| mcp/tools.ts                  | 142 | 0%               |
| mcp/config.ts                 | 91  | 0%               |
| extension/config.ts           | 31  | 0%               |
| extension/fileWatcher.ts      | 55  | 0%               |
| extension/statusBar.ts        | 42  | 0%               |
| extension/commands.ts         | 155 | 0%               |
| extension/extension.ts        | 57  | 0%               |
| extension/searchPanel.ts      | 271 | 0%               |
| extension/settingsPanel.ts    | 641 | 0%               |
| extension/indexStatusPanel.ts | 477 | 0%               |
| extension/mcpSetupPanel.ts    | 401 | 0%               |

**LOC needing tests: ~2,817. Target: 80% of all lines covered.**

### Strategy

The 4 webview panels (searchPanel, settingsPanel, indexStatusPanel, mcpSetupPanel) are ~1,790 LOC combined, mostly inline HTML string templates. These are low-value targets for unit tests because:

- The HTML templates are static strings with no branching logic.
- The real logic is in `handleMessage()` methods, which ARE testable.

**Approach:** Test all business logic and message handlers. Exclude HTML template strings from coverage where possible (or accept lower coverage on those files). Focus test effort where bugs are most likely.

### 4.1 VS Code API Mock Setup

Create `test/mocks/vscode.ts`:

```typescript
// Minimal mock of vscode module APIs needed by extension code
export const workspace = {
  getConfiguration: vi.fn(),
  createFileSystemWatcher: vi.fn(),
  workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
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
export const Uri = { file: vi.fn((p: string) => ({ fsPath: p })), joinPath: vi.fn() };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ThemeColor = vi.fn();
export const ViewColumn = { One: 1 };
export const ProgressLocation = { Notification: 15 };
export const env = { clipboard: { writeText: vi.fn() } };
export const RelativePattern = vi.fn();
```

Add to vitest config:

```typescript
resolve: {
  alias: {
    vscode: path.resolve(__dirname, "test/mocks/vscode.ts");
  }
}
```

### 4.2 Test Plan by File (Priority Order)

#### Tier 1 — Core logic, high value, no VS Code dependency

**test/unit/gitignore.test.ts** (~30 lines of tests)

- Test: creates entry when .gitignore missing
- Test: appends entry when not present
- Test: skips when entry already present
- Test: skips when pattern already covered (e.g., `/.doc-search-index` covers `.doc-search-index`)
- Mock: `fs.readFileSync`, `fs.appendFileSync`

**test/unit/vectorstore.test.ts** (~120 lines of tests)

- Test: `open()` creates directory and connects
- Test: `ensureTable()` creates table with correct schema
- Test: `ensureTable()` drops/recreates on dimension mismatch
- Test: `upsert()` adds records to table
- Test: `deleteByFile()` escapes single quotes
- Test: `query()` returns results with correct shape
- Test: `listFiles()` returns unique file list
- Test: `count()` returns total records
- Test: `isOpen()` / `hasTable()` state checks
- Mock: Dynamic `import("@lancedb/lancedb")` with mock connection/table

**test/unit/indexer.test.ts** (~200 lines of tests)

- Test: `reindex(false)` skips unchanged files (mtime match)
- Test: `reindex(false)` processes new/changed files
- Test: `reindex(true)` force-reprocesses all files
- Test: handles empty glob results
- Test: handles embed failure gracefully (continues, reports count)
- Test: calls `onProgress` callback with correct phase/count
- Test: `getStatus()` returns correct stats
- Test: writes mtime cache after successful reindex
- Test: deletes removed files from store
- Mock: `glob`, `fs`, `LanceVectorStore`, `chunkMarkdown`, `embedProvider`

#### Tier 2 — MCP server logic

**test/unit/mcp-config.test.ts** (~100 lines of tests)

- Test: reads settings from `.vscode/settings.json`
- Test: falls back to defaults when settings file missing
- Test: respects `DOC_SEARCH_WORKSPACE` env var
- Test: selects correct embed provider (local/ollama/openai)
- Test: handles malformed JSON gracefully
- Test: calls `ensureGitignored()`
- Mock: `fs`, `LanceVectorStore`, embedder constructors

**test/unit/mcp-tools.test.ts** (~150 lines of tests)

- Test: `search_docs` registers with correct schema
- Test: `search_docs` validates and clamps `n`
- Test: `search_docs` returns formatted results
- Test: `search_docs` handles search errors
- Test: `list_docs` returns file list with headings
- Test: `reindex_docs` calls indexer.reindex
- Test: `reindex_docs` handles reindex errors
- Mock: MCP server handlers, `search()`, store, indexer, embedProvider

**test/unit/mcp-server.test.ts** (~40 lines of tests)

- Test: `main()` creates server and connects transport
- Test: `main()` handles errors and exits with code 1
- Mock: MCP SDK, `createEngineFromEnv`, `registerTools`

#### Tier 3 — Extension logic (with vscode mock)

**test/unit/ext-config.test.ts** (~40 lines of tests)

- Test: reads all 8 settings with correct defaults
- Test: handles missing workspace configuration
- Mock: `vscode.workspace.getConfiguration`

**test/unit/statusBar.test.ts** (~50 lines of tests)

- Test: creates status bar item with correct alignment/priority
- Test: `setReady()` sets correct text/tooltip/color
- Test: `setIndexing()` sets correct text/tooltip
- Test: `setError()` sets error color and message
- Test: `dispose()` disposes underlying item
- Mock: `vscode.window.createStatusBarItem`

**test/unit/fileWatcher.test.ts** (~80 lines of tests)

- Test: creates watcher with correct glob pattern
- Test: debounces rapid file changes
- Test: calls `indexer.reindex(false)` on flush
- Test: updates status bar during reindex
- Test: handles reindex errors without crashing
- Test: `dispose()` clears timer and disposes watcher
- Mock: `vscode` watcher APIs, `Indexer`, `StatusBarManager`, timers (`vi.useFakeTimers`)

**test/unit/ext-extension.test.ts** (~80 lines of tests)

- Test: `activate()` registers all commands
- Test: `activate()` opens vector store
- Test: `activate()` creates file watcher when autoReindex enabled
- Test: `activate()` skips watcher when autoReindex disabled
- Test: `activate()` calls `ensureGitignored`
- Test: `deactivate()` is callable
- Mock: all extension subsystems

**test/unit/commands.test.ts** (~120 lines of tests)

- Test: registers all 6 commands
- Test: reindex command calls `indexer.reindex(true)` with progress
- Test: search command opens SearchPanel
- Test: settings command opens SettingsPanel
- Test: index status command opens IndexStatusPanel
- Test: MCP setup command opens McpSetupPanel
- Test: handles reindex errors gracefully
- Mock: `vscode.commands`, panel classes, indexer, statusBar

#### Tier 4 — Panel message handlers (test logic, skip HTML templates)

**test/unit/searchPanel.test.ts** (~80 lines of tests)

- Test: `createOrShow()` creates panel on first call
- Test: `createOrShow()` reveals existing panel on second call
- Test: `handleMessage({ type: "search" })` calls `search()` and posts results
- Test: `handleMessage({ type: "open" })` opens file in editor
- Test: handles search errors and posts error message
- Test: cleanup on dispose sets instance to undefined
- Mock: `vscode.window.createWebviewPanel`, `search()`, store, embedProvider

**test/unit/settingsPanel.test.ts** (~100 lines of tests)

- Test: `createOrShow()` singleton behavior
- Test: `handleMessage({ type: "getConfig" })` returns current config
- Test: `handleMessage({ type: "saveConfig" })` updates workspace settings
- Test: `handleMessage({ type: "checkOllama" })` detects installed/running
- Test: `handleMessage({ type: "testOllama" })` tests connection
- Test: `handleMessage({ type: "testOpenai" })` tests API key
- Test: handles errors in provider testing
- Mock: `vscode` config APIs, `execFile`, `fetch`, embedder classes

**test/unit/indexStatusPanel.test.ts** (~80 lines of tests)

- Test: `createOrShow()` singleton behavior
- Test: `sendStatus()` fetches and posts index stats
- Test: `handleMessage({ type: "reindex" })` triggers reindex with progress
- Test: progress callback posts updates to webview
- Test: handles disposed panel during reindex
- Mock: `vscode.window.createWebviewPanel`, indexer

**test/unit/mcpSetupPanel.test.ts** (~50 lines of tests)

- Test: `createOrShow()` singleton behavior
- Test: `handleMessage({ type: "copy" })` writes to clipboard
- Test: shows confirmation message after copy
- Mock: `vscode.env.clipboard`, `vscode.window`

### 4.3 Coverage Math

| Module                        | LOC | Expected Coverage | Covered Lines |
| ----------------------------- | --- | ----------------- | ------------- |
| core/chunker.ts               | 141 | 98%               | 138           |
| core/embedder.ts              | 136 | 100%              | 136           |
| core/searcher.ts              | 97  | 100%              | 97            |
| core/types.ts                 | 73  | N/A               | —             |
| core/gitignore.ts             | 28  | 95%               | 27            |
| core/vectorstore.ts           | 152 | 85%               | 129           |
| core/indexer.ts               | 220 | 85%               | 187           |
| mcp/server.ts                 | 24  | 80%               | 19            |
| mcp/tools.ts                  | 142 | 90%               | 128           |
| mcp/config.ts                 | 91  | 85%               | 77            |
| extension/config.ts           | 31  | 90%               | 28            |
| extension/fileWatcher.ts      | 55  | 85%               | 47            |
| extension/statusBar.ts        | 42  | 95%               | 40            |
| extension/commands.ts         | 155 | 80%               | 124           |
| extension/extension.ts        | 57  | 80%               | 46            |
| extension/searchPanel.ts      | 271 | 60%               | 163           |
| extension/settingsPanel.ts    | 641 | 50%               | 321           |
| extension/indexStatusPanel.ts | 477 | 55%               | 262           |
| extension/mcpSetupPanel.ts    | 401 | 50%               | 201           |

**Estimated total covered: ~2,170 / ~2,670 testable lines = ~81%**

(Panel HTML template strings drag down per-file coverage but message handlers and lifecycle methods will be fully tested.)

### 4.4 Vitest Configuration Update

Update `package.json` or create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/core/types.ts"],
      thresholds: {
        lines: 80,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/mocks/vscode.ts"),
    },
  },
});
```

---

## Implementation Order

| Step | Phase  | Item                                                           | Est. New/Changed Files |
| ---- | ------ | -------------------------------------------------------------- | ---------------------- |
| 1    | 4.1    | Create VS Code mock + vitest config                            | 2 new                  |
| 2    | 1.2    | Extract shared `getNonce()` to `utils.ts`                      | 1 new, 4 changed       |
| 3    | 1.3    | Path traversal validation                                      | 2 changed              |
| 4    | 1.5    | MCP tool input validation + search cap                         | 2 changed              |
| 5    | 1.6    | Config validation function                                     | 3 changed              |
| 6    | 4.2 T1 | Tests: gitignore, vectorstore, indexer                         | 3 new                  |
| 7    | 1.4    | LanceDB query sanitization                                     | 1 changed              |
| 8    | 2.1    | JSONC parser                                                   | 1 changed, 1 dep added |
| 9    | 2.2    | LanceDB close()                                                | 3 changed              |
| 10   | 2.3    | Fetch timeout/retry                                            | 1 changed              |
| 11   | 2.4    | Surface embedding failures                                     | 2 changed              |
| 12   | 2.5    | Remove unused `changed` Set                                    | 1 changed              |
| 13   | 4.2 T2 | Tests: mcp-config, mcp-tools, mcp-server                       | 3 new                  |
| 14   | 2.6    | Panel dispose guards                                           | 4 changed              |
| 15   | 2.7    | Reduce `any` types                                             | 3 changed              |
| 16   | 4.2 T3 | Tests: ext-config, statusBar, fileWatcher, extension, commands | 5 new                  |
| 17   | 1.1    | Secret storage for API keys                                    | 4 changed              |
| 18   | 4.2 T4 | Tests: panels (search, settings, indexStatus, mcpSetup)        | 4 new                  |
| 19   | 3.1    | Add ESLint + fix lint errors                                   | 1 new, N changed       |
| 20   | 3.2    | Create .prettierrc                                             | 1 new                  |
| 21   | 3.3    | CI lint & coverage gates                                       | 1 changed              |
| 22   | 3.4    | Dependency auditing in CI                                      | 1 changed              |

**Total: ~18 new files, ~25 changed files across 22 steps.**

---

## Checklist

- [ ] Phase 1: Secret storage for API keys
- [ ] Phase 1: Cryptographic nonce generation
- [ ] Phase 1: Path traversal validation
- [ ] Phase 1: LanceDB query sanitization
- [ ] Phase 1: MCP tool input validation
- [ ] Phase 1: Config value validation
- [ ] Phase 2: JSONC parser
- [ ] Phase 2: LanceDB connection cleanup
- [ ] Phase 2: Fetch timeout & retry
- [ ] Phase 2: Surface embedding failures
- [ ] Phase 2: Remove unused FileWatcher Set
- [ ] Phase 2: Panel dispose guards
- [ ] Phase 2: Reduce `any` types
- [ ] Phase 3: Add ESLint
- [ ] Phase 3: Create .prettierrc
- [ ] Phase 3: CI lint & coverage gates
- [ ] Phase 3: Dependency auditing
- [ ] Phase 4: VS Code mock setup + vitest config
- [ ] Phase 4: Tier 1 tests (gitignore, vectorstore, indexer)
- [ ] Phase 4: Tier 2 tests (mcp-config, mcp-tools, mcp-server)
- [ ] Phase 4: Tier 3 tests (ext-config, statusBar, fileWatcher, extension, commands)
- [ ] Phase 4: Tier 4 tests (searchPanel, settingsPanel, indexStatusPanel, mcpSetupPanel)
- [ ] Verify: `npx vitest run --coverage` reports ≥80% lines
