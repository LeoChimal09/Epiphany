import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Database integration tests create databases and run migrations, which can exceed 5 seconds
    // when suites run in parallel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
});
