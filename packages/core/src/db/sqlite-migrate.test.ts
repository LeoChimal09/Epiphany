import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectDatabase } from "./client";
import { createTestDatabase } from "./test-support";
import { owners } from "./sqlite-schema";
import {
  diffSqliteMigrations,
  getSqliteMigrationStatus,
  loadSqliteMigrationFiles,
  runSqliteMigrations,
  type SqliteMigrationFile,
} from "./sqlite-migrate";

describe("SQLite migrations", () => {
  const clients: ReturnType<typeof createClient>[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  function memoryClient() {
    const client = createClient({ url: "file::memory:" });
    clients.push(client);
    return client;
  }

  it("upgrades the preceding schema without changing existing tasks, notes, or preferences", async () => {
    const folder = fs.mkdtempSync(path.join(tmpdir(), "epiphany-upgrade-"));
    const source = fileURLToPath(new URL("../../drizzle-sqlite", import.meta.url));
    const client = memoryClient();
    try {
      const journal = JSON.parse(
        fs.readFileSync(path.join(source, "meta", "_journal.json"), "utf8"),
      );
      journal.entries = journal.entries.filter(
        (entry: { tag: string }) => entry.tag !== "0002_fair_sleepwalker",
      );
      fs.mkdirSync(path.join(folder, "meta"));
      fs.writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify(journal));
      for (const entry of journal.entries)
        fs.copyFileSync(
          path.join(source, `${entry.tag}.sql`),
          path.join(folder, `${entry.tag}.sql`),
        );
      await runSqliteMigrations(client, folder);
      await client.execute("INSERT INTO owners (id, display_name) VALUES ('owner', 'Fixture')");
      await client.execute(
        "INSERT INTO categories (id, owner_id, name) VALUES ('inbox', 'owner', 'Inbox')",
      );
      await client.execute(
        "INSERT INTO tasks (id, owner_id, category_id, title, task_type) VALUES ('task', 'owner', 'inbox', 'Keep task', 'todo')",
      );
      await client.execute(
        "INSERT INTO notes (id, owner_id, category_id, body, kind) VALUES ('note', 'owner', 'inbox', 'Keep full note', 'note')",
      );
      await client.execute(
        "INSERT INTO preferences (id, owner_id, pref_key, value) VALUES ('preference', 'owner', 'fixture', 'true')",
      );
      const tables = ["tasks", "notes", "preferences"];
      const before = await Promise.all(
        tables.map(async (table) => (await client.execute(`SELECT * FROM ${table}`)).rows),
      );
      expect(await runSqliteMigrations(client)).toEqual({ applied: ["0002_fair_sleepwalker"] });
      expect(
        await Promise.all(
          tables.map(async (table) => (await client.execute(`SELECT * FROM ${table}`)).rows),
        ),
      ).toEqual(before);
      expect((await client.execute("SELECT * FROM chat_sessions")).rows).toEqual([]);
      expect(await runSqliteMigrations(client)).toEqual({ applied: [] });
      expect((await getSqliteMigrationStatus(client)).pending).toEqual([]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("installs the generated schema once and reports a clean, idempotent status", async () => {
    const client = memoryClient();
    const files = loadSqliteMigrationFiles();
    const first = await runSqliteMigrations(client);
    expect(first.applied).toEqual(files.map((file) => file.tag));
    expect(await runSqliteMigrations(client)).toEqual({ applied: [] });
    expect(await getSqliteMigrationStatus(client)).toEqual({
      applied: files.map((file) => file.tag),
      pending: [],
      problems: [],
    });

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({
      sql: "INSERT INTO owners (id, display_name) VALUES (?, ?)",
      args: ["owner-1", "Fixture owner"],
    });
    await client.execute({
      sql: "INSERT INTO categories (id, owner_id, name) VALUES (?, ?, ?)",
      args: ["category-1", "owner-1", "Inbox"],
    });
    await expect(
      client.execute({
        sql: "INSERT INTO categories (id, owner_id, name) VALUES (?, ?, ?)",
        args: ["category-2", "owner-1", "inbox"],
      }),
    ).rejects.toThrow();
    await expect(
      client.execute({
        sql: "INSERT INTO tasks (id, owner_id, category_id, title, task_type) VALUES (?, ?, ?, ?, ?)",
        args: ["task-1", "owner-1", "category-1", "Fixture task", "invalid"],
      }),
    ).rejects.toThrow();

    const columns = await client.execute("PRAGMA table_info('tasks')");
    expect(columns.rows.find((row) => row.name === "due_at")?.type).toBe("INTEGER");
    const timestamp = await client.execute("SELECT created_at FROM owners WHERE id = 'owner-1'");
    expect(Number(timestamp.rows[0]?.created_at)).toBeGreaterThan(1_000_000_000_000);
    const db = drizzle(client, { schema: { owners } });
    const [owner] = await db
      .select({ createdAt: owners.createdAt })
      .from(owners)
      .where(eq(owners.id, "owner-1"));
    expect(owner?.createdAt).toBeInstanceOf(Date);
    expect(owner?.createdAt.getTime()).toBe(Number(timestamp.rows[0]?.created_at));
  });

  it("detects changed files, missing history files, and out-of-order migrations", () => {
    const files: SqliteMigrationFile[] = [
      { tag: "0000_first", hash: "first", when: 100, statements: ["SELECT 1"] },
      { tag: "0001_second", hash: "second", when: 200, statements: ["SELECT 1"] },
    ];

    expect(diffSqliteMigrations(files, [{ hash: "changed", when: 100 }]).problems.join()).toMatch(
      /0000_first was modified/,
    );
    expect(diffSqliteMigrations(files, [{ hash: "gone", when: 300 }]).problems.join()).toMatch(
      /not in the migrations folder/,
    );
    expect(diffSqliteMigrations(files, [{ hash: "second", when: 200 }]).problems.join()).toMatch(
      /sorts before an already-applied migration/,
    );
  });

  it("rolls back failed DDL and history together, then safely retries corrected unapplied SQL", async () => {
    const folder = fs.mkdtempSync(path.join(tmpdir(), "epiphany-migration-"));
    const client = memoryClient();
    fs.mkdirSync(path.join(folder, "meta"));
    fs.writeFileSync(
      path.join(folder, "meta", "_journal.json"),
      JSON.stringify({
        entries: [{ tag: "0000_fixture", when: 100 }],
      }),
    );
    const migration = path.join(folder, "0000_fixture.sql");
    const applied: string[] = [];
    try {
      fs.writeFileSync(
        migration,
        "CREATE TABLE fixture (id INTEGER PRIMARY KEY);--> statement-breakpoint\nINSERT INTO missing_table VALUES(1);",
      );
      await expect(
        runSqliteMigrations(client, folder, { onApplied: (tag) => applied.push(tag) }),
      ).rejects.toThrow(/statement 2 of 2/);
      expect(applied).toEqual([]);
      expect(
        (await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows,
      ).toEqual([]);
      fs.writeFileSync(
        migration,
        "CREATE TABLE fixture (id INTEGER PRIMARY KEY);--> statement-breakpoint\nINSERT INTO fixture VALUES(1);",
      );
      await expect(runSqliteMigrations(client, folder)).resolves.toEqual({
        applied: ["0000_fixture"],
      });
      expect(await runSqliteMigrations(client, folder)).toEqual({ applied: [] });
      expect((await client.execute("SELECT id FROM fixture")).rows[0]?.id).toBe(1);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("serializes competing application migration runners against one persistent file", async () => {
    const fixture = await createTestDatabase();
    const handles = [connectDatabase(fixture.url), connectDatabase(fixture.url)];
    try {
      const results = await Promise.all(
        handles.map((handle) => runSqliteMigrations(handle.pool.client)),
      );
      const expected = loadSqliteMigrationFiles().map((file) => file.tag);
      expect(results.flatMap((result) => result.applied).sort()).toEqual(expected.sort());
      expect(await getSqliteMigrationStatus(handles[0]!.pool.client)).toMatchObject({
        pending: [],
        problems: [],
      });
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      await fixture.drop();
      expect(await fixture.exists()).toBe(false);
    }
  });
});
