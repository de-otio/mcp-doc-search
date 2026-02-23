import js from "@eslint/js";
import tsPlugin from "typescript-eslint";
import securityPlugin from "eslint-plugin-security";

export default [
  {
    ignores: ["node_modules", "dist", "coverage", ".claude"],
  },
  js.configs.recommended,
  ...tsPlugin.configs.recommended,
  securityPlugin.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
];
