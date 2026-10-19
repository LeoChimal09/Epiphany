import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import type { NextConfig } from "next";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default function config(phase: string): NextConfig {
  // One shared .env at the repository root serves the dashboard and the worker. Next has already
  // loaded apps/web/.env*, so force a reload to include the root files.
  loadEnvConfig(repoRoot, phase === PHASE_DEVELOPMENT_SERVER, undefined, true);

  return {
    poweredByHeader: false,
    transpilePackages: ["@epiphany/core"],
    turbopack: { root: repoRoot },
    // Lets a disposable preview run beside the owner's dev server without sharing its lock.
    ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  };
}
