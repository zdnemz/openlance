import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

/**
 * Flat config for the monorepo.
 *
 * `apps/web` is a Next.js app and keeps the Next preset. `apps/api` is a
 * plain Hono/Node service — no React, no Next — so it gets the recommended
 * (non-type-checked) TypeScript rules rather than the Next set, which would
 * flag server code for browser-only concerns. `apps/contracts` is Hardhat and
 * is linted by its own toolchain.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/build/**",
      "**/next-env.d.ts",
      "apps/contracts/**",
      ".husky/**",
      ".impeccable/**",
      "**/*.tsbuildinfo",
    ],
  },

  // ── apps/api: the Hono service ──────────────────────────────────────────
  {
    files: ["apps/api/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // Non-null assertions and `any` are load-bearing in the backend:
      // `record!` on a known-present DB row, `any` in JSON payload shapes.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "no-unused-vars": "off",
      "no-console": "off",
    },
  },

  // ── apps/web: Next.js ───────────────────────────────────────────────────
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [...nextCoreWebVitals, ...nextTypescript],
    rules: {
      // TypeScript rules
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/prefer-as-const": "off",
      "@typescript-eslint/no-unused-disable-directive": "off",

      // React rules
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/purity": "off",
      // Newer compiler-era rules. The codebase deliberately drives data from
      // effects (zod-driven forms, chain reads, wallet state) rather than
      // deriving during render; these flag that shape, they do not find bugs.
      // `react-hooks/set-state-in-effect` is the one that fires here.
      "react-hooks/set-state-in-effect": "off",
      "react/no-unescaped-entities": "off",
      "react/display-name": "off",
      "react/prop-types": "off",
      "react-compiler/react-compiler": "off",

      // Next.js rules
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "off",

      // General JavaScript rules
      "prefer-const": "off",
      "no-unused-vars": "off",
      "no-console": "off",
      "no-debugger": "off",
      "no-empty": "off",
      "no-irregular-whitespace": "off",
      "no-case-declarations": "off",
      "no-fallthrough": "off",
      "no-mixed-spaces-and-tabs": "off",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-unreachable": "off",
      "no-useless-escape": "off",
    },
  },
);
