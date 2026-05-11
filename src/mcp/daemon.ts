/**
 * Daemon lifecycle management for the HTTP MCP server.
 * Handles PID file creation, reading, and process management.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(homedir(), ".cache", "mcp-doc-search");
const PID_FILE = join(CACHE_DIR, "mcp.pid");

export function getPidFilePath(): string {
  return PID_FILE;
}

/** Thrown when a live daemon already holds the pidfile. */
export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly existingPid: number) {
    super(`daemon already running (PID ${existingPid})`);
    this.name = "DaemonAlreadyRunningError";
  }
}

/**
 * L3: atomic pidfile write via O_EXCL.
 *
 * If the file does not exist, create-and-write atomically.
 * If it exists and references a live process, refuse — refusing to clobber
 * another daemon's pidfile is the whole point of this hardening.
 * If it exists but the recorded PID is dead (stale pidfile from a crash),
 * remove it and retry the O_EXCL open.
 *
 * Throws `DaemonAlreadyRunningError` when a live daemon already holds the
 * file, so the caller can exit cleanly without overwriting state.
 */
export function writePidFile(pid: number): void {
  mkdirSync(CACHE_DIR, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" → O_WRONLY | O_CREAT | O_EXCL: fails if the file already exists.
      const fd = openSync(PID_FILE, "wx");
      try {
        writeSync(fd, String(pid));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Pidfile exists. Inspect the recorded PID; only overwrite if dead.
      const existing = readPidFile();
      if (existing !== null && isRunning(existing) && existing !== pid) {
        throw new DaemonAlreadyRunningError(existing);
      }
      // Stale: remove and retry the O_EXCL open in the next loop iteration.
      try {
        unlinkSync(PID_FILE);
      } catch (unlinkErr) {
        const code = (unlinkErr as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw unlinkErr;
      }
    }
  }

  // Fallback: if O_EXCL still failed after a stale-removal pass, fall through
  // to a plain write. Reaching here implies a race with another process —
  // accept that and emit; caller's startup logic remains the source of truth.
  writeFileSync(PID_FILE, String(pid), "utf8");
}

export function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch (err) {
    // Pidfile vanished between existsSync and readFileSync (race) — treat as absent.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function removePidFile(): void {
  try {
    unlinkSync(PID_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Check if a process is running by sending signal 0.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the daemon: read PID, send SIGTERM, wait up to 5s, then SIGKILL.
 * Removes PID file on success.
 *
 * L3: every kill() is wrapped — ESRCH (process already gone, e.g. crashed
 * between our liveness check and the signal) is treated as "already gone"
 * rather than a fatal error, so a stale pidfile after a crash doesn't
 * prevent clean state recovery.
 */
export async function stopDaemon(): Promise<void> {
  const pid = readPidFile();

  if (pid === null) {
    process.stdout.write("no daemon running\n");
    return;
  }

  if (!isRunning(pid)) {
    removePidFile();
    process.stdout.write("no daemon running\n");
    return;
  }

  if (!safeKill(pid, "SIGTERM")) {
    // Process died between the isRunning() check and SIGTERM. Treat as stopped.
    removePidFile();
    process.stdout.write(`stopped (PID: ${pid})\n`);
    return;
  }

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (isRunning(pid)) {
    safeKill(pid, "SIGKILL");
    // Brief wait for SIGKILL to take effect
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  removePidFile();
  process.stdout.write(`stopped (PID: ${pid})\n`);
}

/** Send a signal; return true if delivered, false on ESRCH (process gone). */
function safeKill(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}
