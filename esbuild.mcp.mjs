import esbuild from "esbuild";
import { readFileSync } from "node:fs";

// The MCP server reports its identity from package.json at build time (see
// src/mcp/serverInfo.ts); the values are substituted as string literals.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await esbuild.build({
  entryPoints: ["src/mcp/server.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: "dist/mcp-server.js",
  external: ["@lancedb/lancedb", "@huggingface/transformers"],
  alias: {
    "jsonc-parser": "jsonc-parser/lib/esm/main.js",
  },
  define: {
    __PKG_NAME__: JSON.stringify(pkg.name),
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
});

console.log("Built dist/mcp-server.js");
