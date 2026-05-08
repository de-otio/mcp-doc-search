/**
 * Daemon lifecycle management for the HTTP MCP server.
 * Handles PID file creation, reading, and process management.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(homedir(), ".cache", "mcp-doc-search");
const PID_FILE = join(CACHE_DIR, "mcp.pid");

export function getPidFilePath(): string {
  return PID_FILE;
}

export function writePidFile(pid: number): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid), "utf8");
}

export function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

export function removePidFile(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
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

  process.kill(pid, "SIGTERM");

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (isRunning(pid)) {
    process.kill(pid, "SIGKILL");
    // Brief wait for SIGKILL to take effect
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  removePidFile();
  process.stdout.write(`stopped (PID: ${pid})\n`);
}
