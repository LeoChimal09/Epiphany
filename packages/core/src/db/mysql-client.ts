import { createPool as mysqlPool } from "mysql2/promise";

export function createPool(url: string, connectionLimit = 4) {
  return mysqlPool({ uri: url, connectionLimit, timezone: "Z", charset: "utf8mb4" });
}
