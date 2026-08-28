/**
 * Detecting and restarting a local Ollama service.
 *
 * Exists for one recurring fault: a daemon left running across an upgrade
 * keeps serving `/api/version` while every model load fails, because it
 * spawns the *new* runner binary with flags the old daemon still passes.
 * The daemon looks healthy and every embed hangs. A restart fixes it.
 *
 * Deliberately free of vscode imports so the MCP server and CLI can use it.
 *
 * Security posture:
 *   - Commands are looked up from a frozen table by supervisor id. No value
 *     from settings, config, or a server response is ever placed in an argv.
 *   - execFile with an argv array, never a shell string — nothing is parsed
 *     by a shell, so there is no injection surface even if that changed.
 *   - Never sudo. Supervisors needing root are reported for the user to run
 *     themselves rather than escalated to.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Injectable process runner, so tests never touch a real service manager. */
export type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (file, args) =>
  execFileAsync(file, [...args], { timeout: 20_000 });

export type SupervisorId = "brew" | "systemd-user" | "systemd-system" | "macos-app";

export interface OllamaSupervisor {
  id: SupervisorId;
  /** Human-readable name for the notification text. */
  label: string;
  /**
   * Whether this extension may run the restart itself. False for supervisors
   * that need root or would restart a GUI application out from under the user.
   */
  canRestart: boolean;
  /** The command to show when we will not run it ourselves. */
  manualCommand: string;
}

/**
 * The only commands this module will ever execute, keyed by supervisor id.
 * A lookup table rather than validation: there is no code path that can run
 * an argv assembled from anywhere else.
 */
const RESTART_COMMANDS: Readonly<Record<SupervisorId, readonly string[] | null>> = Object.freeze({
  brew: Object.freeze(["brew", "services", "restart", "ollama"]),
  "systemd-user": Object.freeze(["systemctl", "--user", "restart", "ollama"]),
  // Needs root — reported, never run.
  "systemd-system": null,
  // Restarting a GUI app is the user's call, not ours.
  "macos-app": null,
});

const SUPERVISOR_LABELS: Readonly<Record<SupervisorId, string>> = Object.freeze({
  brew: "Homebrew services",
  "systemd-user": "systemd (user)",
  "systemd-system": "systemd (system)",
  "macos-app": "Ollama.app",
});

const MANUAL_COMMANDS: Readonly<Record<SupervisorId, string>> = Object.freeze({
  brew: "brew services restart ollama",
  "systemd-user": "systemctl --user restart ollama",
  "systemd-system": "sudo systemctl restart ollama",
  "macos-app": "Quit Ollama from the menu bar, then reopen it",
});

function makeSupervisor(id: SupervisorId): OllamaSupervisor {
  return {
    id,
    label: SUPERVISOR_LABELS[id],
    canRestart: RESTART_COMMANDS[id] !== null,
    manualCommand: MANUAL_COMMANDS[id],
  };
}

export interface DetectOptions {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
}

/**
 * Identify how Ollama is being supervised, or null if we cannot tell.
 *
 * Returning a supervisor does not imply we may restart it — check `canRestart`.
 */
export async function detectOllamaSupervisor(
  options: DetectOptions = {},
): Promise<OllamaSupervisor | null> {
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;

  if (platform === "darwin") {
    try {
      const { stdout } = await exec("brew", ["services", "list"]);
      // Match the service row, not a substring of some other formula's name.
      if (/^ollama\s/m.test(stdout)) return makeSupervisor("brew");
    } catch {
      // brew absent or failed — fall through to the app check.
    }
    if (fileExists("/Applications/Ollama.app")) return makeSupervisor("macos-app");
    return null;
  }

  if (platform === "linux") {
    for (const id of ["systemd-user", "systemd-system"] as const) {
      const args =
        id === "systemd-user" ? ["--user", "is-active", "ollama"] : ["is-active", "ollama"];
      try {
        const { stdout } = await exec("systemctl", args);
        if (stdout.trim() === "active") return makeSupervisor(id);
      } catch {
        // `is-active` exits non-zero when inactive; try the next scope.
      }
    }
    return null;
  }

  return null;
}

/**
 * Restart Ollama via a supervisor that permits it.
 *
 * Throws when the supervisor is one we refuse to drive (root, GUI app) — the
 * caller should surface `manualCommand` instead.
 */
export async function restartOllama(
  supervisor: OllamaSupervisor,
  options: { exec?: ExecFn } = {},
): Promise<void> {
  const command = RESTART_COMMANDS[supervisor.id];
  if (!command) {
    throw new Error(
      `Doc Search will not restart Ollama under ${supervisor.label}. ` +
        `Run this yourself: ${supervisor.manualCommand}`,
    );
  }
  const exec = options.exec ?? defaultExec;
  const [file, ...args] = command;
  await exec(file, args);
}

/**
 * Poll `/api/version` until Ollama answers, returning its version.
 *
 * The point is to *verify* a restart rather than assume it: the caller can
 * compare this against the version seen before, and a version that did not
 * change is a signal the restart did not take effect.
 */
export async function waitForOllama(
  baseUrl: string,
  options: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/$/, "")}/api/version`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const response = await fetchImpl(url, { method: "GET" });
      if (response.ok) {
        const data = (await response.json()) as { version?: string };
        return data.version ?? "unknown";
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Read the Ollama CLI's view of daemon vs client version.
 *
 * `ollama --version` prints a second `Warning: client version is X` line only
 * when the running daemon and the on-disk binary disagree — the exact skew
 * that breaks model loading. Enrichment for error messages only: detection
 * never depends on the CLI being installed.
 */
export async function readOllamaVersionSkew(
  options: { exec?: ExecFn } = {},
): Promise<{ daemon?: string; client?: string; skewed: boolean } | null> {
  const exec = options.exec ?? defaultExec;
  try {
    const { stdout, stderr } = await exec("ollama", ["--version"]);
    const output = `${stdout}\n${stderr}`;
    const daemon = /ollama version is (\S+)/.exec(output)?.[1];
    const client = /client version is (\S+)/.exec(output)?.[1];
    return { daemon, client, skewed: Boolean(client && daemon && client !== daemon) };
  } catch {
    return null;
  }
}
