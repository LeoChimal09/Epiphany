import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "./client";
import {
  diffMigrations,
  getMigrationStatus,
  loadMigrationFiles,
  MigrationError,
  MIGRATIONS_TABLE,
  runMigrations,
  type MigrationFile,
} from "./migrate";
import { UPGRADE_SEEDS } from "./upgrade-seeds";
import {
  createTestDatabase,
  dbTestsEnabled,
  REQUIRE_DB_TESTS,
  type TestDatabase,
} from "./test-support";

const realFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const TABLES = [
  "action_history",
  "ai_usage",
  "calendar_accounts",
  "calendar_event_refs",
  "categories",
  "confirmations",
  "discord_overviews",
  "events",
  "notes",
  "observations",
  "owners",
  "preferences",
  "provider_usage",
  "reminders",
  "sessions",
  "synced_calendars",
  "tasks",
  "work_blocks",
];

function file(tag: string, when: number, hash: string): MigrationFile {
  return { tag, when, hash, statements: ["SELECT 1"] };
}

describe("diffMigrations (no database)", () => {
  const a = file("0000_a", 1000, "ha");
  const b = file("0001_b", 2000, "hb");

  it("reports everything pending on an empty history", () => {
    expect(diffMigrations([a, b], [])).toEqual({
      applied: [],
      pending: ["0000_a", "0001_b"],
      problems: [],
    });
  });

  it("reports nothing pending when history matches", () => {
    const status = diffMigrations(
      [a, b],
      [
        { when: 1000, hash: "ha" },
        { when: 2000, hash: "hb" },
      ],
    );
    expect(status).toEqual({ applied: ["0000_a", "0001_b"], pending: [], problems: [] });
  });

  it("flags an applied migration whose file changed", () => {
    const status = diffMigrations([a], [{ when: 1000, hash: "different" }]);
    expect(status.problems.join()).toMatch(/0000_a was modified/);
    expect(status.problems.join()).toContain(
      "Database SHA-256: different; file SHA-256: ha; migration timestamp: 1000.",
    );
    expect(status.problems.join()).toContain("Do not overwrite migration-history hashes");
    expect(status.pending).toEqual(["0000_a"]);
  });

  it("flags applied history that is missing from the folder", () => {
    const status = diffMigrations(
      [a],
      [
        { when: 1000, hash: "ha" },
        { when: 9999, hash: "zz" },
      ],
    );
    expect(status.problems.join()).toMatch(/not in the migrations folder/);
  });

  it("flags a pending migration that sorts before an applied one", () => {
    const status = diffMigrations([a, b], [{ when: 2000, hash: "hb" }]);
    expect(status.pending).toEqual(["0000_a"]);
    expect(status.problems.join()).toMatch(/out of order/);
  });

  it("recognizes the verified released 0011 without replaying it or hiding later migrations", () => {
    const files = loadMigrationFiles(realFolder);
    const pendingIndex = files.findIndex((entry) => entry.tag === "0013_backfill_task_types");
    const applied = files.slice(0, pendingIndex).map((entry) => ({
      when: entry.when,
      hash:
        entry.tag === "0011_nebulous_outlaw_kid"
          ? "bae9bfd4833e56f2b357448350f7d29f036c46124a7600c51d6d581d35bf071a"
          : entry.hash,
    }));
    const status = diffMigrations(files, applied);
    expect(status.problems).toEqual([]);
    expect(status.applied).toContain("0011_nebulous_outlaw_kid");
    expect(status.pending).toEqual(files.slice(pendingIndex).map((entry) => entry.tag));
  });

  it.each([{ tag: "other_migration" }, { when: 1793049246427 }, { hash: "changed-current-file" }])(
    "rejects a legacy checksum against a different migration identity: %j",
    (change) => {
      const original = loadMigrationFiles(realFolder).find(
        (entry) => entry.tag === "0011_nebulous_outlaw_kid",
      )!;
      const changed = { ...original, ...change };
      const status = diffMigrations(
        [changed],
        [
          {
            when: changed.when,
            hash: "bae9bfd4833e56f2b357448350f7d29f036c46124a7600c51d6d581d35bf071a",
          },
        ],
      );
      expect(status.problems.join()).toMatch(/was modified/);
      expect(status.pending).toEqual([changed.tag]);
    },
  );
});

describe("loadMigrationFiles", () => {
  it("reads the real migrations with non-empty statements", () => {
    const files = loadMigrationFiles(realFolder);
    expect(files.length).toBeGreaterThan(0);
    for (const entry of files) {
      expect(entry.statements.length).toBeGreaterThan(0);
      expect(entry.statements.every((statement) => statement.length > 0)).toBe(true);
    }
    expect(
      files.find((entry) => entry.tag === "0011_nebulous_outlaw_kid")?.statements,
    ).toHaveLength(1);
    expect(files.find((entry) => entry.tag === "0011_nebulous_outlaw_kid")?.hash).toBe(
      "242300bca7673f5399a360ad8ba0682f048d3db4d39d5e14c9dc8a793a733de3",
    );
  });
});

describe.skipIf(!dbTestsEnabled)("migration runner against MySQL", () => {
  let database: TestDatabase;
  let pool: Pool;
  const tempFolders: string[] = [];

  beforeEach(async () => {
    database = await createTestDatabase();
    pool = createDatabasePool(database.url, 4);
  });

  afterEach(async () => {
    await pool.end();
    await database.drop();
    expect(await database.exists()).toBe(false);
    for (const folder of tempFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  async function tables(): Promise<string[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1",
    );
    return rows.map((row) => String(row.name));
  }

  // Copies the real migrations and appends extra migrations for upgrade/failure scenarios.
  function folderWith(extra: Array<{ tag: string; sql: string }>): string {
    const folder = fs.mkdtempSync(
      path.join(process.env.TMPDIR ?? os.tmpdir(), "epiphany-migrations-"),
    );
    tempFolders.push(folder);
    fs.cpSync(realFolder, folder, { recursive: true });
    const journalPath = path.join(folder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    let when = journal.entries.at(-1).when;
    for (const [offset, migration] of extra.entries()) {
      when += 1000;
      journal.entries.push({
        idx: journal.entries.length,
        version: "5",
        when,
        tag: migration.tag,
        breakpoints: true,
      });
      fs.writeFileSync(path.join(folder, `${migration.tag}.sql`), migration.sql);
      void offset;
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    return folder;
  }

  it("installs a clean database and applies nothing on a second run", async () => {
    const first = await runMigrations(pool, realFolder);
    expect(first.applied.length).toBe(loadMigrationFiles(realFolder).length);
    expect(await tables()).toEqual([MIGRATIONS_TABLE, ...TABLES].sort());

    const second = await runMigrations(pool, realFolder);
    expect(second.applied).toEqual([]);
    const status = await getMigrationStatus(pool, realFolder);
    expect(status.pending).toEqual([]);
    expect(status.problems).toEqual([]);

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM \`${MIGRATIONS_TABLE}\``,
    );
    expect(Number(rows[0]?.n)).toBe(first.applied.length);
  });

  it("serializes concurrent runners so each migration applies exactly once", async () => {
    const otherPool = createDatabasePool(database.url, 2);
    try {
      const [a, b] = await Promise.all([
        runMigrations(pool, realFolder),
        runMigrations(otherPool, realFolder),
      ]);
      const total = a.applied.length + b.applied.length;
      expect(total).toBe(loadMigrationFiles(realFolder).length);
      expect((await getMigrationStatus(pool, realFolder)).pending).toEqual([]);
    } finally {
      await otherPool.end();
    }
  });

  it("upgrades the original applied 0011 checksum and backfills task types only in the corrective migration", async () => {
    const all = loadMigrationFiles(realFolder);
    const installed = all.findIndex((file) => file.tag === "0011_nebulous_outlaw_kid") + 1;
    await runMigrations(pool, folderUpTo(installed));
    for (const statement of UPGRADE_SEEDS["0010_task_priority"]!) await pool.query(statement);
    const [before] = await pool.query<RowDataPacket[]>(
      "SELECT task_type FROM tasks WHERE id = 'task-done'",
    );
    expect(before[0]?.task_type).toBe("task");
    const status = await getMigrationStatus(pool, realFolder);
    expect(status.problems).toEqual([]);
    expect(status.pending).toEqual(all.slice(installed).map((entry) => entry.tag));
    await runMigrations(pool, realFolder);
    const [after] = await pool.query<RowDataPacket[]>(
      "SELECT task_type, priority, split_reminder_count FROM tasks WHERE id = 'task-done'",
    );
    expect(after[0]).toMatchObject({
      task_type: "todo",
      priority: "minor",
      split_reminder_count: null,
    });
    expect((await runMigrations(pool, realFolder)).applied).toEqual([]);
  });

  async function installReleased0011(): Promise<void> {
    const all = loadMigrationFiles(realFolder);
    const index = all.findIndex((entry) => entry.tag === "0011_nebulous_outlaw_kid");
    await runMigrations(pool, folderUpTo(index));
    for (const statement of UPGRADE_SEEDS["0010_task_priority"]!) await pool.query(statement);
    const folder = folderUpTo(index + 1);
    const original = fs.readFileSync(path.join(realFolder, "0011_nebulous_outlaw_kid.sql"), "utf8");
    const backfill = fs.readFileSync(path.join(realFolder, "0013_backfill_task_types.sql"), "utf8");
    fs.writeFileSync(
      path.join(folder, "0011_nebulous_outlaw_kid.sql"),
      `${original}\n--> statement-breakpoint\n${backfill.trimEnd()}`,
    );
    expect(loadMigrationFiles(folder).at(-1)?.hash).toBe(
      "bae9bfd4833e56f2b357448350f7d29f036c46124a7600c51d6d581d35bf071a",
    );
    await runMigrations(pool, folder);
  }

  it("upgrades the released Railway 0011 without rewriting history or changing existing tasks", async () => {
    await installReleased0011();
    const [before] = await pool.query<RowDataPacket[]>("SELECT * FROM tasks ORDER BY id");
    const [historyBefore] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM \`${MIGRATIONS_TABLE}\` ORDER BY id`,
    );
    const status = await getMigrationStatus(pool, realFolder);
    expect(status.problems).toEqual([]);
    const all = loadMigrationFiles(realFolder);
    expect(status.pending).toEqual(
      all
        .slice(all.findIndex((entry) => entry.tag === "0012_simple_patriot"))
        .map((entry) => entry.tag),
    );
    expect((await runMigrations(pool, realFolder)).applied).toEqual(status.pending);
    const [after] = await pool.query<RowDataPacket[]>("SELECT * FROM tasks ORDER BY id");
    expect(
      after.map(({ split_reminder_count, ...row }) => {
        expect(split_reminder_count).toBeNull();
        return row;
      }),
    ).toEqual(before);
    const [historyAfter] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM \`${MIGRATIONS_TABLE}\` ORDER BY id`,
    );
    expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(historyAfter).toHaveLength(historyBefore.length + status.pending.length);
    expect((await getMigrationStatus(pool, realFolder)).problems).toEqual([]);
    expect((await runMigrations(pool, realFolder)).applied).toEqual([]);
  });

  it("blocks the released legacy checksum if its schema does not match", async () => {
    await installReleased0011();
    await pool.query(
      "ALTER TABLE tasks MODIFY task_type enum('task','todo') NOT NULL DEFAULT 'todo'",
    );
    expect((await getMigrationStatus(pool, realFolder)).problems.join()).toContain(
      "tasks.task_type does not match",
    );
    await expect(runMigrations(pool, realFolder)).rejects.toThrow(/tasks.task_type does not match/);
    const [columns] = await pool.query<RowDataPacket[]>(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() " +
        "AND table_name = 'tasks' AND column_name = 'split_reminder_count'",
    );
    expect(columns).toEqual([]);
  });

  it("refuses to run when an applied migration file was modified", async () => {
    await runMigrations(pool, realFolder);
    await pool.query(
      `UPDATE \`${MIGRATIONS_TABLE}\` SET hash = 'tampered' ORDER BY created_at DESC LIMIT 1`,
    );
    await expect(runMigrations(pool, realFolder)).rejects.toThrow(
      /was modified after it was applied/,
    );
    expect((await getMigrationStatus(pool, realFolder)).problems.length).toBe(1);
  });

  // A copy of the real migrations containing only the first `count` journal entries.
  // Columns later migrations add to existing tables. Seeded rows must receive the migration's
  // defined defaults/backfills; every earlier value must be untouched.
  const ADDED_COLUMNS: Record<string, string[]> = {
    owners: ["avatar_hash"],
    tasks: ["review_note", "priority", "task_type", "split_reminder_count"],
    events: ["split_reminder_count", "series_id"],
  };

  function withoutAddedColumns(
    after: Record<string, unknown[]>,
    before: Record<string, unknown[]>,
  ): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const [table, rows] of Object.entries(after)) {
      const added = (ADDED_COLUMNS[table] ?? []).filter(
        (column) => !(before[table]?.[0] && column in (before[table][0] as object)),
      );
      out[table] = rows.map((row) => {
        const copy = { ...(row as Record<string, unknown>) };
        for (const column of added) {
          const expected =
            column === "priority"
              ? "minor"
              : column === "task_type"
                ? copy.due_at !== null || copy.estimated_minutes !== null
                  ? "task"
                  : "todo"
                : null;
          expect(copy[column], `${table}.${column} should be migrated correctly`).toBe(expected);
          delete copy[column];
        }
        return copy;
      });
    }
    return out;
  }

  function folderUpTo(count: number): string {
    const folder = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "epiphany-prefix-"));
    tempFolders.push(folder);
    fs.cpSync(realFolder, folder, { recursive: true });
    const journalPath = path.join(folder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.slice(0, count);
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    return folder;
  }

  it("upgrades from every previous real schema to the latest without losing seeded rows", async () => {
    const all = loadMigrationFiles(realFolder);
    expect(all.length).toBeGreaterThan(1);

    for (let installed = 1; installed < all.length; installed++) {
      const previous = all[installed - 1]!;
      const seed = UPGRADE_SEEDS[previous.tag];
      expect(seed, `add upgrade seed rows for ${previous.tag} in upgrade-seeds.ts`).toBeDefined();

      const db = await createTestDatabase();
      const upgradePool = createDatabasePool(db.url, 2);
      try {
        await runMigrations(upgradePool, folderUpTo(installed));
        for (const statement of seed!) await upgradePool.query(statement);

        // Snapshot every table that exists at the installed schema (ordered by its leading columns,
        // which are the id or, for ai_usage, the composite key).
        const [tableRows] = await upgradePool.query<RowDataPacket[]>(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> ? ORDER BY 1",
          [MIGRATIONS_TABLE],
        );
        const existing = tableRows.map((row) => String(row.name));
        const read = async () => {
          const out: Record<string, unknown[]> = {};
          for (const table of existing) {
            const [rows] = await upgradePool.query<RowDataPacket[]>(
              `SELECT * FROM \`${table}\` ORDER BY 1, 2`,
            );
            out[table] = rows.map((row) => JSON.parse(JSON.stringify(row)));
          }
          return out;
        };
        const before = await read();
        expect(before.tasks).toHaveLength(2);
        if (existing.includes("confirmations")) expect(before.confirmations).toHaveLength(1);

        const result = await runMigrations(upgradePool, realFolder);
        expect(result.applied).toEqual(all.slice(installed).map((file) => file.tag));
        expect(withoutAddedColumns(await read(), before)).toEqual(before);
        const [taskSplits] = await upgradePool.query<RowDataPacket[]>(
          "SELECT split_reminder_count FROM tasks",
        );
        const [eventSplits] = await upgradePool.query<RowDataPacket[]>(
          "SELECT split_reminder_count FROM events",
        );
        for (const [table, splits] of [
          ["tasks", taskSplits],
          ["events", eventSplits],
        ] as const) {
          if (!("split_reminder_count" in (before[table]?.[0] as object))) {
            expect(splits.every((row) => row.split_reminder_count === null)).toBe(true);
          }
        }
        expect((await getMigrationStatus(upgradePool, realFolder)).pending).toEqual([]);
        expect((await runMigrations(upgradePool, realFolder)).applied).toEqual([]);
      } finally {
        await upgradePool.end();
        await db.drop();
        expect(await db.exists()).toBe(false);
      }
    }
    // One fresh database per previous schema: this grows with every migration.
  }, 120_000);

  it("also upgrades with a synthetic follow-up migration that backfills data", async () => {
    await runMigrations(pool, realFolder);
    await pool.query("INSERT INTO owners (id, display_name) VALUES ('owner-fixture', 'Fixture')");
    await pool.query(
      "INSERT INTO categories (id, owner_id, name, system_key) VALUES ('cat-fixture', 'owner-fixture', 'Inbox', 'inbox')",
    );
    await pool.query(
      "INSERT INTO tasks (id, owner_id, category_id, title) VALUES ('task-fixture', 'owner-fixture', 'cat-fixture', 'Keep me')",
    );

    const upgraded = folderWith([
      {
        tag: "9000_test_backfill",
        sql: "ALTER TABLE `tasks` ADD `test_value` int;--> statement-breakpoint\nUPDATE `tasks` SET `test_value` = 3;",
      },
    ]);
    expect((await getMigrationStatus(pool, upgraded)).pending).toEqual(["9000_test_backfill"]);
    const result = await runMigrations(pool, upgraded);
    expect(result.applied).toEqual(["9000_test_backfill"]);

    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT title, test_value FROM tasks WHERE id = 'task-fixture'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Keep me", test_value: 3 });
    expect((await runMigrations(pool, upgraded)).applied).toEqual([]);
  });

  it("reports a partial failure without recording it, and recovers by fixing forward", async () => {
    await runMigrations(pool, realFolder);
    const broken = folderWith([
      {
        tag: "9000_partial",
        sql: "ALTER TABLE `tasks` ADD `scratch` int;--> statement-breakpoint\nALTER TABLE `does_not_exist` ADD `x` int;",
      },
    ]);

    const failure = await runMigrations(pool, broken).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationError);
    expect(failure).toMatchObject({ tag: "9000_partial", statementIndex: 1, statementCount: 2 });
    expect((failure as Error).message).toContain("NOT recorded");

    // DDL committed implicitly: the first statement took effect, but nothing was recorded.
    const [partial] = await pool.query<RowDataPacket[]>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tasks' AND column_name = 'scratch'",
    );
    expect(partial).toHaveLength(1);
    expect((await getMigrationStatus(pool, broken)).pending).toEqual(["9000_partial"]);

    // Documented recovery: undo the partial effect, correct the unrecorded migration, rerun.
    await pool.query("ALTER TABLE tasks DROP COLUMN scratch");
    fs.writeFileSync(
      path.join(broken, "9000_partial.sql"),
      "ALTER TABLE `tasks` ADD `scratch` int;",
    );
    expect((await runMigrations(pool, broken)).applied).toEqual(["9000_partial"]);
    expect((await getMigrationStatus(pool, broken)).pending).toEqual([]);
  });
});

describe("database test configuration", () => {
  it("has a test database when required by the environment", () => {
    if (REQUIRE_DB_TESTS) expect(dbTestsEnabled).toBe(true);
  });
});
