import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["bin/mcp-doc-search.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "dist/mcp-doc-search.js",
  external: ["@lancedb/lancedb", "@huggingface/transformers"],
  alias: {
    "jsonc-parser": "jsonc-parser/lib/esm/main.js",
  },
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
});

console.log("Built dist/mcp-doc-search.js");
