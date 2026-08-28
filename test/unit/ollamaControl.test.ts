import { describe, it, expect, vi } from "vitest";
import {
  detectOllamaSupervisor,
  readOllamaVersionSkew,
  restartOllama,
  waitForOllama,
  type ExecFn,
} from "../../src/core/ollamaControl.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An ExecFn driven by a table of "file arg arg" → stdout, rejecting otherwise. */
function fakeExec(responses: Record<string, string>): ExecFn {
  return vi.fn(async (file: string, args: readonly string[]) => {
    const key = [file, ...args].join(" ");
    if (key in responses) return { stdout: responses[key], stderr: "" };
    throw new Error(`command failed: ${key}`);
  });
}

const BREW_LIST = `Name    Status  User      File
ollama  started someuser  ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist
redis   none
`;

// ---------------------------------------------------------------------------
// detectOllamaSupervisor
// ---------------------------------------------------------------------------

describe("detectOllamaSupervisor", () => {
  it("detects a Homebrew-managed service on macOS", async () => {
    const supervisor = await detectOllamaSupervisor({
      exec: fakeExec({ "brew services list": BREW_LIST }),
      platform: "darwin",
    });

    expect(supervisor?.id).toBe("brew");
    expect(supervisor?.canRestart).toBe(true);
  });

  it("does not mistake another formula's name for the ollama service row", async () => {
    const supervisor = await detectOllamaSupervisor({
      exec: fakeExec({ "brew services list": "Name         Status\nnot-ollama   started\n" }),
      platform: "darwin",
      fileExists: () => false,
    });

    expect(supervisor).toBeNull();
  });

  it("reports Ollama.app as detected but not restartable", async () => {
    // Restarting a GUI app out from under the user is not ours to do.
    const supervisor = await detectOllamaSupervisor({
      exec: fakeExec({}),
      platform: "darwin",
      fileExists: (p) => p === "/Applications/Ollama.app",
    });

    expect(supervisor?.id).toBe("macos-app");
    expect(supervisor?.canRestart).toBe(false);
    expect(supervisor?.manualCommand).toBeTruthy();
  });

  it("detects a user systemd unit on Linux", async () => {
    const supervisor = await detectOllamaSupervisor({
      exec: fakeExec({ "systemctl --user is-active ollama": "active\n" }),
      platform: "linux",
    });

    expect(supervisor?.id).toBe("systemd-user");
    expect(supervisor?.canRestart).toBe(true);
  });

  it("reports a system systemd unit as not restartable (needs root)", async () => {
    const supervisor = await detectOllamaSupervisor({
      exec: fakeExec({ "systemctl is-active ollama": "active\n" }),
      platform: "linux",
    });

    expect(supervisor?.id).toBe("systemd-system");
    expect(supervisor?.canRestart).toBe(false);
    expect(supervisor?.manualCommand).toContain("systemctl");
  });

  it("returns null on an unsupported platform", async () => {
    const supervisor = await detectOllamaSupervisor({
      exec: fakeExec({}),
      platform: "win32",
    });

    expect(supervisor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// restartOllama
// ---------------------------------------------------------------------------

describe("restartOllama", () => {
  it("runs the allowlisted argv for a restartable supervisor", async () => {
    const exec = fakeExec({ "brew services restart ollama": "" });

    await restartOllama(
      { id: "brew", label: "Homebrew services", canRestart: true, manualCommand: "x" },
      { exec },
    );

    expect(exec).toHaveBeenCalledWith("brew", ["services", "restart", "ollama"]);
  });

  it("refuses to run anything for a supervisor with no allowlisted command", async () => {
    const exec = fakeExec({});

    await expect(
      restartOllama(
        {
          id: "systemd-system",
          label: "systemd (system)",
          canRestart: false,
          manualCommand: "sudo systemctl restart ollama",
        },
        { exec },
      ),
    ).rejects.toThrow(/will not restart/);

    // The guard must stop before any process is spawned.
    expect(exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// waitForOllama
// ---------------------------------------------------------------------------

describe("waitForOllama", () => {
  it("returns the version once the server answers", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.33.0" }),
    })) as unknown as typeof fetch;

    const version = await waitForOllama("http://127.0.0.1:11434", { fetchImpl });

    expect(version).toBe("0.33.0");
  });

  it("gives up at the deadline when the server never comes back", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const version = await waitForOllama("http://127.0.0.1:11434", {
      fetchImpl,
      timeoutMs: 30,
      intervalMs: 5,
    });

    expect(version).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readOllamaVersionSkew
// ---------------------------------------------------------------------------

describe("readOllamaVersionSkew", () => {
  it("detects the daemon/binary version skew that breaks model loading", async () => {
    const exec = fakeExec({
      "ollama --version": "ollama version is 0.16.3\nWarning: client version is 0.33.0\n",
    });

    const skew = await readOllamaVersionSkew({ exec });

    expect(skew).toEqual({ daemon: "0.16.3", client: "0.33.0", skewed: true });
  });

  it("reports no skew when the CLI prints a single version", async () => {
    const exec = fakeExec({ "ollama --version": "ollama version is 0.33.0\n" });

    const skew = await readOllamaVersionSkew({ exec });

    expect(skew?.skewed).toBe(false);
  });

  it("returns null when the CLI is not installed", async () => {
    const skew = await readOllamaVersionSkew({ exec: fakeExec({}) });

    expect(skew).toBeNull();
  });
});
