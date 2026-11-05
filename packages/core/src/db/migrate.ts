import type { DatabasePool } from "./client";
import { getSqliteMigrationStatus, runSqliteMigrations } from "./sqlite-migrate";

export async function runMigrations(
  pool: DatabasePool,
  folder?: string,
  options?: { onApplied?: (tag: string) => void },
) {
  return runSqliteMigrations(pool.client, folder, options);
}

export async function getMigrationStatus(pool: DatabasePool, folder?: string) {
  return getSqliteMigrationStatus(pool.client, folder);
}
