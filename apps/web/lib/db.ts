import { connectDatabase, type Database, type DatabaseHandle } from "@epiphany/core/db";
import { loadWebConfig } from "@epiphany/core";

// One connection pool per server process, kept across dev hot reloads.
const globalForDb = globalThis as unknown as { __epiphanyDb?: DatabaseHandle };

export function getDb(): Database {
  globalForDb.__epiphanyDb ??= connectDatabase(loadWebConfig(process.env).databaseUrl, 5);
  return globalForDb.__epiphanyDb.db;
}
