import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  stableBinDir,
  launcherSource,
  writeStableLaunchers,
} from "../../src/extension/stableBin.js";

const require = createRequire(import.meta.url);

describe("stableBin", () => {
  let tmpDir: string;
  let home: string;
  let extensionDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    // realpath: os.tmpdir() is a symlink on macOS (/var → /private/var), and
    // both resolveDocSearchHome and require() resolve to real paths.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stable-bin-")));
    home = path.join(tmpDir, "doc-search-home");
    extensionDir = path.join(tmpDir, "ext-1.2.3");
    fs.mkdirSync(path.join(extensionDir, "dist"), { recursive: true });
    env = { DOC_SEARCH_HOME: home };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("stableBinDir", () => {
    it("lives under the resolved doc-search home", () => {
      expect(stableBinDir(env)).toBe(path.join(home, "bin"));
    });
  });

  describe("launcherSource", () => {
    it("is an executable node script that requires the real path", () => {
      const source = launcherSource("/some/dir/dist/mcp-server.js");
      expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
      expect(source).toContain('require("/some/dir/dist/mcp-server.js");');
    });

    it("escapes paths safely via JSON stringification", () => {
      const source = launcherSource('/odd "dir"\\x/mcp-server.js');
      expect(source).toContain(JSON.stringify('/odd "dir"\\x/mcp-server.js'));
    });
  });

  describe("writeStableLaunchers", () => {
    it("writes both launchers forwarding to the extension's dist and returns the server path", () => {
      const result = writeStableLaunchers(extensionDir, env);

      expect(result).toBe(path.join(home, "bin", "mcp-server.js"));
      for (const name of ["mcp-server.js", "mcp-doc-search.js"]) {
        const launcherPath = path.join(home, "bin", name);
        const content = fs.readFileSync(launcherPath, "utf8");
        expect(content).toContain(JSON.stringify(path.join(extensionDir, "dist", name)));
        // Owner-executable (Windows has no mode bits; guard on platform)
        if (process.platform !== "win32") {
          expect(fs.statSync(launcherPath).mode & 0o100).toBeTruthy();
        }
      }
    });

    it("actually forwards a require() of the launcher to the real module", () => {
      const realServer = path.join(extensionDir, "dist", "mcp-server.js");
      fs.writeFileSync(realServer, "module.exports = { marker: 'real-server' };\n");
      fs.writeFileSync(path.join(extensionDir, "dist", "mcp-doc-search.js"), "");

      const stableServer = writeStableLaunchers(extensionDir, env);

      expect(stableServer).toBeDefined();
      const launcher = require(stableServer!);
      // The launcher's own exports are empty — but requiring it must have
      // loaded the real module (require cache proves the forward happened).
      expect(require.cache[realServer]?.exports).toEqual({ marker: "real-server" });
      expect(launcher).toBeDefined();
    });

    it("rewrites a launcher that points at a stale build", () => {
      writeStableLaunchers(path.join(tmpDir, "ext-0.0.1"), env);
      writeStableLaunchers(extensionDir, env);

      const content = fs.readFileSync(path.join(home, "bin", "mcp-server.js"), "utf8");
      expect(content).toContain("ext-1.2.3");
      expect(content).not.toContain("ext-0.0.1");
    });

    it("is idempotent: an up-to-date launcher is not rewritten", () => {
      writeStableLaunchers(extensionDir, env);
      const launcherPath = path.join(home, "bin", "mcp-server.js");
      // Tamper-proof check via inode timestamps is flaky; instead prove the
      // no-rewrite path by making the file read-only and calling again — a
      // rewrite would throw inside and surface as undefined.
      fs.chmodSync(launcherPath, 0o555);
      const result = writeStableLaunchers(extensionDir, env);
      expect(result).toBe(launcherPath);
    });

    it("returns undefined when the bin directory cannot be created", () => {
      // A regular file where the home dir should be makes mkdir fail.
      fs.writeFileSync(home, "not a directory");
      expect(writeStableLaunchers(extensionDir, env)).toBeUndefined();
    });
  });
});
