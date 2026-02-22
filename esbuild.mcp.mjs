import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/mcp/server.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "dist/mcp-server.js",
  external: [
    "@lancedb/lancedb",
    "@huggingface/transformers",
  ],
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
});

console.log("Built dist/mcp-server.js");
