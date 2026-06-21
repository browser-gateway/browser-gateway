/**
 * ESLint config for browser-gateway.
 *
 * Scope: we use ESLint specifically as a duplicate-logic detector that runs
 * inline in the editor. jscpd handles token-level duplication; ESLint
 * (via sonarjs/no-identical-functions) handles function-level duplication.
 *
 * We deliberately do NOT use the full sonarjs.configs.recommended ruleset —
 * it includes 50+ rules covering style, security-paranoia, and complexity that
 * produce many false positives on test code and brownfield infra. The rules
 * below are the curated set that catches real bugs.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "web/**",
      "node_modules/**",
      "jscpd-report/**",
      "reports/**",
      ".stryker-tmp/**",
      "coverage/**",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { sonarjs },
    rules: {
      // ── The actual job: catch duplicate logic ──
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-duplicated-branches": "error",
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-identical-expressions": "error",

      // ── Real bugs ──
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],

      // ── Noise/style/paranoia we explicitly disable ──
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      // Tests can repeat themselves freely
      "sonarjs/no-identical-functions": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
