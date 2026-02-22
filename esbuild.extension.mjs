import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: [
    "vscode",
    "@lancedb/lancedb",
    "@huggingface/transformers",
  ],
  format: "cjs",
  sourcemap: true,
});

console.log("Built dist/extension.js");
