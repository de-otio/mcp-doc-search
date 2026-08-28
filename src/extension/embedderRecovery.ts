/**
 * Turning an unusable embedding provider into something the user can act on.
 *
 * Lives in its own module rather than in commands.ts because indexStatusPanel
 * needs it too, and commands.ts already imports the panel — importing back
 * would create a require cycle.
 */

import * as vscode from "vscode";
import { EmbedderUnavailableError } from "../core/embedder.js";
import {
  detectOllamaSupervisor,
  readOllamaVersionSkew,
  restartOllama,
  waitForOllama,
} from "../core/ollamaControl.js";
import { readConfig } from "./config.js";

/** Whether the caller should retry the operation after a successful recovery. */
export type RecoveryOutcome = "recovered" | "not-recovered";

/** One restart per user-initiated reindex, so a broken install cannot loop. */
let restartAttempted = false;

/** Call at the start of each user-initiated reindex. */
export function resetRecoveryAttempts(): void {
  restartAttempted = false;
}

/**
 * Report an unusable embedder and, where possible, offer to fix it.
 *
 * Returns "recovered" when Ollama was restarted and verified healthy, meaning
 * the caller should retry once.
 */
export async function handleEmbedderFailure(
  err: EmbedderUnavailableError,
): Promise<RecoveryOutcome> {
  const config = readConfig();
  const canOfferRestart =
    config.embedProvider === "ollama" &&
    (err.kind === "runner-load-failed" || err.kind === "unreachable");

  if (!canOfferRestart) {
    await showPlainFailure(err);
    return "not-recovered";
  }

  if (config.ollamaAutoRestart === "never" || restartAttempted) {
    await showPlainFailure(err);
    return "not-recovered";
  }

  const supervisor = await detectOllamaSupervisor();
  if (!supervisor?.canRestart) {
    // We know what is wrong but must not drive this supervisor ourselves.
    const manual = supervisor
      ? `Restart Ollama yourself: ${supervisor.manualCommand}`
      : "Restart Ollama, then try again.";
    await showPlainFailure(err, manual);
    return "not-recovered";
  }

  if (config.ollamaAutoRestart === "prompt") {
    const choice = await vscode.window.showErrorMessage(
      `Doc Search: ${await describe(err)}`,
      { modal: false },
      `Restart Ollama (${supervisor.label})`,
      "Open Settings",
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("docSearch.openSettings");
      return "not-recovered";
    }
    if (!choice) return "not-recovered";
  }

  restartAttempted = true;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Doc Search", cancellable: false },
    async (progress) => {
      progress.report({ message: "Restarting Ollama…" });
      try {
        await restartOllama(supervisor);
      } catch (restartErr) {
        const msg = restartErr instanceof Error ? restartErr.message : String(restartErr);
        vscode.window.showErrorMessage(`Doc Search: could not restart Ollama — ${msg}`);
        return "not-recovered";
      }

      progress.report({ message: "Waiting for Ollama…" });
      const version = await waitForOllama(config.ollamaUrl);
      if (!version) {
        vscode.window.showErrorMessage(
          "Doc Search: Ollama did not come back after the restart. Check the Ollama server log.",
        );
        return "not-recovered";
      }

      vscode.window.showInformationMessage(
        `Doc Search: Ollama ${version} restarted — retrying the reindex.`,
      );
      return "recovered";
    },
  );
}

/** Build the user-facing sentence, enriched with a detected version skew. */
async function describe(err: EmbedderUnavailableError): Promise<string> {
  if (err.kind !== "runner-load-failed") return err.message;
  const skew = await readOllamaVersionSkew();
  if (skew?.skewed) {
    return (
      `${err.message}. The running Ollama daemon is ${skew.daemon} but the ` +
      `installed binary is ${skew.client} — it needs a restart to pick up the upgrade.`
    );
  }
  return err.message;
}

async function showPlainFailure(
  err: EmbedderUnavailableError,
  overrideHint?: string,
): Promise<void> {
  const hint = overrideHint ?? err.hint;
  const message = `Doc Search: ${await describe(err)}${hint ? ` — ${hint}` : ""}`;
  const choice = await vscode.window.showErrorMessage(message, "Open Settings");
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("docSearch.openSettings");
  }
}
