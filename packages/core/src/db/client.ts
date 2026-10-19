import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import * as schema from "./schema";

export type Database = MySql2Database<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}

export function createDatabasePool(databaseUrl: string, connectionLimit = 5): Pool {
  const pool = createPool({
    uri: databaseUrl,
    connectionLimit,
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  // CURRENT_TIMESTAMP(3) defaults and DATETIME values are UTC only if every session is UTC.
  pool.pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return pool;
}

export function connectDatabase(databaseUrl: string, connectionLimit?: number): DatabaseHandle {
  const pool = createDatabasePool(databaseUrl, connectionLimit);
  return {
    db: drizzle(pool, { schema, mode: "default" }),
    pool,
    close: () => pool.end(),
  };
}
