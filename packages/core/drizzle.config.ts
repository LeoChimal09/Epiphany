import { defineConfig } from "drizzle-kit";

// Run from the repository root: paths are relative to the working directory.
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/db/sqlite-schema.ts",
  out: "./packages/core/drizzle-sqlite",
});
