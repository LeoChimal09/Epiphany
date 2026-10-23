import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  js.configs.recommended,
  ...nextVitals,
  ...nextTypescript,
  {
    settings: { next: { rootDir: "apps/web" } },
  },
  globalIgnores([
    ".next/**",
    "apps/web/.next/**",
    "**/.next-*/**",
    "**/build-ci/**",
    "next-env.d.ts",
    "**/next-env.d.ts",
    "node_modules/**",
    "coverage/**",
  ]),
]);
