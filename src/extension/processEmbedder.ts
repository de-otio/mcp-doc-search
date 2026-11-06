/**
 * EmbedProvider that runs the built-in model in a forked child process.
 *
 * WHY: the model's synchronous pooling blocks whatever thread hosts it, and a
 * V8-fatal error kills the whole process. In the extension host that freezes
 * the editor and can take every extension in the window down (issue #117).
 * Here the worst case is the child dying, which fails the reindex with a
 * fatal `runner-load-failed` EmbedError — the indexer already knows how to
 * abort on that and the status bar shows why.
 *
 * Lifecycle: the child is spawned lazily on the first embed, reaped after an
 * idle period (freeing the model's memory), and respawned on demand. A circuit
 * breaker stops respawning once the child keeps dying.
 */

import { fork as nodeFork, type ChildProcess, type ForkOptions } from "node:child_process";
import { EmbedError } from "../core/embedder.js";
import { resolveLocalModel, type LocalModelSpec } from "../core/localModels.js";
import type { EmbedIdentity, EmbedProvider, HealthResult } from "../core/types.js";
import { WORKER_ENV_FLAG, type WorkerReply, type WorkerRequest } from "./embedWorker.js";

export type ForkFn = (modulePath: string, args: string[], options: ForkOptions) => ChildProcess;

export interface ProcessEmbedderOptions {
  /** Absolute path of the bundled worker (dist/embed-worker.js). */
  workerPath: string;
  /** LOCAL_MODELS id; blank = default. */
  model?: string;
  modelPath?: string;
  /** Receives the worker's stderr/stdout lines. Defaults to console.warn. */
  log?: (line: string) => void;
  /** Injectable for tests. Defaults to child_process.fork. */
  fork?: ForkFn;
  /** Timeout for the first request after a spawn (covers the model download). */
  firstRequestTimeoutMs?: number;
  /** Timeout for every later request. */
  requestTimeoutMs?: number;
  /** Idle time after which the child is disposed and killed. */
  idleTimeoutMs?: number;
  /** Crashes inside `crashWindowMs` after which respawning stops. */
  maxCrashes?: number;
  crashWindowMs?: number;
  execArgv?: string[];
}

const DEFAULTS = {
  firstRequestTimeoutMs: 120_000,
  requestTimeoutMs: 60_000,
  idleTimeoutMs: 5 * 60_000,
  maxCrashes: 3,
  crashWindowMs: 10 * 60_000,
  execArgv: ["--max-old-space-size=2048"],
} as const;

interface Pending {
  resolve(reply: WorkerReply): void;
  reject(err: EmbedError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One spawned child and the requests riding on it. Mutated by ProcessEmbedder only. */
interface Live {
  readonly child: ChildProcess;
  readonly pending: Map<number, Pending>;
  /** True once the child has answered anything — the model is then loaded. */
  replied: boolean;
  dead: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

const RELOAD_HINT =
  "Reload the window to try again, or switch Doc Search to Ollama (docSearch.embedProvider) " +
  "if the built-in model keeps failing.";

export class ProcessEmbedder implements EmbedProvider {
  readonly spec: LocalModelSpec;
  private readonly opts: ProcessEmbedderOptions &
    Required<Pick<ProcessEmbedderOptions, keyof typeof DEFAULTS>>;
  private readonly log: (line: string) => void;
  private readonly forkFn: ForkFn;

  // Mutable state, all confined to this instance (comment per house rules).
  private live: Live | undefined;
  private nextId = 1;
  private crashTimes: number[] = [];

  constructor(options: ProcessEmbedderOptions) {
    this.opts = {
      ...options,
      firstRequestTimeoutMs: options.firstRequestTimeoutMs ?? DEFAULTS.firstRequestTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      maxCrashes: options.maxCrashes ?? DEFAULTS.maxCrashes,
      crashWindowMs: options.crashWindowMs ?? DEFAULTS.crashWindowMs,
      execArgv: options.execArgv ?? [...DEFAULTS.execArgv],
    };
    this.spec = resolveLocalModel(options.model);
    this.log = options.log ?? ((line) => console.warn(line));
    this.forkFn = options.fork ?? nodeFork;
  }

  /** Same value LocalEmbedder reports; synchronous because the index location is keyed on it. */
  identity(): EmbedIdentity {
    return { provider: "local", model: this.spec.id, dim: this.spec.dim };
  }

  async embed(texts: string[], prefix = ""): Promise<number[][]> {
    if (texts.length === 0) return [];
    const reply = await this.request({ op: "embed", texts, prefix });
    if (!("vectors" in reply)) {
      throw new EmbedError("Embedding worker sent a malformed reply", "runner-load-failed");
    }
    return reply.vectors;
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const reply = await this.request({ op: "health" });
      if ("health" in reply) return reply.health;
      return {
        ok: false,
        kind: "runner-load-failed",
        detail: "Embedding worker sent a malformed reply",
        hint: RELOAD_HINT,
      };
    } catch (err) {
      if (err instanceof EmbedError) {
        return {
          ok: false,
          kind: err.kind === "unknown" ? "runner-load-failed" : err.kind,
          detail: err.message,
          hint: err.hint ?? RELOAD_HINT,
        };
      }
      return {
        ok: false,
        kind: "runner-load-failed",
        detail: err instanceof Error ? err.message : String(err),
        hint: RELOAD_HINT,
      };
    }
  }

  /** Kill the child and clear timers. A later embed() spawns a fresh one. */
  dispose(): void {
    if (this.live) {
      this.teardown(
        this.live,
        new EmbedError("Embedding process was disposed", "runner-load-failed"),
        false,
      );
    }
  }

  // -- request plumbing -----------------------------------------------------

  private request(body: DistributiveOmit<WorkerRequest, "id">): Promise<WorkerReply> {
    const live = this.ensureLive();
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
    const id = this.nextId++;
    const timeoutMs = live.replied ? this.opts.requestTimeoutMs : this.opts.firstRequestTimeoutMs;

    return new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.teardown(
          live,
          new EmbedError(
            `Built-in embedding process did not answer within ${Math.round(timeoutMs / 1000)}s`,
            "runner-load-failed",
            { timedOut: true, hint: RELOAD_HINT },
          ),
          true,
        );
      }, timeoutMs);
      timer.unref?.();
      live.pending.set(id, { resolve, reject, timer });

      const message = { ...body, id } as WorkerRequest;
      try {
        live.child.send(message, (err) => {
          if (err)
            this.teardown(live, this.processError(`could not reach it: ${err.message}`), true);
        });
      } catch (err) {
        this.teardown(
          live,
          this.processError(
            `could not reach it: ${err instanceof Error ? err.message : String(err)}`,
          ),
          true,
        );
      }
    }).then((reply) => {
      if (!reply.ok) {
        throw new EmbedError(reply.error.message, reply.error.kind, { hint: reply.error.hint });
      }
      return reply;
    });
  }

  private ensureLive(): Live {
    if (this.live && !this.live.dead) return this.live;

    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.opts.crashWindowMs);
    if (this.crashTimes.length >= this.opts.maxCrashes) {
      throw new EmbedError(
        `The built-in embedding model (${this.spec.id}) stopped ${this.crashTimes.length} times in the last ` +
          `${Math.round(this.opts.crashWindowMs / 60_000)} minutes; not restarting it.`,
        "runner-load-failed",
        { hint: RELOAD_HINT },
      );
    }
    return this.spawn();
  }

  private spawn(): Live {
    const args: string[] = [];
    if (this.opts.model) args.push(`--model=${this.opts.model}`);
    if (this.opts.modelPath) args.push(`--model-path=${this.opts.modelPath}`);

    let child: ChildProcess;
    try {
      child = this.forkFn(this.opts.workerPath, args, {
        serialization: "advanced",
        execArgv: [...this.opts.execArgv],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        // The extension host is an Electron binary; this makes the child run as plain Node there.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", [WORKER_ENV_FLAG]: "1" },
      });
    } catch (err) {
      this.crashTimes.push(Date.now());
      throw this.processError(
        `could not start it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const live: Live = {
      child,
      pending: new Map(),
      replied: false,
      dead: false,
      idleTimer: undefined,
    };
    this.live = live;

    const forward = (chunk: unknown): void => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) this.log(`[embed-worker] ${line}`);
      }
    };
    child.stderr?.on("data", forward);
    child.stdout?.on("data", forward);

    child.on("message", (raw: unknown) => {
      const reply = raw as WorkerReply | undefined;
      if (!reply || typeof reply.id !== "number") return;
      const pending = live.pending.get(reply.id);
      if (!pending) return; // answered after its timeout/teardown
      live.pending.delete(reply.id);
      clearTimeout(pending.timer);
      live.replied = true;
      pending.resolve(reply);
      if (live.pending.size === 0) this.armIdleTimer(live);
    });
    child.on("error", (err) => {
      this.teardown(live, this.processError(err.message), true);
    });
    child.on("exit", (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      this.teardown(live, this.processError(`it exited unexpectedly (${how})`), true);
    });

    return live;
  }

  private armIdleTimer(live: Live): void {
    if (live.dead) return;
    live.idleTimer = setTimeout(() => {
      if (live.dead || live.pending.size > 0) return;
      try {
        // Best effort: lets the worker drop the model; the kill below is what frees the memory.
        live.child.send({ id: 0, op: "dispose" } satisfies WorkerRequest);
      } catch {
        // Child already gone; teardown handles it.
      }
      this.teardown(live, new EmbedError("Embedding process idle", "runner-load-failed"), false);
    }, this.opts.idleTimeoutMs);
    live.idleTimer.unref?.();
  }

  /**
   * Retire a child: reject everything riding on it, clear its timers, kill it.
   * Idempotent — exit, error and timeout can all fire for one death.
   */
  private teardown(live: Live, error: EmbedError, countAsCrash: boolean): void {
    if (live.dead) return;
    live.dead = true;
    if (this.live === live) this.live = undefined;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    if (countAsCrash) this.crashTimes.push(Date.now());
    for (const pending of live.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    live.pending.clear();
    try {
      live.child.kill("SIGKILL");
    } catch {
      // Already dead.
    }
  }

  private processError(detail: string): EmbedError {
    return new EmbedError(
      `The built-in embedding process failed: ${detail}`,
      "runner-load-failed",
      { hint: RELOAD_HINT },
    );
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
