const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  {
    ignores: ["**/node_modules/**", "**/out/**", "**/.vscode-test/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
];
