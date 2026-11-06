/**
 * Child-process entry point for the built-in (transformers.js) embedder.
 * Bundled to dist/embed-worker.js and forked by ProcessEmbedder.
 *
 * WHY a separate process: the model's tokenization and pooling run as
 * synchronous JS, and a native or V8-fatal failure inside onnxruntime takes
 * down whichever process hosts it. In the extension host that is every
 * extension in the window; here it is only this child (see issue #117).
 *
 * Protocol (Node IPC, "advanced" serialization): the parent sends
 * `WorkerRequest`s, this process answers each with a `WorkerReply` carrying the
 * same `id`. The model is chosen by argv (`--model=`, `--model-path=`). The
 * process exits when the parent disconnects, so it can never outlive the host.
 */

import { EmbedError, LocalEmbedder } from "../core/embedder.js";
import type { EmbedFailureKind, EmbedProvider, HealthResult } from "../core/types.js";

/** Env var the parent sets so importing this module (e.g. in tests) never starts the loop. */
export const WORKER_ENV_FLAG = "DOC_SEARCH_EMBED_WORKER";

export type WorkerRequest =
  | { id: number; op: "embed"; texts: string[]; prefix?: string }
  | { id: number; op: "health" }
  | { id: number; op: "dispose" };

export interface WorkerErrorPayload {
  message: string;
  kind: EmbedFailureKind;
  hint?: string;
}

export type WorkerReply =
  | { id: number; ok: true; vectors: number[][] }
  | { id: number; ok: true; health: HealthResult }
  | { id: number; ok: true }
  | { id: number; ok: false; error: WorkerErrorPayload };

/** The slice of an embedder the worker drives; LocalEmbedder satisfies it. */
export type WorkerEmbedder = Required<Pick<EmbedProvider, "embed" | "healthCheck" | "dispose">>;

export function toErrorPayload(err: unknown): WorkerErrorPayload {
  if (err instanceof EmbedError) {
    return { message: err.message, kind: err.kind, hint: err.hint };
  }
  return { message: err instanceof Error ? err.message : String(err), kind: "unknown" };
}

/** Answer one request. Never throws: failures become `ok: false` replies. */
export async function handleWorkerRequest(
  embedder: WorkerEmbedder,
  request: WorkerRequest,
): Promise<WorkerReply> {
  const { id } = request;
  try {
    switch (request.op) {
      case "embed":
        return { id, ok: true, vectors: await embedder.embed(request.texts, request.prefix) };
      case "health":
        return { id, ok: true, health: await embedder.healthCheck() };
      case "dispose":
        embedder.dispose();
        return { id, ok: true };
      default:
        return {
          id,
          ok: false,
          error: {
            message: `Unknown embed-worker op: ${String((request as { op?: unknown }).op)}`,
            kind: "unknown",
          },
        };
    }
  } catch (err) {
    return { id, ok: false, error: toErrorPayload(err) };
  }
}

/** Parse `--model=<id>` / `--model-path=<dir>`; blank values mean "default". */
export function parseWorkerArgs(argv: readonly string[]): { model?: string; modelPath?: string } {
  const value = (flag: string): string | undefined => {
    const prefix = `--${flag}=`;
    const found = argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
    return found ? found : undefined;
  };
  return { model: value("model"), modelPath: value("model-path") };
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { id?: unknown; op?: unknown };
  return typeof v.id === "number" && typeof v.op === "string";
}

function runWorker(): void {
  const embedder = new LocalEmbedder(parseWorkerArgs(process.argv.slice(2)));
  const send = process.send?.bind(process);
  if (!send) return;

  process.on("message", (message: unknown) => {
    if (!isWorkerRequest(message)) return;
    void handleWorkerRequest(embedder, message).then((reply) => send(reply));
  });
  // The parent is gone (host closed or crashed): nobody can read replies.
  process.on("disconnect", () => process.exit(0));
}

if (process.env[WORKER_ENV_FLAG] === "1" && typeof process.send === "function") {
  runWorker();
}
