import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
