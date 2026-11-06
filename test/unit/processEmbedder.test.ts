import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fork as nodeFork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EmbedError, LocalEmbedder } from "../../src/core/embedder.js";
import {
  ProcessEmbedder,
  type ProcessEmbedderOptions,
} from "../../src/extension/processEmbedder.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "embed-workers",
);
const fixture = (name: string): string => path.join(FIXTURES, name);

/**
 * Real child processes running tiny fixture scripts — the model is never
 * loaded. `scripts` picks the fixture per spawn (last one repeats), so a test
 * can say "first spawn crashes, the next one works".
 */
function harness(scripts: string[], extra: Partial<ProcessEmbedderOptions> = {}) {
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const fork = vi.fn(
    (_modulePath: string, args: string[], options: Parameters<typeof nodeFork>[2]) => {
      const script = scripts[Math.min(children.length, scripts.length - 1)]!;
      const child = nodeFork(fixture(script), args, options);
      children.push(child);
      return child;
    },
  );
  const embedder = new ProcessEmbedder({
    workerPath: "unused-by-the-fake-fork",
    fork,
    log: (line) => logs.push(line),
    ...extra,
  });
  return { embedder, fork, children, logs };
}

const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", () => resolve()));

/** Wait (real time) until `cond` holds; fake timers never block this. */
async function until(cond: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error("until(): condition never became true");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function caught(promise: Promise<unknown>): Promise<EmbedError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(EmbedError);
    return err as EmbedError;
  }
  throw new Error("expected the promise to reject");
}

describe("ProcessEmbedder", () => {
  const live: ProcessEmbedder[] = [];
  const track = <T extends { embedder: ProcessEmbedder }>(h: T): T => {
    live.push(h.embedder);
    return h;
  };

  afterEach(() => {
    vi.useRealTimers();
    for (const e of live.splice(0)) e.dispose();
  });

  describe("identity", () => {
    it.each([undefined, "", "Xenova/multilingual-e5-small", "nomic-ai/nomic-embed-text-v1.5"])(
      "matches LocalEmbedder for model %j without spawning",
      (model) => {
        const { embedder, fork } = track(harness(["echo.cjs"], { model }));
        expect(embedder.identity()).toEqual(new LocalEmbedder({ model }).identity());
        expect(fork).not.toHaveBeenCalled();
      },
    );

    it("embedding no texts answers locally without spawning", async () => {
      const { embedder, fork } = track(harness(["echo.cjs"]));
      await expect(embedder.embed([])).resolves.toEqual([]);
      expect(fork).not.toHaveBeenCalled();
    });
  });

  describe("request matching", () => {
    it("forks lazily with the expected options and forwards model flags", async () => {
      const { embedder, fork } = track(
        harness(["echo.cjs"], { model: "Xenova/multilingual-e5-small", modelPath: "/models" }),
      );
      await embedder.embed(["hi"]);
      expect(fork).toHaveBeenCalledTimes(1);
      const [, args, options] = fork.mock.calls[0]!;
      expect(args).toEqual(["--model=Xenova/multilingual-e5-small", "--model-path=/models"]);
      expect(options).toMatchObject({
        serialization: "advanced",
        execArgv: ["--max-old-space-size=2048"],
      });
      expect(options.stdio).toEqual(["ignore", "pipe", "pipe", "ipc"]);
    });

    it("resolves concurrent embeds to their own vectors when replies arrive out of order", async () => {
      const { embedder, fork } = track(harness(["echo.cjs"]));
      const order: string[] = [];
      const a = embedder.embed(["slow-aaaa"]).then((v) => (order.push("a"), v));
      const b = embedder.embed(["bb"]).then((v) => (order.push("b"), v));
      const c = embedder.embed(["ccc", "d"]).then((v) => (order.push("c"), v));

      expect(await a).toEqual([[9, "s".charCodeAt(0)]]);
      expect(await b).toEqual([[2, "b".charCodeAt(0)]]);
      expect(await c).toEqual([
        [3, "c".charCodeAt(0)],
        [1, "d".charCodeAt(0)],
      ]);
      // The slow request really did finish last, so id matching was exercised.
      expect(order).toEqual(["b", "c", "a"]);
      expect(fork).toHaveBeenCalledTimes(1);
    });

    it("forwards worker stderr to the log function", async () => {
      const { embedder, logs } = track(harness(["echo.cjs"]));
      await embedder.embed(["x"]);
      await until(() => logs.length > 0);
      expect(logs).toContain("[embed-worker] echo worker started");
    });

    it("forwards healthCheck to the worker", async () => {
      const { embedder } = track(harness(["echo.cjs"]));
      await expect(embedder.healthCheck()).resolves.toEqual({ ok: true, detail: "echo" });
    });
  });

  describe("worker-reported errors", () => {
    it("rethrows with the worker's kind and hint and keeps the child alive", async () => {
      const { embedder, fork } = track(harness(["error.cjs"]));
      const first = await caught(embedder.embed(["a"]));
      expect(first.kind).toBe("model-missing");
      expect(first.message).toBe("model files missing");
      expect(first.hint).toBe("Run the download");
      expect(first.timedOut).toBe(false);

      await caught(embedder.embed(["b"]));
      expect(fork).toHaveBeenCalledTimes(1);
    });

    it("surfaces them through healthCheck as a failed result, not a throw", async () => {
      const { embedder } = track(harness(["error.cjs"]));
      await expect(embedder.healthCheck()).resolves.toEqual({
        ok: false,
        kind: "model-missing",
        detail: "model files missing",
        hint: "Run the download",
      });
    });
  });

  describe("child crashes", () => {
    it("rejects the in-flight call with runner-load-failed, then respawns and succeeds", async () => {
      const { embedder, fork } = track(harness(["crash.cjs", "echo.cjs"]));
      const err = await caught(embedder.embed(["a"]));
      expect(err.kind).toBe("runner-load-failed");
      expect(err.message).toContain("code 5");
      expect(fork).toHaveBeenCalledTimes(1);

      await expect(embedder.embed(["zz"])).resolves.toEqual([[2, "z".charCodeAt(0)]]);
      expect(fork).toHaveBeenCalledTimes(2);
    });

    it("rejects every in-flight request when the child dies", async () => {
      const { embedder } = track(harness(["crash.cjs"]));
      const results = await Promise.allSettled([embedder.embed(["a"]), embedder.embed(["b"])]);
      for (const r of results) {
        expect(r.status).toBe("rejected");
        expect((r as PromiseRejectedResult).reason).toMatchObject({ kind: "runner-load-failed" });
      }
    });

    it("healthCheck reports a dead process as runner-load-failed with a hint", async () => {
      const { embedder } = track(harness(["crash.cjs"]));
      const health = await embedder.healthCheck();
      expect(health.ok).toBe(false);
      expect(health.kind).toBe("runner-load-failed");
      expect(health.detail).toContain("code 5");
      expect(health.hint).toBeTruthy();
    });

    it("stops respawning after 3 crashes in the window and says how to recover", async () => {
      const { embedder, fork } = track(harness(["crash.cjs"]));
      for (let i = 0; i < 3; i++) {
        expect((await caught(embedder.embed(["a"]))).kind).toBe("runner-load-failed");
      }
      expect(fork).toHaveBeenCalledTimes(3);

      const err = await caught(embedder.embed(["a"]));
      expect(err.kind).toBe("runner-load-failed");
      expect(err.hint).toMatch(/Reload the window/);
      expect(err.hint).toMatch(/Ollama/);
      expect(fork).toHaveBeenCalledTimes(3);
    });

    it("2 crashes do not trip the breaker", async () => {
      const { embedder, fork } = track(harness(["crash.cjs", "crash.cjs", "echo.cjs"]));
      await caught(embedder.embed(["a"]));
      await caught(embedder.embed(["a"]));
      await expect(embedder.embed(["ok"])).resolves.toHaveLength(1);
      expect(fork).toHaveBeenCalledTimes(3);
    });

    it("lets crashes age out of the window", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { embedder, fork } = track(
        harness(["crash.cjs", "crash.cjs", "crash.cjs", "echo.cjs"]),
      );
      for (let i = 0; i < 3; i++) await caught(embedder.embed(["a"]));
      await caught(embedder.embed(["a"]));
      expect(fork).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      await expect(embedder.embed(["ok"])).resolves.toHaveLength(1);
      expect(fork).toHaveBeenCalledTimes(4);
    });

    it("converts a fork() that throws into runner-load-failed", async () => {
      const embedder = new ProcessEmbedder({
        workerPath: "x",
        fork: () => {
          throw new Error("spawn EACCES");
        },
        log: () => {},
      });
      const err = await caught(embedder.embed(["a"]));
      expect(err.kind).toBe("runner-load-failed");
      expect(err.message).toContain("spawn EACCES");
    });
  });

  describe("timeouts", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    it("kills a hung first request after 120s, not before", async () => {
      const { embedder, children } = track(harness(["hang.cjs"]));
      let settled = false;
      const p = caught(embedder.embed(["a"]));
      void p.then(() => (settled = true));
      await until(() => children.length === 1);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const err = await p;
      expect(err.timedOut).toBe(true);
      expect(err.kind).toBe("runner-load-failed");
      await exited(children[0]!);
      expect(children[0]!.killed).toBe(true);
    });

    it("uses the shorter 60s limit once the child has answered", async () => {
      const { embedder, children } = track(harness(["hang-after-first.cjs"]));
      await expect(embedder.embed(["a"])).resolves.toEqual([[1, 1]]);

      let settled = false;
      const p = caught(embedder.embed(["b"]));
      void p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const err = await p;
      expect(err.timedOut).toBe(true);
      await exited(children[0]!);
    });

    it("respawns after a timeout", async () => {
      const { embedder, fork, children } = track(harness(["hang.cjs", "echo.cjs"]));
      const p = caught(embedder.embed(["a"]));
      await until(() => children.length === 1);
      await vi.advanceTimersByTimeAsync(120_000);
      await p;

      await expect(embedder.embed(["ok"])).resolves.toHaveLength(1);
      expect(fork).toHaveBeenCalledTimes(2);
    });
  });

  describe("idle timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    it("kills the idle child after 5 minutes and respawns on the next call", async () => {
      const { embedder, fork, children } = track(harness(["echo.cjs"]));
      await embedder.embed(["a"]);
      expect(children[0]!.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(children[0]!.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(children[0]!.killed).toBe(true);
      await exited(children[0]!);

      await expect(embedder.embed(["bb"])).resolves.toEqual([[2, "b".charCodeAt(0)]]);
      expect(fork).toHaveBeenCalledTimes(2);
    });

    it("an intentional idle stop does not count toward the crash breaker", async () => {
      const { embedder, fork } = track(harness(["echo.cjs"]));
      for (let i = 0; i < 4; i++) {
        await embedder.embed(["a"]);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      }
      await expect(embedder.embed(["a"])).resolves.toHaveLength(1);
      expect(fork).toHaveBeenCalledTimes(5);
    });

    it("activity restarts the idle clock", async () => {
      const { embedder, children } = track(harness(["echo.cjs"]));
      await embedder.embed(["a"]);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await embedder.embed(["b"]);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(children[0]!.killed).toBe(false);
    });
  });

  describe("dispose", () => {
    it("kills the child, and a later embed spawns a fresh one", async () => {
      const { embedder, fork, children } = track(harness(["echo.cjs"]));
      await embedder.embed(["a"]);
      embedder.dispose();
      expect(children[0]!.killed).toBe(true);
      await exited(children[0]!);

      await expect(embedder.embed(["b"])).resolves.toHaveLength(1);
      expect(fork).toHaveBeenCalledTimes(2);
    });

    it("rejects requests still in flight", async () => {
      const { embedder, children } = track(harness(["hang.cjs"]));
      const p = caught(embedder.embed(["a"]));
      await until(() => children.length === 1);
      embedder.dispose();
      expect((await p).kind).toBe("runner-load-failed");
    });

    it("is a no-op before anything spawned", () => {
      const { embedder, fork } = track(harness(["echo.cjs"]));
      expect(() => embedder.dispose()).not.toThrow();
      expect(fork).not.toHaveBeenCalled();
    });
  });
});
