import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFreshSqliteDestination,
  convertMySqlValue,
  parseMySqlDateTime,
  validateImportUrls,
} from "./sqlite-import";
import { runSqliteMigrations } from "./sqlite-migrate";

describe("SQLite import safety and value conversion", () => {
  const clients: ReturnType<typeof createClient>[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it("accepts only explicit MySQL sources and persistent file-backed destinations", () => {
    expect(() =>
      validateImportUrls("mysql://example.invalid/db", "file:./.local/epiphany.sqlite"),
    ).not.toThrow();
    expect(() => validateImportUrls("", "file:./.local/epiphany.sqlite")).toThrow(
      /explicit MySQL connection URL/,
    );
    expect(() => validateImportUrls("mysql://example.invalid/db", "file::memory:")).toThrow(
      /file-backed SQLite URL/,
    );
    expect(() =>
      validateImportUrls("mysql://example.invalid/db", "file:./db.sqlite?mode=ro"),
    ).toThrow(/query parameters/);
  });

  it("preserves UTC millisecond dates, JSON text, and exact 64-bit integer values", () => {
    expect(parseMySqlDateTime("2026-11-05 13:40:03.132")).toBe(
      Date.UTC(2026, 10, 5, 13, 40, 3, 132),
    );
    expect(() => parseMySqlDateTime("2026-02-30 00:00:00.000")).toThrow(/valid calendar date/);
    expect(() => parseMySqlDateTime("2026-11-05 13:40:03.123456")).toThrow(/DATETIME\(3\)/);

    const json = '{"amount":1.2300, "nested":[true,null]}';
    expect(convertMySqlValue(json, "json")).toBe(json);
    expect(convertMySqlValue("9007199254740993", "bigint unsigned")).toBe(9007199254740993n);
    expect(() => convertMySqlValue("9223372036854775808", "bigint unsigned")).toThrow(
      /signed 64-bit range/,
    );
    expect(() => convertMySqlValue(Number.MAX_SAFE_INTEGER + 1, "bigint")).toThrow(
      /represented exactly/,
    );
  });

  it("refuses a populated destination while allowing a migrated empty one", async () => {
    const client = createClient({ url: "file::memory:" });
    clients.push(client);
    await runSqliteMigrations(client);
    await client.execute("PRAGMA foreign_keys = ON");

    const emptyCheck = await client.transaction("write");
    await expect(assertFreshSqliteDestination(emptyCheck)).resolves.toBeUndefined();
    await emptyCheck.rollback();

    await client.execute({
      sql: "INSERT INTO owners (id, display_name) VALUES (?, ?)",
      args: ["fixture-owner", "Synthetic fixture"],
    });
    const populatedCheck = await client.transaction("write");
    await expect(assertFreshSqliteDestination(populatedCheck)).rejects.toThrow(
      /not empty; refusing to import/,
    );
    await populatedCheck.rollback();
  });
});
