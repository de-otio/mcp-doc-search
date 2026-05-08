/**
 * Tests for the HTTP MCP transport and daemon lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub for EngineDeps used across tests. */
function makeStubDeps(disposeImpl?: () => void) {
  const reindexResult = { indexed: 0, skipped: 0, failedFiles: 0, totalChunks: 0, durationMs: 0 };
  return {
    store: { query: vi.fn(), listFiles: vi.fn().mockResolvedValue([]) },
    indexer: { reindex: vi.fn().mockResolvedValue(reindexResult) },
    embedProvider: {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      dispose: disposeImpl ?? vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  let port: number;
  let server: any;

  beforeEach(async () => {
    const { startHttpServer } = await import("../../src/mcp/http.js");
    const deps = makeStubDeps();
    // Use a dynamic port to avoid conflicts
    port = 18800 + Math.floor(Math.random() * 100);
    // Start with a very long idle timeout so it doesn't fire during tests
    await new Promise<void>((resolve) => {
      startHttpServer(deps, port, 60_000).then(() => resolve());
    });
  });

  afterEach(() => {
    // Reset module registry so each test gets a fresh http module (fresh startTime)
    vi.resetModules();
  });

  it("returns status ok and uptime >= 0", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// POST /mcp — basic MCP protocol
// ---------------------------------------------------------------------------

describe("POST /mcp", () => {
  let port: number;

  beforeEach(async () => {
    vi.resetModules();
    const { startHttpServer } = await import("../../src/mcp/http.js");
    const deps = makeStubDeps();
    port = 18900 + Math.floor(Math.random() * 100);
    await startHttpServer(deps, port, 60_000);
  });

  it("responds to MCP initialize request", async () => {
    const req = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(req),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // MCP response should have jsonrpc and result or error
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{ not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Concurrent requests
// ---------------------------------------------------------------------------

describe("Concurrent MCP requests", () => {
  let port: number;

  beforeEach(async () => {
    vi.resetModules();
    const { startHttpServer } = await import("../../src/mcp/http.js");
    const deps = makeStubDeps();
    port = 19000 + Math.floor(Math.random() * 100);
    await startHttpServer(deps, port, 60_000);
  });

  it("handles multiple concurrent initialize requests without interference", async () => {
    const makeRequest = (id: number) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: `client-${id}`, version: "1.0.0" },
          },
        }),
      });

    const responses = await Promise.all([makeRequest(10), makeRequest(20), makeRequest(30)]);

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const bodies = (await Promise.all(responses.map((r) => r.json()))) as any[];
    const ids = bodies.map((b: any) => b.id);
    expect(ids).toContain(10);
    expect(ids).toContain(20);
    expect(ids).toContain(30);
  });
});

// ---------------------------------------------------------------------------
// Idle model disposal
// ---------------------------------------------------------------------------

describe("Idle model disposal", () => {
  it("calls dispose() on the embed provider after the idle timeout", async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const { startHttpServer } = await import("../../src/mcp/http.js");
    const disposeFn = vi.fn();
    const deps = makeStubDeps(disposeFn);
    const port = 19100 + Math.floor(Math.random() * 100);

    await startHttpServer(deps, port, 100); // 100 ms idle for test

    // Trigger a request so the idle timer starts
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "idle-test", version: "1.0.0" },
        },
      }),
    });

    expect(disposeFn).not.toHaveBeenCalled();

    // Advance clock past idle timeout
    vi.advanceTimersByTime(200);
    await Promise.resolve(); // flush microtasks

    expect(disposeFn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("resets idle timer on each request", async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const { startHttpServer } = await import("../../src/mcp/http.js");
    const disposeFn = vi.fn();
    const deps = makeStubDeps(disposeFn);
    const port = 19200 + Math.floor(Math.random() * 100);

    await startHttpServer(deps, port, 300); // 300 ms idle

    const makeReq = () =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      });

    await makeReq();
    vi.advanceTimersByTime(200); // not yet expired
    await makeReq(); // reset the timer
    vi.advanceTimersByTime(200); // still not expired (reset from last request)
    expect(disposeFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200); // now expired
    await Promise.resolve();
    expect(disposeFn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// daemon.ts — PID file lifecycle
// ---------------------------------------------------------------------------

describe("Daemon PID file", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("writePidFile writes PID, readPidFile reads it back, removePidFile cleans up", async () => {
    const { writePidFile, readPidFile, removePidFile } = await import("../../src/mcp/daemon.js");

    const testPid = 99999;
    writePidFile(testPid);

    const read = readPidFile();
    expect(read).toBe(testPid);

    removePidFile();
    expect(readPidFile()).toBeNull();
  });

  it("readPidFile returns null when no PID file exists", async () => {
    const { readPidFile, removePidFile } = await import("../../src/mcp/daemon.js");
    removePidFile(); // ensure it's gone
    expect(readPidFile()).toBeNull();
  });

  it("stopDaemon prints 'no daemon running' when PID file is absent", async () => {
    const { removePidFile, stopDaemon } = await import("../../src/mcp/daemon.js");
    removePidFile();

    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((msg: any) => {
      written.push(String(msg));
      return true;
    });

    await stopDaemon();

    spy.mockRestore();
    expect(written.join("")).toContain("no daemon running");
  });
});
