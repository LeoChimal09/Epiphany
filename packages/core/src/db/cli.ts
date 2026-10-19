import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadDatabaseToolingConfig } from "../config";
import { createDatabasePool } from "./client";
import { getMigrationStatus, runMigrations } from "./migrate";

const migrationsFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const command = process.argv[2];

async function main(): Promise<number> {
  if (command !== "migrate" && command !== "status") {
    console.error("Usage: bun packages/core/src/db/cli.ts <migrate|status>");
    return 2;
  }

  let databaseUrl: string;
  try {
    databaseUrl = loadDatabaseToolingConfig(process.env).databaseUrl;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const pool = createDatabasePool(databaseUrl, 1);
  try {
    if (command === "status") {
      const status = await getMigrationStatus(pool, migrationsFolder);
      console.log(`Applied: ${status.applied.length ? status.applied.join(", ") : "(none)"}`);
      console.log(`Pending: ${status.pending.length ? status.pending.join(", ") : "(none)"}`);
      for (const problem of status.problems) console.log(`PROBLEM: ${problem}`);
      return status.problems.length > 0 ? 1 : 0;
    }

    const { applied } = await runMigrations(pool, migrationsFolder, {
      onApplied: (tag) => console.log(`Applied ${tag}`),
    });
    console.log(
      applied.length ? `Applied ${applied.length} migration(s).` : "No pending migrations.",
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Migration failed.");
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
