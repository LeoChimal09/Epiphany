import { defineConfig } from "drizzle-kit";

// Run from the repository root: paths are relative to the working directory.
export default defineConfig({
  dialect: "mysql",
  schema: "./packages/core/src/db/schema.ts",
  out: "./packages/core/drizzle",
});
