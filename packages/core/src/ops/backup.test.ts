import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import {
  createTestDatabase,
  dbTestsEnabled,
  MIGRATIONS_FOLDER,
  type TestDatabase,
} from "../db/test-support";
import { createServices, issueOwnerPrincipal, type Principal } from "../services";
import {
  applyDeletionLedger,
  buildDeletionLedger,
  exportOwnerData,
  restoreOwnerData,
  verifyRestore,
} from "./backup";

describe.skipIf(!dbTestsEnabled)("backup, restore, and deletion-aware recovery", () => {
  let source: TestDatabase;
  let target: TestDatabase;
  let src: DatabaseHandle;
  let dst: DatabaseHandle;
  let ownerId: string;
  let owner: Principal;
  let services: ReturnType<typeof createServices>;

  beforeEach(async () => {
    source = await createTestDatabase();
    target = await createTestDatabase();
    src = connectDatabase(source.url);
    dst = connectDatabase(target.url);
    await runMigrations(src.pool, MIGRATIONS_FOLDER);
    await runMigrations(dst.pool, MIGRATIONS_FOLDER);
    ownerId = (
      await createOwner(src.db, { displayName: "Owner", discordUserId: "100000000000000001" })
    ).id;
    owner = await issueOwnerPrincipal(src.db, ownerId, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    services = createServices(src.db);
  });

  afterEach(async () => {
    await src.close();
    await dst.close();
    await source.drop();
    await target.drop();
    expect(await source.exists()).toBe(false);
    expect(await target.exists()).toBe(false);
  });

  async function seed() {
    await services.tasks.create(owner, {
      title: "Chem lab",
      dueAt: "2026-10-16T22:00:00.000Z",
      details: "Ünïcode ✓ and 'quotes'",
    });
    const note = await services.notes.create(owner, {
      title: "Idea",
      body: "A habit tracker",
      kind: "idea",
    });
    await services.preferences.set(owner, {
      key: "memory.abc",
      value: { text: "Homework first" },
      status: "confirmed",
    });
    await services.events.create(owner, {
      title: "Lab",
      startsAt: "2026-10-14T20:00:00.000Z",
      endsAt: "2026-10-14T21:30:00.000Z",
      timezone: "America/Chicago",
    });
    return note;
  }

  it("restores everything into a fresh database, byte for byte, and proves it", async () => {
    await seed();
    const exported = await exportOwnerData(src.pool, ownerId, new Date("2026-10-20T00:00:00.000Z"));
    expect(Object.keys(exported.tables)).toEqual(
      expect.arrayContaining([
        "owners",
        "tasks",
        "notes",
        "events",
        "preferences",
        "action_history",
      ]),
    );

    const restored = await restoreOwnerData(dst.pool, JSON.parse(JSON.stringify(exported)));
    expect(restored.rows).toBeGreaterThan(5);
    const check = await verifyRestore(dst.pool, exported);
    expect(check).toEqual({ ok: true, mismatches: [] });

    const copy = createServices(dst.db);
    const principal = await issueOwnerPrincipal(dst.db, ownerId, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    expect((await copy.tasks.list(principal))[0]?.details).toBe("Ünïcode ✓ and 'quotes'");
    expect((await copy.preferences.get(principal, "memory.abc"))?.value).toEqual({
      text: "Homework first",
    });
  });

  it("detects a restore that lost or changed data", async () => {
    await seed();
    const exported = await exportOwnerData(src.pool, ownerId);
    await restoreOwnerData(dst.pool, exported);
    await dst.pool.query("DELETE FROM notes");
    await dst.pool.query("UPDATE tasks SET title = 'Tampered'");
    const check = await verifyRestore(dst.pool, exported);
    expect(check.ok).toBe(false);
    expect(check.mismatches.join(" ")).toContain("notes");
    expect(check.mismatches.join(" ")).toContain("tasks");
  });

  it("leaves credentials and sessions out of an export", async () => {
    await seed();
    await src.pool.query(
      "INSERT INTO sessions (id, owner_id, expires_at) VALUES (REPEAT('a', 64), ?, '2026-12-01 00:00:00.000')",
      [ownerId],
    );
    const exported = await exportOwnerData(src.pool, ownerId);
    expect(exported.tables.sessions).toBeUndefined();
    expect(JSON.stringify(exported)).not.toMatch(/token|secret|ciphertext/i);
  });

  it("exports only the requested owner's records", async () => {
    await seed();
    const other = await createOwner(src.db, { displayName: "Other" });
    const theirs = await issueOwnerPrincipal(src.db, other.id, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    await services.tasks.create(theirs, { title: "Not yours" });
    expect(JSON.stringify(await exportOwnerData(src.pool, ownerId))).not.toContain("Not yours");
  });

  it("does not bring back data the owner deleted after the backup", async () => {
    const note = await seed();
    const backupTakenAt = new Date();
    const backup = await exportOwnerData(src.pool, ownerId, backupTakenAt);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // After the backup the owner has the idea deleted, through the confirmed delete path.
    const proposal = await services.confirmations.propose(owner, {
      action: "note.delete",
      payload: { noteId: note.id },
    });
    await services.confirmations.confirm(owner, {
      confirmationId: proposal.confirmationId,
      payloadHash: proposal.payloadHash,
    });
    const ledger = await buildDeletionLedger(src.pool, ownerId, backupTakenAt);
    expect(ledger.entries).toEqual([expect.objectContaining({ table: "notes", id: note.id })]);

    // Restoring the older backup resurrects it, unless the ledger is applied.
    await restoreOwnerData(dst.pool, backup);
    expect((await dst.pool.query("SELECT id FROM notes"))[0]).toHaveLength(1);
    expect(await applyDeletionLedger(dst.pool, ownerId, ledger)).toBe(1);
    expect((await dst.pool.query("SELECT id FROM notes"))[0]).toHaveLength(0);
    expect(await applyDeletionLedger(dst.pool, ownerId, ledger)).toBe(0);
  });
});
