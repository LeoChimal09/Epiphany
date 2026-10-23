import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    // Integration files share one MySQL server; unbounded workers overwhelm concurrent DDL.
    ...(process.env.TEST_MYSQL_ADMIN_URL ? { maxWorkers: 2 } : {}),
    // Database integration tests create databases and run migrations, which can exceed 5 seconds
    // when suites run in parallel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
});
