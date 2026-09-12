import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));

export default defineConfig({
  // Mirrors the esbuild.mcp.mjs define so src/mcp/serverInfo.ts reports the
  // real package version under test.
  define: {
    __PKG_NAME__: JSON.stringify(pkg.name),
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/core/types.ts"],
      thresholds: {
        lines: 80,
        branches: 68,
      },
    },
  },
  resolve: {
    alias: [
      {
        find: "vscode",
        replacement: path.resolve(__dirname, "./test/mocks/vscode.ts"),
      },
      {
        find: "@huggingface/transformers",
        replacement: path.resolve(__dirname, "./test/mocks/@huggingface/transformers.ts"),
      },
    ],
  },
});
