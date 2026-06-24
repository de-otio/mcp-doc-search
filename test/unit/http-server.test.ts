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

  it("returns 405 for unsupported methods on /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "PUT" });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Method not allowed");
  });
});

// ---------------------------------------------------------------------------
// M2: request body size cap (10 MB). Separate describe so we land on a
// distinct port range from the other POST /mcp tests, which leave their
// servers listening for the lifetime of the file.
// ---------------------------------------------------------------------------

describe("POST /mcp body size cap", () => {
  let port: number;

  beforeEach(async () => {
    vi.resetModules();
    const { startHttpServer } = await import("../../src/mcp/http.js");
    const deps = makeStubDeps();
    port = 19500 + Math.floor(Math.random() * 100);
    await startHttpServer(deps, port, 60_000);
  });

  it("rejects an oversized body with 413 (M2)", async () => {
    // 11 MB POST — one byte over the cap.
    const oversize = "x".repeat(11 * 1024 * 1024);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversize,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too large/i);
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
  // If startHttpServer rejects (e.g. the host blocks loopback listen), the
  // `vi.useRealTimers()` at the end of a test never runs and fake timers leak
  // into later describe blocks, cascading unrelated failures. Always restore.
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  // Guarantee a clean global state for every daemon test: restore any spy
  // (e.g. a leaked process.kill mock that would make a dead PID look alive)
  // and any fake timers a preceding describe block failed to tear down.
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("stopDaemon removes stale PID file when process is not running", async () => {
    const { writePidFile, readPidFile, stopDaemon } = await import("../../src/mcp/daemon.js");
    writePidFile(99999);

    // process.kill on a nonexistent PID throws ESRCH
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const written: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((msg: any) => {
      written.push(String(msg));
      return true;
    });

    await stopDaemon();

    killSpy.mockRestore();
    stdoutSpy.mockRestore();
    expect(readPidFile()).toBeNull();
    expect(written.join("")).toContain("no daemon running");
  });

  it("stopDaemon sends SIGTERM, waits, then removes the PID file", async () => {
    const { writePidFile, readPidFile, stopDaemon } = await import("../../src/mcp/daemon.js");
    writePidFile(88888);

    let alive = true;
    let sigtermReceived = false;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: any) => {
      if (sig === 0) {
        if (!alive) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true as any;
      }
      if (sig === "SIGTERM") {
        sigtermReceived = true;
        // Simulate the process exiting shortly after SIGTERM
        setTimeout(() => {
          alive = false;
        }, 50);
        return true as any;
      }
      return true as any;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await stopDaemon();

    killSpy.mockRestore();
    stdoutSpy.mockRestore();
    expect(sigtermReceived).toBe(true);
    expect(readPidFile()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // L3: O_EXCL pidfile creation + ESRCH-tolerant stop
  // -------------------------------------------------------------------------

  it("writePidFile refuses to clobber a live daemon's pidfile (L3)", async () => {
    const { writePidFile, removePidFile, DaemonAlreadyRunningError } =
      await import("../../src/mcp/daemon.js");
    removePidFile();

    // Use our own PID — it's definitely live — to simulate "another daemon" holding the file.
    writePidFile(process.pid);

    // Second writer (different PID) must throw, not overwrite.
    expect(() => writePidFile(process.pid + 1)).toThrow(DaemonAlreadyRunningError);

    removePidFile();
  });

  it("writePidFile overwrites a stale pidfile from a dead process (L3)", async () => {
    const { writePidFile, readPidFile, removePidFile } = await import("../../src/mcp/daemon.js");
    removePidFile();

    // PID 99999 is almost certainly not running on the test host.
    writePidFile(99999);
    expect(readPidFile()).toBe(99999);

    // Writing again should succeed because the recorded PID is dead.
    writePidFile(88888);
    expect(readPidFile()).toBe(88888);

    removePidFile();
  });

  it("stopDaemon survives a race where the process dies between liveness check and kill (L3)", async () => {
    const { writePidFile, readPidFile, stopDaemon } = await import("../../src/mcp/daemon.js");
    writePidFile(77777);

    // First kill(pid, 0) reports alive; then kill(pid, SIGTERM) raises ESRCH
    // (process exited between checks).
    let probeCount = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: any) => {
      if (sig === 0) {
        probeCount += 1;
        if (probeCount === 1) return true as any; // alive on first probe
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      if (sig === "SIGTERM") {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true as any;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Should not throw — ESRCH means the daemon is already gone.
    await expect(stopDaemon()).resolves.toBeUndefined();

    killSpy.mockRestore();
    stdoutSpy.mockRestore();
    expect(readPidFile()).toBeNull();
  });
});
