import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  ensureInbox,
  getTask,
  InvalidChangeError,
  NotFoundError,
  recordAction,
  resolveCategory,
  VersionConflictError,
  type Actor,
} from "./domain";
import { categories, notes, tasks, type Category, type Note, type Task } from "./schema";

export interface TaskPatch {
  taskType?: "task" | "todo";
  title?: string;
  priority?: "minor" | "major";
  details?: string | null;
  // null clears the deadline.
  dueAt?: Date | null;
  dueDateOnly?: boolean;
  // null clears the estimate.
  estimatedMinutes?: number | null;
  // Moves the task to another of the owner's categories.
  categoryId?: string;
  // null clears the review flag. Giving the task a deadline clears it too, unless this is set.
  reviewNote?: string | null;
}

export interface NotePatch {
  title?: string | null;
  body?: string;
  kind?: "note" | "idea";
  categoryId?: string;
}

const sameDate = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

// Edits fields of a task and nothing else: status, completion, and work blocks are never touched.
// Only fields that actually change are written, versioned, and logged; if nothing changes the task
// is returned as-is (changed: false). With expectedVersion, a stale edit is refused instead of
// overwriting someone else's change. History records which fields changed, and values only for
// non-text fields, so private text is not duplicated into the log.
export async function updateTask(
  db: Database,
  actor: Actor,
  taskId: string,
  patch: TaskPatch,
  expectedVersion?: number,
): Promise<{ task: Task; changed: boolean }> {
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, actor.ownerId)))
      .for("update");
    if (!current) throw new NotFoundError("Task");
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new VersionConflictError("Task", current.version);
    }

    const next = {
      taskType: patch.taskType ?? current.taskType,
      title: patch.title ?? current.title,
      priority:
        (patch.taskType ?? current.taskType) === "todo"
          ? "minor"
          : (patch.priority ?? current.priority),
      details: patch.details === undefined ? current.details : patch.details,
      dueAt:
        (patch.taskType ?? current.taskType) === "todo"
          ? null
          : patch.dueAt === undefined
            ? current.dueAt
            : patch.dueAt,
      dueDateOnly:
        (patch.taskType ?? current.taskType) === "todo"
          ? false
          : (patch.dueDateOnly ?? current.dueDateOnly),
      estimatedMinutes:
        (patch.taskType ?? current.taskType) === "todo"
          ? null
          : patch.estimatedMinutes === undefined
            ? current.estimatedMinutes
            : patch.estimatedMinutes,
      categoryId:
        patch.categoryId === undefined
          ? current.categoryId
          : await resolveCategory(tx, actor.ownerId, patch.categoryId),
      remainingMinutes:
        (patch.taskType ?? current.taskType) === "todo" ? null : current.remainingMinutes,
      reviewNote:
        (patch.taskType ?? current.taskType) === "todo"
          ? null
          : patch.reviewNote === undefined
            ? patch.dueAt
              ? null
              : current.reviewNote
            : patch.reviewNote,
    };

    if (next.taskType !== "todo" && next.dueAt === null && next.estimatedMinutes === null) {
      next.taskType = "todo";
      next.priority = "minor";
      next.dueDateOnly = false;
      next.remainingMinutes = null;
      next.reviewNote = null;
    }

    // A date-only deadline needs a deadline; clearing the deadline clears the flag.
    if (next.dueAt === null) {
      if (next.taskType !== "todo" && patch.dueDateOnly === true) {
        throw new InvalidChangeError("dueDateOnly needs a deadline");
      }
      next.dueDateOnly = false;
    }

    // Untouched work-remaining follows the estimate; open tasks only (completed stay at 0).
    if (
      current.status === "open" &&
      next.estimatedMinutes !== current.estimatedMinutes &&
      (current.remainingMinutes === null || current.remainingMinutes === current.estimatedMinutes)
    ) {
      next.remainingMinutes = next.estimatedMinutes;
    }

    const fields: string[] = [];
    const values: Record<string, unknown> = {};
    if (next.taskType !== current.taskType) {
      fields.push("taskType");
      values.taskType = { from: current.taskType, to: next.taskType };
    }
    if (next.title !== current.title) fields.push("title");
    if (next.priority !== current.priority) {
      fields.push("priority");
      values.priority = { from: current.priority, to: next.priority };
    }
    if (next.details !== current.details) fields.push("details");
    if (!sameDate(next.dueAt, current.dueAt)) {
      fields.push("dueAt");
      values.dueAt = {
        from: current.dueAt?.toISOString() ?? null,
        to: next.dueAt?.toISOString() ?? null,
      };
    }
    if (next.dueDateOnly !== current.dueDateOnly) {
      fields.push("dueDateOnly");
      values.dueDateOnly = { from: current.dueDateOnly, to: next.dueDateOnly };
    }
    if (next.estimatedMinutes !== current.estimatedMinutes) {
      fields.push("estimatedMinutes");
      values.estimatedMinutes = { from: current.estimatedMinutes, to: next.estimatedMinutes };
    }
    if (next.reviewNote !== current.reviewNote) fields.push("reviewNote");
    if (next.categoryId !== current.categoryId) {
      fields.push("categoryId");
      values.categoryId = { from: current.categoryId, to: next.categoryId };
    }
    if (fields.length === 0) return false;

    await tx
      .update(tasks)
      .set({ ...next, version: current.version + 1 })
      .where(eq(tasks.id, taskId));
    await recordAction(tx, actor, {
      action: "task.update",
      entityType: "task",
      entityId: taskId,
      before: { version: current.version },
      after: { version: current.version + 1, fields, values },
    });
    return true;
  });
  return { task: await getTask(db, actor.ownerId, taskId), changed };
}

// Deliberately reopens a completed task. The deadline and history are kept; remaining work resets
// to the estimate. Work blocks are not recreated. Reopening an open task changes nothing.
export async function reopenTask(
  db: Database,
  actor: Actor,
  taskId: string,
): Promise<{ task: Task; changed: boolean }> {
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, actor.ownerId)))
      .for("update");
    if (!current) throw new NotFoundError("Task");
    if (current.status === "open") return false;

    await tx
      .update(tasks)
      .set({
        status: "open",
        completedAt: null,
        remainingMinutes: current.estimatedMinutes,
        version: current.version + 1,
      })
      .where(eq(tasks.id, taskId));
    await recordAction(tx, actor, {
      action: "task.reopen",
      entityType: "task",
      entityId: taskId,
      before: { status: "completed", completedAt: current.completedAt?.toISOString() ?? null },
      after: { status: "open", remainingMinutes: current.estimatedMinutes },
    });
    return true;
  });
  return { task: await getTask(db, actor.ownerId, taskId), changed };
}

export async function updateNote(
  db: Database,
  actor: Actor,
  noteId: string,
  patch: NotePatch,
  expectedVersion?: number,
): Promise<{ note: Note; changed: boolean }> {
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, actor.ownerId)))
      .for("update");
    if (!current) throw new NotFoundError("Note");
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new VersionConflictError("Note", current.version);
    }

    const next = {
      title: patch.title === undefined ? current.title : patch.title,
      body: patch.body ?? current.body,
      kind: patch.kind ?? current.kind,
      categoryId:
        patch.categoryId === undefined
          ? current.categoryId
          : await resolveCategory(tx, actor.ownerId, patch.categoryId),
    };

    const fields: string[] = [];
    const values: Record<string, unknown> = {};
    if (next.title !== current.title) fields.push("title");
    if (next.body !== current.body) fields.push("body");
    if (next.kind !== current.kind) {
      fields.push("kind");
      values.kind = { from: current.kind, to: next.kind };
    }
    if (next.categoryId !== current.categoryId) {
      fields.push("categoryId");
      values.categoryId = { from: current.categoryId, to: next.categoryId };
    }
    if (fields.length === 0) return false;

    await tx
      .update(notes)
      .set({ ...next, version: current.version + 1 })
      .where(eq(notes.id, noteId));
    await recordAction(tx, actor, {
      action: "note.update",
      entityType: "note",
      entityId: noteId,
      before: { version: current.version },
      after: { version: current.version + 1, fields, values },
    });
    return true;
  });
  const [row] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.ownerId, actor.ownerId)));
  if (!row) throw new NotFoundError("Note");
  return { note: row, changed };
}

// The owner's categories, Inbox first then by name. The Inbox is created if it is missing (it is
// a system category, not user content), so every owner always has one to file items into.
export async function listCategories(db: Database, ownerId: string): Promise<Category[]> {
  await ensureInbox(db, ownerId);
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.ownerId, ownerId), isNull(categories.archivedAt)))
    .orderBy(sql`${categories.systemKey} IS NULL`, asc(categories.name));
}
