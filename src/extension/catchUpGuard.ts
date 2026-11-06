import { createHash } from "node:crypto";

/**
 * Crash-loop guard for the activation-time catch-up reindex (#117).
 *
 * A reindex killed mid-run leaves its lock behind and its work unfinished, so
 * the next activation's catch-up reindex restarts straight into the same work.
 * If that work is what takes the extension host down, the window crash-loops.
 * The guard counts consecutive activations that found a lock left by a dead
 * process and, from `PAUSE_AFTER_UNFINISHED_RUNS` on, stops running the
 * catch-up automatically until a run is seen to finish.
 */

/** Stale (dead-holder) locks in a row after which automatic indexing pauses. */
export const PAUSE_AFTER_UNFINISHED_RUNS = 2;

export interface CatchUpInput {
  /** `clearStaleReindexLock()` removed a lock left by a dead process. */
  readonly staleCleared: boolean;
  /** Consecutive unfinished runs recorded before this activation. */
  readonly count: number;
  readonly autoReindex: boolean;
  /** Whether the index is behind the files. Only read when `autoReindex` is on. */
  readonly needsReindex: boolean;
}

export interface CatchUpDecision {
  /** Start the automatic catch-up reindex now. */
  readonly run: boolean;
  /** Show the "indexing is paused" warning. */
  readonly warn: boolean;
  /** Value to persist as the counter. */
  readonly nextCount: number;
}

/**
 * Decide what the activation does about the catch-up reindex.
 *
 * Only a lock left by a dead process counts: a live lock (e.g. the file
 * watcher's own run) is never reported by `clearStaleReindexLock`, so it
 * cannot reach here as `staleCleared`.
 *
 * - Automatic indexing off: nothing runs; a stale lock is still recorded.
 * - Index already up to date: the earlier runs evidently finished the work,
 *   so the counter resets and nothing is shown.
 * - Counter at or past the threshold with work pending: pause and warn.
 * - Otherwise run; the caller resets the counter once the run succeeds.
 */
export function decideCatchUp(input: CatchUpInput): CatchUpDecision {
  const count = input.count + (input.staleCleared ? 1 : 0);
  if (!input.autoReindex) return { run: false, warn: false, nextCount: count };
  if (!input.needsReindex) return { run: false, warn: false, nextCount: 0 };
  if (count >= PAUSE_AFTER_UNFINISHED_RUNS) return { run: false, warn: true, nextCount: count };
  return { run: true, warn: false, nextCount: count };
}

/**
 * globalState key for a workspace's counter. Global state is shared by every
 * window of the extension, so the key carries a hash of the workspace root:
 * one project's trouble must not pause indexing in another.
 */
export function unfinishedRunsKey(workspaceRoot: string): string {
  const id = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return `docSearch.unfinishedRuns.${id}`;
}
