import { describe, it, expect } from "vitest";
import {
  buildMcpServerEnv,
  portableLauncherPath,
  CLAUDE_PROJECT_DIR_REF,
  OPENAI_API_KEY_REF,
  type McpEnvConfig,
} from "../../src/extension/mcpEnv.js";

const base: McpEnvConfig = {
  docGlob: "doc/**/*.md",
  extraRoots: [],
  embedProvider: "local",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "nomic-embed-text",
};

describe("buildMcpServerEnv (pure)", () => {
  it("emits only workspace and glob for the local provider", () => {
    expect(buildMcpServerEnv(base, "/ws")).toEqual({
      DOC_SEARCH_WORKSPACE: "/ws",
      DOC_SEARCH_GLOB: "doc/**/*.md",
    });
  });

  it("passes the workspace value through untouched (portable reference or absolute path)", () => {
    expect(buildMcpServerEnv(base, CLAUDE_PROJECT_DIR_REF).DOC_SEARCH_WORKSPACE).toBe(
      "${CLAUDE_PROJECT_DIR}",
    );
  });

  it("forwards the raw extraRoots setting as JSON so federation survives the trust gate", () => {
    const extraRoots = [
      { name: "vendor", path: "~/repos/vendor/docs", glob: "pages/**/*.mdx" },
      { name: "hub", path: "/srv/hub" },
    ];
    const env = buildMcpServerEnv({ ...base, extraRoots }, "/ws");
    expect(JSON.parse(env.DOC_SEARCH_EXTRA_ROOTS)).toEqual(extraRoots);
  });

  it("omits DOC_SEARCH_EXTRA_ROOTS for an empty or non-array setting", () => {
    expect(buildMcpServerEnv({ ...base, extraRoots: [] }, "/ws")).not.toHaveProperty(
      "DOC_SEARCH_EXTRA_ROOTS",
    );
    expect(buildMcpServerEnv({ ...base, extraRoots: undefined }, "/ws")).not.toHaveProperty(
      "DOC_SEARCH_EXTRA_ROOTS",
    );
    expect(buildMcpServerEnv({ ...base, extraRoots: "nope" }, "/ws")).not.toHaveProperty(
      "DOC_SEARCH_EXTRA_ROOTS",
    );
  });

  it("emits OLLAMA_URL and OLLAMA_MODEL for the ollama provider", () => {
    const env = buildMcpServerEnv(
      { ...base, embedProvider: "ollama", ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "m" },
      "/ws",
    );
    expect(env.OLLAMA_URL).toBe("http://127.0.0.1:11434");
    expect(env.OLLAMA_MODEL).toBe("m");
    expect(env).not.toHaveProperty("USE_OPENAI");
  });

  it("emits USE_OPENAI=1 and the key *reference* for the openai provider — never a literal", () => {
    const env = buildMcpServerEnv({ ...base, embedProvider: "openai" }, "/ws");
    expect(env.USE_OPENAI).toBe("1");
    expect(env.OPENAI_API_KEY).toBe(OPENAI_API_KEY_REF);
    expect(env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
    expect(env).not.toHaveProperty("OLLAMA_URL");
  });

  it("does not leak ollama settings into the openai or local env", () => {
    const cfg = { ...base, ollamaUrl: "http://ollama.internal", ollamaModel: "x" };
    expect(buildMcpServerEnv({ ...cfg, embedProvider: "local" }, "/ws")).not.toHaveProperty(
      "OLLAMA_URL",
    );
    expect(buildMcpServerEnv({ ...cfg, embedProvider: "openai" }, "/ws")).not.toHaveProperty(
      "OLLAMA_URL",
    );
  });
});

describe("portableLauncherPath (pure)", () => {
  const opts = { homedir: "/Users/me", platform: "darwin" as const };

  it("rewrites a launcher under the home directory to the ${HOME} form", () => {
    expect(portableLauncherPath("/Users/me/.doc-search/bin/mcp-server.js", opts)).toBe(
      "${HOME}/.doc-search/bin/mcp-server.js",
    );
  });

  it("leaves a path outside the home directory alone", () => {
    expect(portableLauncherPath("/opt/doc-search/bin/mcp-server.js", opts)).toBe(
      "/opt/doc-search/bin/mcp-server.js",
    );
  });

  it("does not treat a sibling directory with the home dir as a prefix as inside it", () => {
    expect(portableLauncherPath("/Users/me2/.doc-search/bin/mcp-server.js", opts)).toBe(
      "/Users/me2/.doc-search/bin/mcp-server.js",
    );
  });

  it("leaves the home directory itself and relative paths alone", () => {
    expect(portableLauncherPath("/Users/me", opts)).toBe("/Users/me");
    expect(portableLauncherPath("bin/mcp-server.js", opts)).toBe("bin/mcp-server.js");
  });

  it("keeps absolute paths on Windows, where HOME is not reliably set", () => {
    expect(
      portableLauncherPath("/Users/me/.doc-search/bin/mcp-server.js", {
        ...opts,
        platform: "win32",
      }),
    ).toBe("/Users/me/.doc-search/bin/mcp-server.js");
  });

  it("keeps the absolute path when no home directory is known", () => {
    expect(
      portableLauncherPath("/Users/me/.doc-search/bin/mcp-server.js", {
        homedir: "",
        platform: "linux",
      }),
    ).toBe("/Users/me/.doc-search/bin/mcp-server.js");
  });
});
