import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, afterEach } from "vitest";

import { execFileSync } from "node:child_process";
import {
  repairMcpServerPath,
  repairMcpServerEnv,
  repairMcpServerExtraRoots,
  repairMcpJson,
  isPortableLauncherRef,
  isGitTracked,
} from "../../src/extension/mcpJson.js";

const NEW =
  "/Users/me/.vscode/extensions/de-otio.mcp-doc-search-0.3.0-darwin-arm64/dist/mcp-server.js";
const STALE = "/Users/me/.vscode/extensions/de-otio-org.mcp-doc-search-0.1.0/dist/mcp-server.js";

function mcpJson(server: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: { "doc-search": server } }, null, 2) + "\n";
}

describe("repairMcpServerPath (pure)", () => {
  it("rewrites a stale doc-search server path to the current build", () => {
    const out = repairMcpServerPath(
      mcpJson({ command: "node", args: [STALE], env: { DOC_SEARCH_WORKSPACE: "/ws" } }),
      NEW,
    );
    expect(out).toBeDefined();
    const parsed = JSON.parse(out!);
    expect(parsed.mcpServers["doc-search"].args).toEqual([NEW]);
    // env preserved untouched
    expect(parsed.mcpServers["doc-search"].env).toEqual({ DOC_SEARCH_WORKSPACE: "/ws" });
  });

  it("is a no-op when the path is already current", () => {
    expect(repairMcpServerPath(mcpJson({ command: "node", args: [NEW] }), NEW)).toBeUndefined();
  });

  it("returns undefined for an absent file", () => {
    expect(repairMcpServerPath(undefined, NEW)).toBeUndefined();
  });

  it("never clobbers malformed JSON", () => {
    expect(repairMcpServerPath("{ not json", NEW)).toBeUndefined();
  });

  it("ignores a file with no doc-search server", () => {
    const text = JSON.stringify({ mcpServers: { other: { command: "node", args: [STALE] } } });
    expect(repairMcpServerPath(text, NEW)).toBeUndefined();
  });

  it("leaves a custom (non-extension) command alone", () => {
    const custom = "/Users/me/dev/my-fork/dist/server.js";
    expect(repairMcpServerPath(mcpJson({ command: "node", args: [custom] }), NEW)).toBeUndefined();
  });

  it("rewrites only the mcp-server.js arg, preserving other args and order", () => {
    const out = repairMcpServerPath(
      mcpJson({ command: "node", args: ["--enable-source-maps", STALE, "--flag"] }),
      NEW,
    );
    const parsed = JSON.parse(out!);
    expect(parsed.mcpServers["doc-search"].args).toEqual(["--enable-source-maps", NEW, "--flag"]);
  });

  it("treats the portable ${HOME} launcher form as current and never rewrites it", () => {
    const portable = "${HOME}/.doc-search/bin/mcp-server.js";
    // Even when the expected absolute path differs, a portable file is current
    // by construction: the client expands the reference at launch.
    expect(
      repairMcpServerPath(mcpJson({ command: "node", args: [portable] }), NEW),
    ).toBeUndefined();
    expect(
      repairMcpServerPath(
        mcpJson({ command: "node", args: [portable] }),
        "/Users/me/.doc-search/bin/mcp-server.js",
      ),
    ).toBeUndefined();
  });

  it("leaves a portable file alone even if the home path contains the extension marker", () => {
    // A home directory literally named after the extension would otherwise
    // satisfy the stale-path heuristic; the portable check runs first.
    const portable = "${HOME}/mcp-doc-search/.doc-search/bin/mcp-server.js";
    expect(
      repairMcpServerPath(mcpJson({ command: "node", args: [portable] }), NEW),
    ).toBeUndefined();
  });

  it("preserves other servers in the file", () => {
    const text = JSON.stringify(
      {
        mcpServers: {
          other: { command: "node", args: ["/x/y.js"] },
          "doc-search": { command: "node", args: [STALE] },
        },
      },
      null,
      2,
    );
    const parsed = JSON.parse(repairMcpServerPath(text, NEW)!);
    expect(parsed.mcpServers.other.args).toEqual(["/x/y.js"]);
    expect(parsed.mcpServers["doc-search"].args).toEqual([NEW]);
  });
});

describe("isPortableLauncherRef (pure)", () => {
  it.each([
    "${HOME}/.doc-search/bin/mcp-server.js",
    "${DOC_SEARCH_HOME}/bin/mcp-server.js",
    "${HOME}\\.doc-search\\bin\\mcp-server.js",
  ])("recognises %s", (arg) => {
    expect(isPortableLauncherRef(arg)).toBe(true);
  });

  it.each([
    "/Users/me/.doc-search/bin/mcp-server.js",
    "${HOME}/.doc-search/bin/mcp-doc-search.js",
    "${HOME}",
    "$HOME/.doc-search/bin/mcp-server.js",
    "${}/mcp-server.js",
    42,
    undefined,
  ])("rejects %s", (arg) => {
    expect(isPortableLauncherRef(arg)).toBe(false);
  });
});

describe("repairMcpServerEnv (pure)", () => {
  const OLLAMA = { OLLAMA_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "nomic-embed-text" };
  const LOCAL = { DOC_SEARCH_LOCAL_MODEL: "Xenova/multilingual-e5-small" };
  const STABLE = "${HOME}/.doc-search/bin/mcp-server.js";

  const entry = (env: Record<string, unknown>, args: unknown[] = [STABLE]): string =>
    mcpJson({ command: "node", args, env });

  const envOf = (text: string): Record<string, unknown> =>
    JSON.parse(text).mcpServers["doc-search"].env;

  it("adds the provider keys to a file generated before the user chose Ollama", () => {
    // The whole point: the server reads the provider from here and nowhere
    // else, so without this the user keeps two indexes without being told.
    const out = repairMcpServerEnv(entry({ DOC_SEARCH_WORKSPACE: "/ws" }), OLLAMA);
    expect(out).toBeDefined();
    expect(envOf(out!)).toEqual({ DOC_SEARCH_WORKSPACE: "/ws", ...OLLAMA });
  });

  it("removes provider keys the new provider does not use", () => {
    const out = repairMcpServerEnv(entry({ DOC_SEARCH_WORKSPACE: "/ws", ...OLLAMA }), LOCAL);
    expect(out).toBeDefined();
    // A leftover OLLAMA_URL would put the server straight back on Ollama.
    expect(envOf(out!)).toEqual({ DOC_SEARCH_WORKSPACE: "/ws", ...LOCAL });
  });

  it("preserves env keys that are not ours", () => {
    const out = repairMcpServerEnv(
      entry({ DOC_SEARCH_WORKSPACE: "/ws", DOC_SEARCH_EXTRA_ROOTS: "[]", MY_VAR: "keep me" }),
      OLLAMA,
    );
    expect(envOf(out!)).toMatchObject({ DOC_SEARCH_EXTRA_ROOTS: "[]", MY_VAR: "keep me" });
  });

  it("creates the env block when the entry has none", () => {
    const out = repairMcpServerEnv(mcpJson({ command: "node", args: [STABLE] }), OLLAMA);
    expect(envOf(out!)).toEqual(OLLAMA);
  });

  it("returns undefined when the env already matches", () => {
    expect(
      repairMcpServerEnv(entry({ DOC_SEARCH_WORKSPACE: "/ws", ...OLLAMA }), OLLAMA),
    ).toBeUndefined();
  });

  it("never overwrites an OPENAI_API_KEY the user already set", () => {
    // Replacing a literal key with ${OPENAI_API_KEY} breaks the server when
    // that variable is not exported in the launch environment.
    const out = repairMcpServerEnv(entry({ OPENAI_API_KEY: "sk-user-literal" }), {
      USE_OPENAI: "1",
      OPENAI_API_KEY: "${OPENAI_API_KEY}",
    });
    expect(out).toBeDefined();
    expect(envOf(out!)).toEqual({ USE_OPENAI: "1", OPENAI_API_KEY: "sk-user-literal" });
  });

  it("writes the ${OPENAI_API_KEY} reference, never a secret, when the key is absent", () => {
    const out = repairMcpServerEnv(entry({ DOC_SEARCH_WORKSPACE: "/ws" }), {
      USE_OPENAI: "1",
      OPENAI_API_KEY: "${OPENAI_API_KEY}",
    });
    expect(envOf(out!).OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
  });

  it("repairs the stable shim and a versioned install, which carry no ${VAR}", () => {
    const shim = repairMcpServerEnv(entry({}, ["/Users/me/.doc-search/bin/mcp-server.js"]), OLLAMA);
    expect(shim).toBeDefined();
    expect(repairMcpServerEnv(entry({}, [NEW]), OLLAMA)).toBeDefined();
  });

  it("leaves a server entry that is not ours alone", () => {
    expect(repairMcpServerEnv(entry({}, ["/opt/other/server.js"]), OLLAMA)).toBeUndefined();
    expect(
      repairMcpServerEnv(
        JSON.stringify({ mcpServers: { other: { command: "node", args: [STABLE] } } }),
        OLLAMA,
      ),
    ).toBeUndefined();
  });

  it("never clobbers a malformed or unexpected file", () => {
    expect(repairMcpServerEnv("{not json", OLLAMA)).toBeUndefined();
    expect(repairMcpServerEnv(undefined, OLLAMA)).toBeUndefined();
    expect(
      repairMcpServerEnv(mcpJson({ command: "node", args: [STABLE], env: "nope" }), OLLAMA),
    ).toBeUndefined();
  });
});

describe("repairMcpServerExtraRoots (pure)", () => {
  const STABLE = "${HOME}/.doc-search/bin/mcp-server.js";
  const NOTES = [{ name: "notes", path: "~/repos/notes", glob: "doc/**/*.md" }];
  const TWO = [...NOTES, { name: "product-a", path: "/path/to/product-a" }];

  const entry = (env: Record<string, unknown>, args: unknown[] = [STABLE]): string =>
    mcpJson({ command: "node", args, env });
  const envOf = (text: string): Record<string, unknown> =>
    JSON.parse(text).mcpServers["doc-search"].env;

  it("adds DOC_SEARCH_EXTRA_ROOTS when the setting gained a root after generation", () => {
    // Without it the server answers every ext://notes/ ref with
    // "Unknown external root" and reports the index stale forever.
    const out = repairMcpServerExtraRoots(entry({ DOC_SEARCH_WORKSPACE: "/ws" }), NOTES);
    expect(out).toBeDefined();
    expect(envOf(out!)).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_EXTRA_ROOTS: JSON.stringify(NOTES),
    });
  });

  it("keeps an existing value equal to the setting when a root is added or removed", () => {
    const grown = repairMcpServerExtraRoots(
      entry({ DOC_SEARCH_EXTRA_ROOTS: JSON.stringify(NOTES) }),
      TWO,
    );
    expect(envOf(grown!).DOC_SEARCH_EXTRA_ROOTS).toBe(JSON.stringify(TWO));

    const shrunk = repairMcpServerExtraRoots(
      entry({ DOC_SEARCH_EXTRA_ROOTS: JSON.stringify(TWO) }),
      NOTES,
    );
    expect(envOf(shrunk!).DOC_SEARCH_EXTRA_ROOTS).toBe(JSON.stringify(NOTES));
  });

  it("removes the key when the setting no longer holds any root", () => {
    const out = repairMcpServerExtraRoots(
      entry({ DOC_SEARCH_WORKSPACE: "/ws", DOC_SEARCH_EXTRA_ROOTS: JSON.stringify(NOTES) }),
      [],
    );
    expect(envOf(out!)).toEqual({ DOC_SEARCH_WORKSPACE: "/ws" });
  });

  it("does not add the key to a trust-flagged entry, which reads the setting itself", () => {
    expect(
      repairMcpServerExtraRoots(entry({ DOC_SEARCH_TRUST_WORKSPACE_SETTINGS: "1" }), NOTES),
    ).toBeUndefined();
  });

  it("still corrects a stale value on a trust-flagged entry (env wins over settings)", () => {
    const out = repairMcpServerExtraRoots(
      entry({ DOC_SEARCH_TRUST_WORKSPACE_SETTINGS: "1", DOC_SEARCH_EXTRA_ROOTS: "[]" }),
      NOTES,
    );
    expect(envOf(out!)).toEqual({
      DOC_SEARCH_TRUST_WORKSPACE_SETTINGS: "1",
      DOC_SEARCH_EXTRA_ROOTS: JSON.stringify(NOTES),
    });
  });

  it("leaves an equivalent, differently formatted value alone", () => {
    expect(
      repairMcpServerExtraRoots(
        entry({ DOC_SEARCH_EXTRA_ROOTS: JSON.stringify(NOTES, null, 2) }),
        NOTES,
      ),
    ).toBeUndefined();
  });

  it("is a no-op when neither the setting nor the entry has roots", () => {
    expect(repairMcpServerExtraRoots(entry({ DOC_SEARCH_WORKSPACE: "/ws" }), [])).toBeUndefined();
  });

  it("leaves foreign entries and malformed files alone", () => {
    expect(repairMcpServerExtraRoots(entry({}, ["/opt/other/server.js"]), NOTES)).toBeUndefined();
    expect(repairMcpServerExtraRoots("{not json", NOTES)).toBeUndefined();
    expect(repairMcpServerExtraRoots(undefined, NOTES)).toBeUndefined();
  });
});

describe("repairMcpJson (fs)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function mkWs(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpjson-"));
    cleanups.push(dir);
    return dir;
  }

  it("rewrites a stale .mcp.json in place and reports the path repair", () => {
    const ws = mkWs();
    const file = path.join(ws, ".mcp.json");
    fs.writeFileSync(file, mcpJson({ command: "node", args: [STALE] }));
    expect(repairMcpJson(ws, NEW)).toEqual({
      serverPath: true,
      providerEnv: false,
      extraRootsEnv: false,
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["doc-search"].args).toEqual([NEW]);
  });

  it("returns null (and writes nothing) when .mcp.json is absent", () => {
    const ws = mkWs();
    expect(repairMcpJson(ws, NEW)).toBeNull();
    expect(fs.existsSync(path.join(ws, ".mcp.json"))).toBe(false);
  });

  it("returns null when already current", () => {
    const ws = mkWs();
    fs.writeFileSync(path.join(ws, ".mcp.json"), mcpJson({ command: "node", args: [NEW] }));
    expect(repairMcpJson(ws, NEW)).toBeNull();
  });

  it("applies a stale path and a drifted provider env in ONE write", () => {
    const ws = mkWs();
    const file = path.join(ws, ".mcp.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          "doc-search": {
            command: "node",
            args: [STALE],
            env: { DOC_SEARCH_WORKSPACE: "/ws", DOC_SEARCH_LOCAL_MODEL: "Xenova/all-MiniLM-L6-v2" },
          },
        },
      }),
    );

    expect(
      repairMcpJson(ws, NEW, {
        OLLAMA_URL: "http://127.0.0.1:11434",
        OLLAMA_MODEL: "nomic-embed-text",
      }),
    ).toEqual({ serverPath: true, providerEnv: true, extraRootsEnv: false });

    const entry = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["doc-search"];
    expect(entry.args).toEqual([NEW]);
    expect(entry.env).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      OLLAMA_URL: "http://127.0.0.1:11434",
      OLLAMA_MODEL: "nomic-embed-text",
    });
  });
});

describe("repairMcpJson (fs): extraRoots", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reconciles a drifted provider env and a missing root in ONE write", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcpjson-roots-"));
    cleanups.push(ws);
    const file = path.join(ws, ".mcp.json");
    const roots = [{ name: "notes", path: "/path/to/notes" }];
    fs.writeFileSync(
      file,
      mcpJson({ command: "node", args: [NEW], env: { DOC_SEARCH_WORKSPACE: "/ws" } }),
    );

    expect(
      repairMcpJson(ws, NEW, { DOC_SEARCH_LOCAL_MODEL: "Xenova/all-MiniLM-L6-v2" }, roots),
    ).toEqual({ serverPath: false, providerEnv: true, extraRootsEnv: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["doc-search"].env).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_LOCAL_MODEL: "Xenova/all-MiniLM-L6-v2",
      DOC_SEARCH_EXTRA_ROOTS: JSON.stringify(roots),
    });
  });
});

describe("isGitTracked (git)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function mkRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpjson-git-"));
    cleanups.push(dir);
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    return dir;
  }

  it("returns false for an untracked (or absent) .mcp.json", () => {
    const repo = mkRepo();
    expect(isGitTracked(repo, ".mcp.json")).toBe(false);
    fs.writeFileSync(path.join(repo, ".mcp.json"), "{}\n");
    expect(isGitTracked(repo, ".mcp.json")).toBe(false);
  });

  it("returns true once the file is staged or committed", () => {
    const repo = mkRepo();
    fs.writeFileSync(path.join(repo, ".mcp.json"), "{}\n");
    execFileSync("git", ["-C", repo, "add", ".mcp.json"], { stdio: "ignore" });
    expect(isGitTracked(repo, ".mcp.json")).toBe(true);
  });

  it("returns false outside a repository instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpjson-nogit-"));
    cleanups.push(dir);
    expect(isGitTracked(dir, ".mcp.json")).toBe(false);
  });
});
