import esbuild from "esbuild";

// Two entries: the extension itself, and the child process that runs the
// built-in embedding model off the extension host (see src/extension/embedWorker.ts).
await esbuild.build({
  entryPoints: {
    extension: "src/extension/extension.ts",
    "embed-worker": "src/extension/embedWorker.ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  outdir: "dist",
  external: ["vscode", "@lancedb/lancedb", "@huggingface/transformers"],
  format: "cjs",
  sourcemap: true,
});

console.log("Built dist/extension.js, dist/embed-worker.js");
