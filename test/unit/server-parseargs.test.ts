import { describe, it, expect, vi } from "vitest";

// The MCP server entry point performs side effects on import (calls main()),
// so we mock the modules it imports before requiring it.
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: function (this: any) {
    this.connect = vi.fn(async () => undefined);
    this.setRequestHandler = vi.fn();
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: function () {},
}));
vi.mock("../../src/mcp/tools.js", () => ({ registerTools: vi.fn() }));
vi.mock("../../src/mcp/config.js", () => ({
  createEngineFromEnv: vi.fn(async () => ({})),
}));
vi.mock("../../src/mcp/http.js", () => ({
  startHttpServer: vi.fn(async () => undefined),
}));
vi.mock("../../src/mcp/daemon.js", () => ({
  stopDaemon: vi.fn(async () => undefined),
  writePidFile: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() })),
}));

const { parseArgs } = await import("../../src/mcp/server.js");

describe("parseArgs", () => {
  it("returns defaults for an empty argv (after node + script)", () => {
    expect(parseArgs(["node", "server.js"])).toEqual({
      http: false,
      port: 8181,
      daemon: false,
      stop: false,
    });
  });

  it("recognises --http", () => {
    expect(parseArgs(["node", "server.js", "--http"])).toMatchObject({
      http: true,
      port: 8181,
    });
  });

  it("recognises --daemon", () => {
    expect(parseArgs(["node", "server.js", "--daemon"])).toMatchObject({ daemon: true });
  });

  it("recognises --stop", () => {
    expect(parseArgs(["node", "server.js", "--stop"])).toMatchObject({ stop: true });
  });

  it("recognises bare 'stop' subcommand form", () => {
    expect(parseArgs(["node", "server.js", "stop"])).toMatchObject({ stop: true });
  });

  it("parses --port with a valid number", () => {
    expect(parseArgs(["node", "server.js", "--http", "--port", "9090"])).toMatchObject({
      http: true,
      port: 9090,
    });
  });

  it("ignores --port with a non-numeric value (keeps default)", () => {
    expect(parseArgs(["node", "server.js", "--port", "abc"])).toMatchObject({ port: 8181 });
  });

  it("ignores --port with an out-of-range value (keeps default)", () => {
    expect(parseArgs(["node", "server.js", "--port", "70000"])).toMatchObject({ port: 8181 });
  });

  it("ignores --port with a non-positive value (keeps default)", () => {
    expect(parseArgs(["node", "server.js", "--port", "-1"])).toMatchObject({ port: 8181 });
    expect(parseArgs(["node", "server.js", "--port", "0"])).toMatchObject({ port: 8181 });
  });

  it("ignores --port with no following value", () => {
    // --port is the last arg, no value follows
    expect(parseArgs(["node", "server.js", "--port"])).toMatchObject({ port: 8181 });
  });

  it("combines --http --port --daemon", () => {
    expect(parseArgs(["node", "server.js", "--http", "--port", "8888", "--daemon"])).toEqual({
      http: true,
      port: 8888,
      daemon: true,
      stop: false,
    });
  });

  it("ignores unknown flags silently", () => {
    expect(parseArgs(["node", "server.js", "--unknown", "--http"])).toMatchObject({
      http: true,
    });
  });
});
