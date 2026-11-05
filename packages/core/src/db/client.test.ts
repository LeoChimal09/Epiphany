import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "./client";
import { createTestDatabase, type TestDatabase } from "./test-support";

describe("SQLite persistence and contention", () => {
  let fixture: TestDatabase;
  let handles: DatabaseHandle[];
  beforeEach(async () => {
    fixture = await createTestDatabase();
    handles = [connectDatabase(fixture.url), connectDatabase(fixture.url)];
    await handles[0]!.pool.client.execute(
      "CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
    );
    await handles[0]!.pool.client.execute("INSERT INTO counter VALUES (1,0)");
    await handles[0]!.pool.client.execute(
      "CREATE TABLE counter_refs (counter_id INTEGER REFERENCES counter(id))",
    );
  });
  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.close()));
    await fixture.drop();
    expect(await fixture.exists()).toBe(false);
  });

  it("serializes read-then-write decisions across clients and rolls back failed work", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        handles[index % 2]!.db.transaction(async (tx) => {
          const result = await tx.run("UPDATE counter SET value = value + 1 WHERE id = 1");
          expect(result.rowsAffected).toBe(1);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }),
      ),
    );
    await expect(
      handles[0]!.db.transaction(async (tx) => {
        await tx.run("UPDATE counter SET value = 999 WHERE id = 1");
        throw new Error("rollback fixture");
      }),
    ).rejects.toThrow("rollback fixture");
    const [rows] = await handles[1]!.pool.query<{ value: number }[]>("SELECT value FROM counter");
    expect(rows[0]!.value).toBe(20);
  });

  it("shares durable WAL writes across Bun processes without losing increments", async () => {
    const clientPath = fileURLToPath(new URL("./client.ts", import.meta.url));
    const source = `
      import {connectDatabase} from ${JSON.stringify(clientPath)};
      const handle=connectDatabase(process.env.SQLITE_FIXTURE_URL);
      try {
        for(let i=0;i<10;i++) await handle.db.transaction(async tx => {
          await tx.run("UPDATE counter SET value = value + 1 WHERE id = 1");
          await new Promise(resolve=>setTimeout(resolve,2));
        });
        let rejected=false;
        try {await handle.pool.client.execute("INSERT INTO counter_refs VALUES (999)");}
        catch(error) {if(!String(error).includes("FOREIGN KEY")) throw error;rejected=true;}
        if(!rejected) throw new Error("Foreign key protection was lost after contention.");
      } finally {await handle.close();}
    `;
    await Promise.all(
      Array.from(
        { length: 3 },
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn("bun", ["--eval", source], {
              env: { ...process.env, SQLITE_FIXTURE_URL: fixture.url },
              stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk) => {
              stderr += chunk;
            });
            child.on("error", reject);
            child.on("exit", (code) =>
              code === 0 ? resolve() : reject(new Error(`SQLite child exited ${code}: ${stderr}`)),
            );
          }),
      ),
    );
    await Promise.all(handles.map((handle) => handle.close()));
    handles = [connectDatabase(fixture.url)];
    const [rows] = await handles[0]!.pool.query<{ value: number }[]>("SELECT value FROM counter");
    expect(rows[0]!.value).toBe(30);
    expect((await stat(fileURLToPath(fixture.url))).mode & 0o777).toBe(0o600);
    const [mode] = await handles[0]!.pool.query<{ journal_mode: string }[]>("PRAGMA journal_mode");
    expect(mode[0]!.journal_mode).toBe("wal");
  });
});
