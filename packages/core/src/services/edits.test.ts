import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import { actionHistory, categories, notes, tasks, workBlocks } from "../db/schema";
import { createTestDatabase, dbTestsEnabled, type TestDatabase } from "../db/test-support";
import {
  AccessDeniedError,
  createServices,
  issueOwnerPrincipal,
  ValidationError,
  VersionConflictError,
  type Principal,
  type Services,
} from "./index";

const migrationsFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const NOT_FOUND = /not found/;

describe.skipIf(!dbTestsEnabled)("editing, reopening, and categories against MySQL", () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let services: Services;
  let owner: Principal;
  let stranger: Principal;
  let ownerId: string;

  const principalFor = (
    id: string,
    over: Partial<Parameters<typeof issueOwnerPrincipal>[2]> = {},
  ) =>
    issueOwnerPrincipal(handle.db, id, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
      ...over,
    });

  beforeEach(async () => {
    database = await createTestDatabase();
    handle = connectDatabase(database.url);
    await runMigrations(handle.pool, migrationsFolder);
    services = createServices(handle.db, { clock: () => new Date("2026-10-13T15:00:00.000Z") });
    const a = await createOwner(handle.db, { displayName: "Owner" });
    const b = await createOwner(handle.db, { displayName: "Stranger" });
    ownerId = a.id;
    owner = await principalFor(a.id);
    stranger = await principalFor(b.id);
  });

  afterEach(async () => {
    await handle.close();
    await database.drop();
    expect(await database.exists()).toBe(false);
  });

  const history = async (entityId: string) =>
    (await handle.db.select().from(actionHistory)).filter((h) => h.entityId === entityId);
  const taskRow = async (id: string) =>
    (await handle.db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const noteRow = async (id: string) =>
    (await handle.db.select().from(notes).where(eq(notes.id, id)))[0]!;

  describe("tasks.update", () => {
    it("edits fields, bumps the version, returns the stored row, and logs only what changed", async () => {
      const task = await services.tasks.create(owner, {
        title: "Draft essay",
        estimatedMinutes: 60,
      });
      const { task: updated, changed } = await services.tasks.update(owner, task.id, {
        title: "Final essay",
        details: "Five pages",
        dueAt: "2026-10-20T04:59:59.000Z",
        estimatedMinutes: 90,
      });

      expect(changed).toBe(true);
      expect(updated).toEqual(await taskRow(task.id));
      expect(updated).toMatchObject({
        title: "Final essay",
        details: "Five pages",
        estimatedMinutes: 90,
        version: 2,
        status: "open",
      });
      expect(updated.dueAt?.toISOString()).toBe("2026-10-20T04:59:59.000Z");

      const entry = (await history(task.id)).find((h) => h.action === "task.update")!;
      expect(entry.after).toMatchObject({
        version: 2,
        fields: ["title", "details", "dueAt", "estimatedMinutes"],
      });
      expect(JSON.stringify(entry)).not.toContain("Final essay");
      expect(JSON.stringify(entry)).not.toContain("Five pages");
    });

    it("keeps a review flag until a deadline is set, can set or clear it directly, and logs only the field name", async () => {
      const task = await services.tasks.create(owner, {
        title: "Read chapter 7",
        reviewNote: "no due date given",
      });
      expect((await taskRow(task.id)).reviewNote).toBe("no due date given");

      const retitled = await services.tasks.update(owner, task.id, {
        title: "Read chapter 7 closely",
      });
      expect(retitled.task.reviewNote).toBe("no due date given");

      const dated = await services.tasks.update(owner, task.id, {
        dueAt: "2026-10-20T05:00:00.000Z",
      });
      expect(dated.task.reviewNote).toBeNull();
      const logged = (await history(task.id)).find(
        (entry) =>
          entry.action === "task.update" &&
          (entry.after as { fields?: string[] }).fields?.includes("dueAt"),
      );
      expect((logged?.after as { fields: string[] }).fields).toContain("reviewNote");
      expect(JSON.stringify(logged?.after)).not.toContain("no due date given");

      const flagged = await services.tasks.update(owner, task.id, { reviewNote: "check the date" });
      expect(flagged.task.reviewNote).toBe("check the date");
      const cleared = await services.tasks.update(owner, task.id, { reviewNote: "" });
      expect(cleared.task.reviewNote).toBeNull();
    });

    it("does nothing, and logs nothing, when nothing actually changes", async () => {
      const task = await services.tasks.create(owner, { title: "Same", details: "same" });
      const before = (await history(task.id)).length;
      const result = await services.tasks.update(owner, task.id, {
        title: "Same",
        details: "same",
      });
      expect(result.changed).toBe(false);
      expect(result.task.version).toBe(1);
      expect((await history(task.id)).length).toBe(before);
    });

    it("clears nullable fields with null or blank text, and clearing the deadline clears date-only", async () => {
      const task = await services.tasks.create(owner, {
        title: "Clearable",
        details: "to clear",
        dueAt: "2026-10-20T00:00:00.000Z",
        dueDateOnly: true,
        estimatedMinutes: 30,
      });
      const { task: cleared } = await services.tasks.update(owner, task.id, {
        details: "   ",
        dueAt: null,
        estimatedMinutes: null,
      });
      expect(cleared).toMatchObject({
        details: null,
        dueAt: null,
        dueDateOnly: false,
        estimatedMinutes: null,
      });
    });

    it("refuses a date-only deadline when there is no deadline, and changes nothing", async () => {
      const task = await services.tasks.create(owner, { title: "No deadline" });
      await expect(
        services.tasks.update(owner, task.id, { dueDateOnly: true }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await taskRow(task.id)).version).toBe(1);
      const withDate = await services.tasks.update(owner, task.id, {
        dueAt: "2026-10-20T00:00:00.000Z",
        dueDateOnly: true,
      });
      expect(withDate.task.dueDateOnly).toBe(true);
    });

    it("keeps remaining work in step with an untouched estimate, but not after progress", async () => {
      const fresh = await services.tasks.create(owner, { title: "Fresh", estimatedMinutes: 60 });
      expect(
        (await services.tasks.update(owner, fresh.id, { estimatedMinutes: 90 })).task
          .remainingMinutes,
      ).toBe(90);

      const started = await services.tasks.create(owner, {
        title: "Started",
        estimatedMinutes: 60,
      });
      await handle.pool.query("UPDATE tasks SET remaining_minutes = 20 WHERE id = ?", [started.id]);
      expect(
        (await services.tasks.update(owner, started.id, { estimatedMinutes: 90 })).task
          .remainingMinutes,
      ).toBe(20);

      const done = await services.tasks.create(owner, { title: "Done", estimatedMinutes: 60 });
      await services.tasks.complete(owner, done.id);
      const edited = await services.tasks.update(owner, done.id, { estimatedMinutes: 120 });
      expect(edited.task).toMatchObject({ status: "completed", remainingMinutes: 0 });
    });

    it("can fix a completed task's text without reopening it or changing its completion", async () => {
      const task = await services.tasks.create(owner, { title: "Typo" });
      const { task: done } = await services.tasks.complete(owner, task.id);
      const { task: fixed } = await services.tasks.update(owner, task.id, { title: "Fixed" });
      expect(fixed).toMatchObject({ title: "Fixed", status: "completed" });
      expect(fixed.completedAt?.getTime()).toBe(done.completedAt?.getTime());
    });

    it("moves a task between the owner's categories, and never into someone else's", async () => {
      const school = await services.categories.create(owner, "School");
      const theirs = await services.categories.create(stranger, "Theirs");
      const task = await services.tasks.create(owner, { title: "Sortable" });

      const moved = await services.tasks.update(owner, task.id, { categoryId: school.id });
      expect(moved.task.categoryId).toBe(school.id);
      const entry = (await history(task.id)).find((h) => h.action === "task.update")!;
      expect(entry.after).toMatchObject({ values: { categoryId: { to: school.id } } });

      await expect(
        services.tasks.update(owner, task.id, { categoryId: theirs.id }),
      ).rejects.toThrow(NOT_FOUND);
      await expect(
        services.tasks.update(owner, task.id, {
          categoryId: "00000000-0000-4000-8000-000000000000",
        }),
      ).rejects.toThrow(NOT_FOUND);
      expect((await taskRow(task.id)).categoryId).toBe(school.id);
    });

    it("refuses edits based on a stale version, and accepts the current one", async () => {
      const task = await services.tasks.create(owner, { title: "Versioned" });
      await services.tasks.update(owner, task.id, { title: "Second", expectedVersion: 1 });

      const stale = await services.tasks
        .update(owner, task.id, { title: "Lost update", expectedVersion: 1 })
        .catch((e: unknown) => e);
      expect(stale).toBeInstanceOf(VersionConflictError);
      expect(stale).toMatchObject({ currentVersion: 2 });
      expect((await taskRow(task.id)).title).toBe("Second");

      expect(
        (await services.tasks.update(owner, task.id, { title: "Third", expectedVersion: 2 })).task
          .version,
      ).toBe(3);
    });

    it("lets exactly one of two concurrent edits with the same version win", async () => {
      const task = await services.tasks.create(owner, { title: "Race" });
      const results = await Promise.allSettled([
        services.tasks.update(owner, task.id, { title: "A", expectedVersion: 1 }),
        services.tasks.update(owner, task.id, { title: "B", expectedVersion: 1 }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(VersionConflictError);
      expect((await taskRow(task.id)).version).toBe(2);
    });

    it("rejects fields that are not editable, empty edits, and malformed input, before writing", async () => {
      const task = await services.tasks.create(owner, { title: "Strict" });
      const bad: unknown[] = [
        { status: "completed" },
        { completedAt: "2026-10-13T00:00:00.000Z" },
        { ownerId: stranger.ownerId },
        { version: 99 },
        { id: "x" },
        {},
        { expectedVersion: 1 },
        { title: "" },
        { title: "x".repeat(301) },
        { dueAt: "soon" },
        { estimatedMinutes: 0 },
        { estimatedMinutes: 1.5 },
        { categoryId: "nope" },
        { expectedVersion: 0, title: "x" },
        "string",
      ];
      for (const input of bad) {
        await expect(services.tasks.update(owner, task.id, input)).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
      await expect(
        services.tasks.update(owner, "not-a-uuid", { title: "x" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await taskRow(task.id)).toMatchObject({ title: "Strict", status: "open", version: 1 });
    });

    it("never touches work blocks, other tasks, or another owner's record", async () => {
      const a = await services.tasks.create(owner, { title: "A" });
      const b = await services.tasks.create(owner, { title: "B" });
      const block = await services.workBlocks.create(owner, {
        taskId: a.id,
        startsAt: "2026-10-14T15:00:00.000Z",
        endsAt: "2026-10-14T16:00:00.000Z",
      });
      await services.tasks.update(owner, a.id, { title: "A2" });
      expect((await taskRow(b.id)).title).toBe("B");
      expect(
        (await handle.db.select().from(workBlocks).where(eq(workBlocks.id, block.id)))[0]!.status,
      ).toBe("planned");

      await expect(services.tasks.update(stranger, a.id, { title: "Hijacked" })).rejects.toThrow(
        NOT_FOUND,
      );
      expect((await taskRow(a.id)).title).toBe("A2");
    });

    it("is denied to a shared audience and to forged principals", async () => {
      const task = await services.tasks.create(owner, { title: "Private" });
      const inShared = await principalFor(ownerId, {
        source: "discord",
        audience: "shared",
        initiator: "assistant",
      });
      await expect(
        services.tasks.update(inShared, task.id, { title: "Leak" }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        services.tasks.update({ ...owner }, task.id, { title: "Forged" }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect((await taskRow(task.id)).title).toBe("Private");
    });
  });

  describe("tasks.reopen", () => {
    it("reopens a completed task, keeping its deadline and resetting remaining work", async () => {
      const task = await services.tasks.create(owner, {
        title: "Redo",
        dueAt: "2026-10-20T04:59:59.000Z",
        estimatedMinutes: 45,
      });
      await services.tasks.complete(owner, task.id);

      const { task: reopened, changed } = await services.tasks.reopen(owner, task.id);
      expect(changed).toBe(true);
      expect(reopened).toEqual(await taskRow(task.id));
      expect(reopened).toMatchObject({
        status: "open",
        completedAt: null,
        remainingMinutes: 45,
        version: 3,
      });
      expect(reopened.dueAt?.toISOString()).toBe("2026-10-20T04:59:59.000Z");
      expect((await history(task.id)).map((h) => h.action).sort()).toEqual([
        "task.complete",
        "task.create",
        "task.reopen",
      ]);
    });

    it("is idempotent and a no-op for tasks that are already open", async () => {
      const task = await services.tasks.create(owner, { title: "Open already" });
      expect((await services.tasks.reopen(owner, task.id)).changed).toBe(false);
      await services.tasks.complete(owner, task.id);
      expect((await services.tasks.reopen(owner, task.id)).changed).toBe(true);
      const again = await services.tasks.reopen(owner, task.id);
      expect(again.changed).toBe(false);
      expect(again.task.version).toBe(3);
    });

    it("can be completed again afterwards, and leaves work blocks alone", async () => {
      const task = await services.tasks.create(owner, { title: "Cycle" });
      const block = await services.workBlocks.create(owner, {
        taskId: task.id,
        startsAt: "2026-10-14T15:00:00.000Z",
        endsAt: "2026-10-14T16:00:00.000Z",
      });
      await services.tasks.complete(owner, task.id);
      await services.tasks.reopen(owner, task.id);
      expect((await services.tasks.complete(owner, task.id)).task.status).toBe("completed");
      expect(
        (await handle.db.select().from(workBlocks).where(eq(workBlocks.id, block.id)))[0]!.status,
      ).toBe("planned");
    });

    it("is owner-scoped and denied in shared channels", async () => {
      const task = await services.tasks.create(owner, { title: "Mine" });
      await services.tasks.complete(owner, task.id);
      await expect(services.tasks.reopen(stranger, task.id)).rejects.toThrow(NOT_FOUND);
      const inShared = await principalFor(ownerId, {
        source: "discord",
        audience: "shared",
        initiator: "assistant",
      });
      await expect(services.tasks.reopen(inShared, task.id)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      expect((await taskRow(task.id)).status).toBe("completed");
    });
  });

  describe("notes.update", () => {
    it("edits a note, bumps the version, and logs fields without copying the text", async () => {
      const note = await services.notes.create(owner, {
        title: "Idea",
        body: "first draft",
        kind: "note",
      });
      const { note: updated, changed } = await services.notes.update(owner, note.id, {
        title: "App idea",
        body: "second draft",
        kind: "idea",
      });
      expect(changed).toBe(true);
      expect(updated).toEqual(await noteRow(note.id));
      expect(updated).toMatchObject({
        title: "App idea",
        body: "second draft",
        kind: "idea",
        version: 2,
      });
      const entry = (await history(note.id)).find((h) => h.action === "note.update")!;
      expect(entry.after).toMatchObject({ fields: ["title", "body", "kind"] });
      expect(JSON.stringify(entry)).not.toContain("second draft");
    });

    it("is a no-op when nothing changes, clears the title with blank text, and moves categories", async () => {
      const note = await services.notes.create(owner, { title: "T", body: "B" });
      expect((await services.notes.update(owner, note.id, { body: "B" })).changed).toBe(false);
      expect((await services.notes.update(owner, note.id, { title: "" })).note.title).toBeNull();
      const school = await services.categories.create(owner, "School");
      expect(
        (await services.notes.update(owner, note.id, { categoryId: school.id })).note.categoryId,
      ).toBe(school.id);
      const theirs = await services.categories.create(stranger, "Theirs");
      await expect(
        services.notes.update(owner, note.id, { categoryId: theirs.id }),
      ).rejects.toThrow(NOT_FOUND);
    });

    it("refuses stale versions, invalid input, other owners, and shared channels", async () => {
      const note = await services.notes.create(owner, { body: "keep" });
      await services.notes.update(owner, note.id, { body: "v2", expectedVersion: 1 });
      await expect(
        services.notes.update(owner, note.id, { body: "stale", expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(VersionConflictError);
      for (const bad of [{ body: "" }, {}, { kind: "memo" }, { ownerId: "x" }, { version: 5 }]) {
        await expect(services.notes.update(owner, note.id, bad)).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
      await expect(services.notes.update(stranger, note.id, { body: "mine now" })).rejects.toThrow(
        NOT_FOUND,
      );
      const inShared = await principalFor(ownerId, {
        source: "discord",
        audience: "shared",
        initiator: "assistant",
      });
      await expect(
        services.notes.update(inShared, note.id, { body: "leak" }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect((await noteRow(note.id)).body).toBe("v2");
    });
  });

  describe("categories.list and filtered lists", () => {
    it("lists the Inbox first, then categories by name, only the owner's", async () => {
      await services.categories.create(owner, "Zoology");
      await services.categories.create(owner, "Algebra");
      await services.categories.create(stranger, "Not mine");
      const names = (await services.categories.list(owner)).map((c) => c.name);
      expect(names).toEqual(["Inbox", "Algebra", "Zoology"]);
      expect((await services.categories.list(owner))[0]!.systemKey).toBe("inbox");
    });

    it("always has an Inbox, even for an owner whose Inbox is missing, and hides archived categories", async () => {
      await handle.pool.query("DELETE FROM categories WHERE owner_id = ?", [ownerId]);
      const listed = await services.categories.list(owner);
      expect(listed.map((c) => c.name)).toEqual(["Inbox"]);

      const old = await services.categories.create(owner, "Old");
      await handle.pool.query("UPDATE categories SET archived_at = NOW(3) WHERE id = ?", [old.id]);
      expect((await services.categories.list(owner)).map((c) => c.name)).toEqual(["Inbox"]);
      expect(
        (await handle.db.select().from(categories).where(eq(categories.ownerId, ownerId))).length,
      ).toBe(2);
    });

    it("is denied to shared audiences", async () => {
      const inShared = await principalFor(ownerId, {
        source: "discord",
        audience: "shared",
        initiator: "assistant",
      });
      await expect(services.categories.list(inShared)).rejects.toBeInstanceOf(AccessDeniedError);
    });

    it("filters tasks and notes by category (the Inbox view) and notes by kind, with paging", async () => {
      const school = await services.categories.create(owner, "School");
      const inbox = (await services.categories.list(owner))[0]!;
      const loose = await services.tasks.create(owner, { title: "Loose" });
      await services.tasks.create(owner, { title: "Sorted", categoryId: school.id });
      await services.notes.create(owner, { body: "idea a", kind: "idea" });
      await services.notes.create(owner, { body: "note b", kind: "note", categoryId: school.id });
      await services.notes.create(owner, { body: "idea c", kind: "idea", categoryId: school.id });

      expect((await services.tasks.list(owner, { categoryId: inbox.id })).map((t) => t.id)).toEqual(
        [loose.id],
      );
      expect(
        (await services.tasks.list(owner, { categoryId: school.id })).map((t) => t.title),
      ).toEqual(["Sorted"]);
      expect(
        (await services.notes.list(owner, { categoryId: inbox.id })).map((n) => n.body),
      ).toEqual(["idea a"]);
      expect(
        (await services.notes.list(owner, { kind: "idea" })).map((n) => n.body).sort(),
      ).toEqual(["idea a", "idea c"]);
      expect(await services.notes.list(owner, { limit: 1, offset: 1 })).toHaveLength(1);
      expect(await services.tasks.list(stranger, { categoryId: inbox.id })).toEqual([]);
      await expect(services.tasks.list(owner, { categoryId: "nope" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(services.notes.list(owner, { kind: "memo" })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("keeps the previous list inputs working", async () => {
      await services.tasks.create(owner, { title: "T" });
      await services.notes.create(owner, { body: "N" });
      expect(await services.tasks.list(owner, { status: "open", limit: 100 })).toHaveLength(1);
      expect(await services.notes.list(owner, { limit: 100 })).toHaveLength(1);
      expect(await services.tasks.list(owner)).toHaveLength(1);
      expect(await services.notes.list(owner)).toHaveLength(1);
    });
  });

  describe("list ordering", () => {
    it("puts soonest deadlines first and undated tasks last, so paging never hides urgent work", async () => {
      await services.tasks.create(owner, { title: "Undated 1" });
      await services.tasks.create(owner, { title: "Later", dueAt: "2026-11-01T00:00:00.000Z" });
      await services.tasks.create(owner, { title: "Undated 2" });
      await services.tasks.create(owner, { title: "Soon", dueAt: "2026-10-15T00:00:00.000Z" });

      expect((await services.tasks.list(owner)).map((t) => t.title)).toEqual([
        "Soon",
        "Later",
        "Undated 1",
        "Undated 2",
      ]);
      expect((await services.tasks.list(owner, { limit: 2 })).map((t) => t.title)).toEqual([
        "Soon",
        "Later",
      ]);
    });

    it("lists completed tasks most recently finished first", async () => {
      const first = await services.tasks.create(owner, { title: "First done" });
      const second = await services.tasks.create(owner, { title: "Second done" });
      await handle.pool.query(
        "UPDATE tasks SET status='completed', completed_at='2026-10-01 10:00:00.000' WHERE id = ?",
        [first.id],
      );
      await handle.pool.query(
        "UPDATE tasks SET status='completed', completed_at='2026-10-05 10:00:00.000' WHERE id = ?",
        [second.id],
      );
      expect(
        (await services.tasks.list(owner, { status: "completed" })).map((t) => t.title),
      ).toEqual(["Second done", "First done"]);
    });
  });
});
