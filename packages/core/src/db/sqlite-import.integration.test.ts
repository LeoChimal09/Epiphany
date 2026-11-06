import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { createConnection, createPool, type RowDataPacket } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { importMySqlToSqlite } from "./sqlite-import";
import { runMigrations } from "./mysql-migrate";
import {
  createTestDatabase,
  dbTestsEnabled,
  MIGRATIONS_FOLDER,
  type TestDatabase,
} from "./mysql-test-support";
import { runSqliteMigrations } from "./sqlite-migrate";

const TABLE_NAMES = [
  "owners",
  "categories",
  "tasks",
  "events",
  "work_blocks",
  "notes",
  "preferences",
  "action_history",
  "confirmations",
  "sessions",
  "ai_usage",
  "reminders",
  "discord_overviews",
  "calendar_accounts",
  "synced_calendars",
  "calendar_event_refs",
  "provider_usage",
  "observations",
] as const;
const SQLITE_TEST_FOLDER = path.resolve(
  fileURLToPath(new URL("../../drizzle-sqlite", import.meta.url)),
);
const fixtureJson = '{"labels":["synthetic","import"],"amount":12.5,"enabled":true}';
const fixtureDate = "2026-03-08 08:15:12.345";

interface CountRow extends RowDataPacket {
  count: number;
}

interface FixtureRow extends RowDataPacket {
  created_at: Date;
  due_at: Date;
  status: string;
}

interface JsonRow extends RowDataPacket {
  value: string;
}

interface TokenRow extends RowDataPacket {
  access_token_enc: string;
  refresh_token_enc: string;
}

describe.skipIf(!dbTestsEnabled)("MySQL to SQLite import (disposable MySQL only)", () => {
  let database: TestDatabase | undefined;
  let mysqlPool: ReturnType<typeof createPool> | undefined;
  const sqliteFiles: string[] = [];

  afterEach(async () => {
    await mysqlPool?.end();
    mysqlPool = undefined;
    if (database) {
      await database.drop();
      expect(await database.exists()).toBe(false);
      database = undefined;
    }
    for (const file of sqliteFiles.splice(0)) {
      if (!file.startsWith(`${SQLITE_TEST_FOLDER}${path.sep}`)) {
        throw new Error("Refusing to remove a SQLite test file outside the fixture directory.");
      }
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  async function seedMySqlFixture(pool: ReturnType<typeof createPool>) {
    await pool.query(
      "INSERT INTO owners (id, display_name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["00000000-0000-4000-8000-000000000001", "Synthetic owner", "UTC", fixtureDate, fixtureDate],
    );
    await pool.query(
      "INSERT INTO categories (id, owner_id, name, system_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
        "Synthetic inbox",
        "inbox",
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO tasks (id, owner_id, category_id, task_type, title, priority, details, source_text, source_ref, review_note, due_at, due_date_only, split_reminder_count, estimated_minutes, remaining_minutes, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "todo",
        "Synthetic task",
        "major",
        "Fixture details",
        "Fixture source",
        "fixture:task",
        "Fixture review",
        fixtureDate,
        0,
        2,
        45,
        20,
        "open",
        3,
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO events (id, owner_id, title, starts_at, ends_at, all_day, timezone, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000004",
        "00000000-0000-4000-8000-000000000001",
        "Synthetic event",
        fixtureDate,
        "2026-03-08 09:15:12.345",
        1,
        "UTC",
        "scheduled",
        2,
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO work_blocks (id, owner_id, task_id, starts_at, ends_at, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000005",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000003",
        fixtureDate,
        "2026-03-08 09:00:12.345",
        "planned",
        1,
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO notes (id, owner_id, category_id, kind, title, body, source_ref, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000006",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "note",
        "Synthetic note",
        "Fixture body",
        "fixture:note",
        1,
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO preferences (id, owner_id, pref_key, value, status, source, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000007",
        "00000000-0000-4000-8000-000000000001",
        "fixture",
        fixtureJson,
        "confirmed",
        "system",
        1,
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO action_history (id, owner_id, source, action, entity_type, entity_id, `before`, `after`, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000008",
        "00000000-0000-4000-8000-000000000001",
        "system",
        "fixture_import",
        "task",
        "00000000-0000-4000-8000-000000000003",
        fixtureJson,
        fixtureJson,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000009",
        "00000000-0000-4000-8000-000000000001",
        "fixture_confirmation",
        "pending",
        JSON.stringify([
          { entityType: "task", entityId: "00000000-0000-4000-8000-000000000003", version: 3 },
        ]),
        fixtureJson,
        "a".repeat(64),
        fixtureJson,
        "system",
        "2026-03-08 10:15:12.345",
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO sessions (id, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [
        "b".repeat(64),
        "00000000-0000-4000-8000-000000000001",
        "2026-04-08 08:15:12.345",
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO ai_usage (owner_id, period, cost_micros, calls, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["00000000-0000-4000-8000-000000000001", "2026-03", 123456, 7, fixtureDate],
    );
    await pool.query(
      "INSERT INTO reminders (id, owner_id, kind, subject_type, subject_id, dedupe_key, message, urgency, due_at, status, attempts, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000001",
        "task_deadline",
        "task",
        "00000000-0000-4000-8000-000000000003",
        "fixture:reminder",
        "Synthetic reminder",
        "normal",
        fixtureDate,
        "scheduled",
        0,
        1,
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO discord_overviews (owner_id, guild_id, view_key, channel_id, message_id, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000001",
        "guild-fixture",
        "today",
        "channel-fixture",
        "message-fixture",
        "c".repeat(64),
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO calendar_accounts (id, owner_id, provider, provider_account_id, status, scopes, access_token_enc, refresh_token_enc, connected_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000001",
        "google",
        "fixture-account",
        "connected",
        "calendar.readonly",
        "synthetic-encrypted-access-token",
        "synthetic-encrypted-refresh-token",
        fixtureDate,
        1,
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO synced_calendars (id, owner_id, account_id, external_id, kind, summary, is_primary, selected, sync_status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000012",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000011",
        "fixture-calendar",
        "external",
        "Synthetic calendar",
        0,
        1,
        "ok",
        1,
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO calendar_event_refs (id, owner_id, account_id, calendar_id, external_id, ownership, event_id, sync_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000013",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
        "fixture-event",
        "external",
        "00000000-0000-4000-8000-000000000004",
        "synced",
        fixtureDate,
        fixtureDate,
      ],
    );
    await pool.query(
      "INSERT INTO provider_usage (owner_id, provider, period, cost_micros, calls, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["00000000-0000-4000-8000-000000000001", "voice", "2026-03", 1234, 2, fixtureDate],
    );
    await pool.query(
      "INSERT INTO observations (id, owner_id, kind, subject_key, value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000014",
        "00000000-0000-4000-8000-000000000001",
        "duration",
        "fixture:task",
        25,
        fixtureDate,
      ],
    );
  }

  async function createSqliteDestination() {
    const file = path.join(
      SQLITE_TEST_FOLDER,
      `.sqlite-import-test-${randomBytes(8).toString("hex")}.sqlite`,
    );
    if (fs.existsSync(file)) throw new Error("Generated SQLite test filename already exists.");
    sqliteFiles.push(file);
    const client = createClient({ url: pathToFileURL(file).href, concurrency: 1 });
    await runSqliteMigrations(client);
    await client.close();
    return { file, url: pathToFileURL(file).href };
  }

  async function counts(pool: ReturnType<typeof createPool>) {
    const result: Record<string, number> = {};
    for (const table of TABLE_NAMES) {
      const [rows] = await pool.query<CountRow[]>(`SELECT COUNT(*) AS count FROM \`${table}\``);
      result[table] = Number(rows[0]?.count);
    }
    return result;
  }

  it("imports one consistent current-schema snapshot and rolls back unsafe attempts", async () => {
    database = await createTestDatabase();
    mysqlPool = createPool({ uri: database.url, timezone: "Z", connectionLimit: 2 });
    await runMigrations(mysqlPool, MIGRATIONS_FOLDER);
    await seedMySqlFixture(mysqlPool);
    const beforeCounts = await counts(mysqlPool);
    const [beforeValues] = await mysqlPool.query<FixtureRow[]>(
      "SELECT created_at, due_at, status FROM tasks WHERE id = ?",
      ["00000000-0000-4000-8000-000000000003"],
    );
    const [beforeJson] = await mysqlPool.query<JsonRow[]>(
      "SELECT CAST(value AS CHAR) AS value FROM preferences WHERE pref_key = ?",
      ["fixture"],
    );
    const [beforeTokens] = await mysqlPool.query<TokenRow[]>(
      "SELECT access_token_enc, refresh_token_enc FROM calendar_accounts",
    );

    const successfulDestination = await createSqliteDestination();
    const imported = await importMySqlToSqlite({
      sourceUrl: database.url,
      destinationUrl: successfulDestination.url,
    });
    expect(imported.totalRows).toBe(TABLE_NAMES.length);
    expect(imported.rowCounts).toEqual(Object.fromEntries(TABLE_NAMES.map((table) => [table, 1])));

    const destination = createClient({ url: successfulDestination.url, concurrency: 1 });
    try {
      const task = await destination.execute(
        "SELECT created_at, due_at, status FROM tasks WHERE id = ?",
        ["00000000-0000-4000-8000-000000000003"],
      );
      expect(Number(task.rows[0]?.created_at)).toBe(Date.UTC(2026, 2, 8, 8, 15, 12, 345));
      expect(Number(task.rows[0]?.due_at)).toBe(Date.UTC(2026, 2, 8, 8, 15, 12, 345));
      const preference = await destination.execute(
        "SELECT value FROM preferences WHERE pref_key = ?",
        ["fixture"],
      );
      expect(preference.rows[0]?.value).toBe(beforeJson[0]?.value);
      const tokens = await destination.execute(
        "SELECT access_token_enc, refresh_token_enc FROM calendar_accounts",
      );
      expect(tokens.rows[0]?.access_token_enc).toBe(beforeTokens[0]?.access_token_enc);
      expect(tokens.rows[0]?.refresh_token_enc).toBe(beforeTokens[0]?.refresh_token_enc);
      expect((await destination.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    } finally {
      await destination.close();
    }

    expect(await counts(mysqlPool)).toEqual(beforeCounts);
    const [afterValues] = await mysqlPool.query<FixtureRow[]>(
      "SELECT created_at, due_at, status FROM tasks WHERE id = ?",
      ["00000000-0000-4000-8000-000000000003"],
    );
    const [afterJson] = await mysqlPool.query<JsonRow[]>(
      "SELECT CAST(value AS CHAR) AS value FROM preferences WHERE pref_key = ?",
      ["fixture"],
    );
    const [afterTokens] = await mysqlPool.query<TokenRow[]>(
      "SELECT access_token_enc, refresh_token_enc FROM calendar_accounts",
    );
    expect(afterValues).toEqual(beforeValues);
    expect(afterJson).toEqual(beforeJson);
    expect(afterTokens).toEqual(beforeTokens);

    const populatedDestination = await createSqliteDestination();
    const populated = createClient({ url: populatedDestination.url, concurrency: 1 });
    try {
      await populated.execute({
        sql: "INSERT INTO owners (id, display_name) VALUES (?, ?)",
        args: ["fixture-existing-owner", "Existing synthetic row"],
      });
    } finally {
      await populated.close();
    }
    await expect(
      importMySqlToSqlite({
        sourceUrl: database.url,
        destinationUrl: populatedDestination.url,
      }),
    ).rejects.toThrow(/not empty; refusing to import/);
    const checkPopulated = createClient({ url: populatedDestination.url, concurrency: 1 });
    try {
      expect(
        Number(
          (await checkPopulated.execute("SELECT COUNT(*) AS count FROM owners")).rows[0]?.count,
        ),
      ).toBe(1);
      expect(
        Number(
          (await checkPopulated.execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count,
        ),
      ).toBe(0);
    } finally {
      await checkPopulated.close();
    }

    const rollbackDestination = await createSqliteDestination();
    const sourceConnection = await createConnection({ uri: database.url });
    try {
      await sourceConnection.query("SET SESSION sql_mode = ''");
      await sourceConnection.query("UPDATE tasks SET status = '' WHERE id = ?", [
        "00000000-0000-4000-8000-000000000003",
      ]);
    } finally {
      await sourceConnection.end();
    }
    await expect(
      importMySqlToSqlite({
        sourceUrl: database.url,
        destinationUrl: rollbackDestination.url,
      }),
    ).rejects.toThrow();
    const rolledBack = createClient({ url: rollbackDestination.url, concurrency: 1 });
    try {
      for (const table of TABLE_NAMES) {
        expect(
          Number(
            (await rolledBack.execute(`SELECT COUNT(*) AS count FROM "${table}"`)).rows[0]?.count,
          ),
        ).toBe(0);
      }
    } finally {
      await rolledBack.close();
    }

    await mysqlPool.query("ALTER TABLE notes MODIFY body VARCHAR(2048) NOT NULL");
    const schemaDriftDestination = await createSqliteDestination();
    await expect(
      importMySqlToSqlite({
        sourceUrl: database.url,
        destinationUrl: schemaDriftDestination.url,
      }),
    ).rejects.toThrow(/column types do not match/);
  }, 120_000);
});
