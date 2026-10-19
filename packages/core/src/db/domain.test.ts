import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { RowDataPacket } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "./client";
import {
  cancelEvent,
  completeTask,
  createCategory,
  createEvent,
  createNote,
  createOwner,
  createTask,
  createWorkBlock,
  ensureInbox,
  getEvent,
  getTask,
  getWorkBlock,
  NotFoundError,
  removeWorkBlock,
  type Actor,
} from "./domain";
import { runMigrations } from "./migrate";
import { actionHistory, categories, notes } from "./schema";
import { createTestDatabase, dbTestsEnabled, type TestDatabase } from "./test-support";

const migrationsFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const at = (iso: string) => new Date(iso);

describe.skipIf(!dbTestsEnabled)("domain records against MySQL", () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let actor: Actor;

  beforeEach(async () => {
    database = await createTestDatabase();
    handle = connectDatabase(database.url);
    await runMigrations(handle.pool, migrationsFolder);
    const owner = await createOwner(handle.db, { displayName: "Fixture Owner" });
    actor = { ownerId: owner.id, source: "dashboard" };
  });

  afterEach(async () => {
    await handle.close();
    await database.drop();
    expect(await database.exists()).toBe(false);
  });

  const history = (entityId: string) =>
    handle.db.select().from(actionHistory).where(eq(actionHistory.entityId, entityId));

  it("keeps fixture records across a restart and round-trips UTC times exactly", async () => {
    const due = at("2026-10-16T04:59:59.123Z");
    const task = await createTask(handle.db, actor, {
      title: "Essay",
      dueAt: due,
      estimatedMinutes: 90,
    });
    const event = await createEvent(handle.db, actor, {
      title: "Chemistry lab",
      startsAt: at("2026-10-14T20:00:00.000Z"),
      endsAt: at("2026-10-14T21:30:00.000Z"),
      timezone: "America/Chicago",
    });
    const block = await createWorkBlock(handle.db, actor, {
      taskId: task.id,
      startsAt: at("2026-10-15T15:00:00.000Z"),
      endsAt: at("2026-10-15T16:00:00.000Z"),
    });
    const note = await createNote(handle.db, actor, { body: "App idea", kind: "idea" });

    await handle.close();
    handle = connectDatabase(database.url);

    const reloaded = await getTask(handle.db, actor.ownerId, task.id);
    expect(reloaded.dueAt?.toISOString()).toBe("2026-10-16T04:59:59.123Z");
    expect(reloaded.title).toBe("Essay");
    expect((await getEvent(handle.db, actor.ownerId, event.id)).startsAt.toISOString()).toBe(
      "2026-10-14T20:00:00.000Z",
    );
    expect((await getWorkBlock(handle.db, actor.ownerId, block.id)).taskId).toBe(task.id);
    const [savedNote] = await handle.db.select().from(notes).where(eq(notes.id, note.id));
    expect(savedNote?.body).toBe("App idea");

    const [raw] = await handle.pool.query<RowDataPacket[]>(
      "SELECT DATE_FORMAT(due_at, '%Y-%m-%d %H:%i:%s.%f') AS due FROM tasks WHERE id = ?",
      [task.id],
    );
    expect(raw[0]?.due).toBe("2026-10-16 04:59:59.123000");
  });

  it("places uncategorized tasks and notes in a single Inbox, even under concurrency", async () => {
    const task = await createTask(handle.db, actor, { title: "Loose task" });
    const note = await createNote(handle.db, actor, { body: "Loose note" });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensureInbox(handle.db, actor.ownerId)),
    );

    const inboxes = await handle.db
      .select()
      .from(categories)
      .where(and(eq(categories.ownerId, actor.ownerId), eq(categories.systemKey, "inbox")));
    expect(inboxes).toHaveLength(1);
    expect(new Set(results.map((row) => row.id))).toEqual(new Set([inboxes[0]?.id]));
    expect(task.categoryId).toBe(inboxes[0]?.id);
    expect(note.categoryId).toBe(inboxes[0]?.id);

    const school = await createCategory(handle.db, actor, "School");
    expect(
      (await createTask(handle.db, actor, { title: "Sorted", categoryId: school.id })).categoryId,
    ).toBe(school.id);
  });

  it("completes a task without touching its work blocks, deadline, or events", async () => {
    const due = at("2026-10-20T05:00:00.000Z");
    const task = await createTask(handle.db, actor, {
      title: "Worksheet",
      dueAt: due,
      estimatedMinutes: 60,
    });
    const block = await createWorkBlock(handle.db, actor, {
      taskId: task.id,
      startsAt: at("2026-10-18T15:00:00.000Z"),
      endsAt: at("2026-10-18T16:00:00.000Z"),
    });
    const event = await createEvent(handle.db, actor, {
      title: "Class",
      startsAt: at("2026-10-19T14:00:00.000Z"),
      endsAt: at("2026-10-19T15:00:00.000Z"),
      timezone: "America/Chicago",
    });

    const { task: done, changed } = await completeTask(handle.db, actor, task.id);
    expect(changed).toBe(true);
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(done.dueAt?.toISOString()).toBe(due.toISOString());
    expect(done.version).toBe(task.version + 1);

    expect((await getWorkBlock(handle.db, actor.ownerId, block.id)).status).toBe("planned");
    expect((await getEvent(handle.db, actor.ownerId, event.id)).status).toBe("scheduled");
    expect((await history(task.id)).map((row) => row.action).sort()).toEqual([
      "task.complete",
      "task.create",
    ]);
  });

  it("cancels an event without completing tasks or removing work blocks", async () => {
    const task = await createTask(handle.db, actor, { title: "Reading" });
    const block = await createWorkBlock(handle.db, actor, {
      taskId: task.id,
      startsAt: at("2026-10-18T15:00:00.000Z"),
      endsAt: at("2026-10-18T16:00:00.000Z"),
    });
    const event = await createEvent(handle.db, actor, {
      title: "Gym",
      startsAt: at("2026-10-19T22:00:00.000Z"),
      endsAt: at("2026-10-19T23:00:00.000Z"),
      timezone: "America/Chicago",
    });

    const { event: canceled, changed } = await cancelEvent(handle.db, actor, event.id);
    expect(changed).toBe(true);
    expect(canceled.status).toBe("canceled");
    expect(canceled.canceledAt).toBeInstanceOf(Date);
    expect((await getTask(handle.db, actor.ownerId, task.id)).status).toBe("open");
    expect((await getWorkBlock(handle.db, actor.ownerId, block.id)).status).toBe("planned");
    expect((await history(event.id)).map((row) => row.action).sort()).toEqual([
      "event.cancel",
      "event.create",
    ]);
  });

  it("removes a work block without completing its task, canceling events, or deleting the row", async () => {
    const task = await createTask(handle.db, actor, {
      title: "Lab report",
      dueAt: at("2026-10-22T05:00:00.000Z"),
    });
    const keep = await createWorkBlock(handle.db, actor, {
      taskId: task.id,
      startsAt: at("2026-10-20T15:00:00.000Z"),
      endsAt: at("2026-10-20T16:00:00.000Z"),
    });
    const drop = await createWorkBlock(handle.db, actor, {
      taskId: task.id,
      startsAt: at("2026-10-21T15:00:00.000Z"),
      endsAt: at("2026-10-21T16:00:00.000Z"),
    });

    const { workBlock, changed } = await removeWorkBlock(handle.db, actor, drop.id, "replanned");
    expect(changed).toBe(true);
    expect(workBlock).toMatchObject({ id: drop.id, status: "removed", removedReason: "replanned" });
    expect(workBlock.removedAt).toBeInstanceOf(Date);
    expect((await getWorkBlock(handle.db, actor.ownerId, keep.id)).status).toBe("planned");
    const taskAfter = await getTask(handle.db, actor.ownerId, task.id);
    expect(taskAfter.status).toBe("open");
    expect(taskAfter.dueAt?.toISOString()).toBe("2026-10-22T05:00:00.000Z");
  });

  it("is idempotent: repeating an operation changes nothing and logs nothing new", async () => {
    const task = await createTask(handle.db, actor, { title: "Once" });
    await completeTask(handle.db, actor, task.id);
    const second = await completeTask(handle.db, actor, task.id);
    expect(second.changed).toBe(false);
    expect(second.task.version).toBe(task.version + 1);
    expect((await history(task.id)).filter((row) => row.action === "task.complete")).toHaveLength(
      1,
    );
  });

  it("scopes every operation to its owner", async () => {
    const other = await createOwner(handle.db, { displayName: "Someone Else" });
    const stranger: Actor = { ownerId: other.id, source: "discord" };
    const task = await createTask(handle.db, actor, { title: "Private" });

    await expect(completeTask(handle.db, stranger, task.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getTask(handle.db, stranger.ownerId, task.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      createTask(handle.db, stranger, {
        title: "x",
        categoryId: (await ensureInbox(handle.db, actor.ownerId)).id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await getTask(handle.db, actor.ownerId, task.id)).status).toBe("open");
  });

  it("lets MySQL itself reject inconsistent states", async () => {
    const task = await createTask(handle.db, actor, { title: "Guarded" });
    const event = await createEvent(handle.db, actor, {
      title: "Guarded event",
      startsAt: at("2026-10-19T14:00:00.000Z"),
      endsAt: at("2026-10-19T15:00:00.000Z"),
      timezone: "America/Chicago",
    });

    await expect(
      handle.pool.query("UPDATE tasks SET status = 'completed' WHERE id = ?", [task.id]),
    ).rejects.toThrow(/tasks_completed_at_matches_status/);
    await expect(
      handle.pool.query("UPDATE events SET status = 'canceled' WHERE id = ?", [event.id]),
    ).rejects.toThrow(/events_canceled_at_matches_status/);
    await expect(
      handle.pool.query("UPDATE events SET ends_at = '2026-10-19 13:00:00' WHERE id = ?", [
        event.id,
      ]),
    ).rejects.toThrow(/events_ends_not_before_starts/);
    await expect(
      createWorkBlock(handle.db, actor, {
        startsAt: at("2026-10-19T15:00:00.000Z"),
        endsAt: at("2026-10-19T15:00:00.000Z"),
      }),
    ).rejects.toThrow();
  });
});
