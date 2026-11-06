import * as path from "node:path";
import { createEmbedProvider } from "../core/embedder.js";
import type { EmbedProvider } from "../core/types.js";
import { ProcessEmbedder } from "./processEmbedder.js";

/**
 * The extension's embedder factory. The built-in model runs in a child process
 * so its synchronous pooling cannot block the extension host and a native crash
 * cannot kill it (issue #117). Network providers stay in-process, and the MCP
 * server / CLI keep using the core factory directly — they are already their
 * own process.
 */
export function createExtensionEmbedProvider(
  config: Parameters<typeof createEmbedProvider>[0],
  extensionPath: string,
): EmbedProvider {
  if (config.embedProvider !== "local") return createEmbedProvider(config);
  return new ProcessEmbedder({
    workerPath: path.join(extensionPath, "dist", "embed-worker.js"),
    model: config.localModel,
    modelPath: config.modelPath,
  });
}
