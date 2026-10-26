import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  actionHistory,
  categories,
  events,
  notes,
  owners,
  tasks,
  workBlocks,
  type ActionSource,
  type CalendarEvent,
  type Category,
  type Note,
  type Owner,
  type Task,
  type WorkBlock,
} from "./schema";

export const INBOX_KEY = "inbox";

// The record changed since the caller loaded it (its version no longer matches).
export class VersionConflictError extends Error {
  readonly currentVersion: number;
  constructor(entity: string, currentVersion: number) {
    super(
      `${entity} was changed since you loaded it (now version ${currentVersion}). Reload and try again.`,
    );
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
  }
}

// The requested change is not allowed given the record's current state (for example, a
// date-only deadline on a task that has no deadline). The services layer reports it as invalid input.
export class InvalidChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChangeError";
  }
}

export class NotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} not found for this owner.`);
    this.name = "NotFoundError";
  }
}

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Writer = Database | Tx;

export interface Actor {
  ownerId: string;
  source: ActionSource;
  now?: Date;
}

export const newId = () => randomUUID();

async function record(
  tx: Writer,
  actor: Actor,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    undoOfId?: string;
  },
): Promise<void> {
  await tx.insert(actionHistory).values({
    id: newId(),
    ownerId: actor.ownerId,
    source: actor.source,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    undoOfId: entry.undoOfId ?? null,
    createdAt: actor.now ?? new Date(),
  });
}

export async function createOwner(
  db: Database,
  input: { displayName: string; timezone?: string; discordUserId?: string },
): Promise<Owner> {
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.insert(owners).values({
      id,
      displayName: input.displayName,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      discordUserId: input.discordUserId ?? null,
    });
    await ensureInbox(tx, id);
    await record(
      tx,
      { ownerId: id, source: "system" },
      {
        action: "owner.create",
        entityType: "owner",
        entityId: id,
      },
    );
  });
  return getOwner(db, id);
}

export async function getOwner(db: Writer, ownerId: string): Promise<Owner> {
  const [row] = await db.select().from(owners).where(eq(owners.id, ownerId));
  if (!row) throw new NotFoundError("Owner");
  return row;
}

// Idempotent: safe to call repeatedly or concurrently.
export async function ensureInbox(db: Writer, ownerId: string): Promise<Category> {
  await db
    .insert(categories)
    .values({ id: newId(), ownerId, name: "Inbox", systemKey: INBOX_KEY })
    .onDuplicateKeyUpdate({ set: { systemKey: sql`${categories.systemKey}` } });
  const [row] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.ownerId, ownerId), eq(categories.systemKey, INBOX_KEY)));
  if (!row) throw new NotFoundError("Inbox category");
  return row;
}

export async function resolveCategory(
  tx: Writer,
  ownerId: string,
  categoryId?: string,
): Promise<string> {
  if (!categoryId) return (await ensureInbox(tx, ownerId)).id;
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.ownerId, ownerId)));
  if (!row) throw new NotFoundError("Category");
  return row.id;
}

export async function createCategory(db: Database, actor: Actor, name: string): Promise<Category> {
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.insert(categories).values({ id, ownerId: actor.ownerId, name });
    await record(tx, actor, {
      action: "category.create",
      entityType: "category",
      entityId: id,
      after: { name },
    });
  });
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  if (!row) throw new NotFoundError("Category");
  return row;
}

export interface NewTask {
  title: string;
  priority?: "minor" | "major";
  categoryId?: string;
  details?: string;
  sourceText?: string;
  sourceRef?: string;
  reviewNote?: string;
  dueAt?: Date;
  dueDateOnly?: boolean;
  estimatedMinutes?: number;
}

export async function createTask(db: Database, actor: Actor, input: NewTask): Promise<Task> {
  const id = newId();
  await db.transaction(async (tx) => {
    const categoryId = await resolveCategory(tx, actor.ownerId, input.categoryId);
    await tx.insert(tasks).values({
      id,
      ownerId: actor.ownerId,
      categoryId,
      title: input.title,
      priority: input.priority ?? "minor",
      details: input.details ?? null,
      sourceText: input.sourceText ?? null,
      sourceRef: input.sourceRef ?? null,
      reviewNote: input.reviewNote ?? null,
      dueAt: input.dueAt ?? null,
      dueDateOnly: input.dueDateOnly ?? false,
      estimatedMinutes: input.estimatedMinutes ?? null,
      remainingMinutes: input.estimatedMinutes ?? null,
    });
    await record(tx, actor, {
      action: "task.create",
      entityType: "task",
      entityId: id,
      after: {
        title: input.title,
        categoryId,
        priority: input.priority ?? "minor",
        dueAt: input.dueAt?.toISOString() ?? null,
        dueDateOnly: input.dueDateOnly ?? false,
        estimatedMinutes: input.estimatedMinutes ?? null,
      },
    });
  });
  return getTask(db, actor.ownerId, id);
}

export async function getTask(db: Writer, ownerId: string, taskId: string): Promise<Task> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, ownerId)));
  if (!row) throw new NotFoundError("Task");
  return row;
}

// Completion changes only the task. Events, work blocks, and the deadline are untouched.
export async function completeTask(
  db: Database,
  actor: Actor,
  taskId: string,
): Promise<{ task: Task; changed: boolean }> {
  const now = actor.now ?? new Date();
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, actor.ownerId)))
      .for("update");
    if (!current) throw new NotFoundError("Task");
    if (current.status === "completed") return false;

    await tx
      .update(tasks)
      .set({
        status: "completed",
        completedAt: now,
        remainingMinutes: 0,
        version: current.version + 1,
      })
      .where(eq(tasks.id, taskId));
    await record(tx, actor, {
      action: "task.complete",
      entityType: "task",
      entityId: taskId,
      before: { status: current.status, remainingMinutes: current.remainingMinutes },
      after: { status: "completed", completedAt: now.toISOString() },
    });
    return true;
  });
  return { task: await getTask(db, actor.ownerId, taskId), changed };
}

export interface NewEvent {
  title: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  allDay?: boolean;
  location?: string;
}

export async function createEvent(
  db: Database,
  actor: Actor,
  input: NewEvent,
): Promise<CalendarEvent> {
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.insert(events).values({
      id,
      ownerId: actor.ownerId,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      allDay: input.allDay ?? false,
      location: input.location ?? null,
    });
    await record(tx, actor, {
      action: "event.create",
      entityType: "event",
      entityId: id,
      after: {
        title: input.title,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
        timezone: input.timezone,
        allDay: input.allDay ?? false,
      },
    });
  });
  return getEvent(db, actor.ownerId, id);
}

export async function getEvent(
  db: Writer,
  ownerId: string,
  eventId: string,
): Promise<CalendarEvent> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.ownerId, ownerId)));
  if (!row) throw new NotFoundError("Event");
  return row;
}

// Cancellation keeps the event row and changes nothing else; it is not a deletion.
export async function cancelEvent(
  db: Database,
  actor: Actor,
  eventId: string,
): Promise<{ event: CalendarEvent; changed: boolean }> {
  const now = actor.now ?? new Date();
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.ownerId, actor.ownerId)))
      .for("update");
    if (!current) throw new NotFoundError("Event");
    if (current.status === "canceled") return false;

    await tx
      .update(events)
      .set({ status: "canceled", canceledAt: now, version: current.version + 1 })
      .where(eq(events.id, eventId));
    await record(tx, actor, {
      action: "event.cancel",
      entityType: "event",
      entityId: eventId,
      before: { status: current.status },
      after: { status: "canceled", canceledAt: now.toISOString() },
    });
    return true;
  });
  return { event: await getEvent(db, actor.ownerId, eventId), changed };
}

export interface NewWorkBlock {
  taskId?: string;
  title?: string;
  startsAt: Date;
  endsAt: Date;
}

export async function createWorkBlock(
  db: Database,
  actor: Actor,
  input: NewWorkBlock,
): Promise<WorkBlock> {
  const id = newId();
  await db.transaction(async (tx) => {
    if (input.taskId) await getTask(tx, actor.ownerId, input.taskId);
    await tx.insert(workBlocks).values({
      id,
      ownerId: actor.ownerId,
      taskId: input.taskId ?? null,
      title: input.title ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });
    await record(tx, actor, {
      action: "work_block.create",
      entityType: "work_block",
      entityId: id,
      after: { taskId: input.taskId ?? null, startsAt: input.startsAt.toISOString() },
    });
  });
  return getWorkBlock(db, actor.ownerId, id);
}

export async function getWorkBlock(
  db: Writer,
  ownerId: string,
  blockId: string,
): Promise<WorkBlock> {
  const [row] = await db
    .select()
    .from(workBlocks)
    .where(and(eq(workBlocks.id, blockId), eq(workBlocks.ownerId, ownerId)));
  if (!row) throw new NotFoundError("Work block");
  return row;
}

// Removal keeps the block row for history and does not complete or alter its task.
export async function removeWorkBlock(
  db: Database,
  actor: Actor,
  blockId: string,
  reason: "manual" | "task_completed" | "replanned" = "manual",
): Promise<{ workBlock: WorkBlock; changed: boolean }> {
  const now = actor.now ?? new Date();
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(workBlocks)
      .where(and(eq(workBlocks.id, blockId), eq(workBlocks.ownerId, actor.ownerId)))
      .for("update");
    if (!current) throw new NotFoundError("Work block");
    if (current.status === "removed") return false;

    await tx
      .update(workBlocks)
      .set({
        status: "removed",
        removedAt: now,
        removedReason: reason,
        version: current.version + 1,
      })
      .where(eq(workBlocks.id, blockId));
    await record(tx, actor, {
      action: "work_block.remove",
      entityType: "work_block",
      entityId: blockId,
      before: { status: current.status },
      after: { status: "removed", reason },
    });
    return true;
  });
  return { workBlock: await getWorkBlock(db, actor.ownerId, blockId), changed };
}

export interface NewNote {
  body: string;
  title?: string;
  kind?: "note" | "idea";
  categoryId?: string;
  sourceRef?: string;
}

export async function createNote(db: Database, actor: Actor, input: NewNote): Promise<Note> {
  const id = newId();
  await db.transaction(async (tx) => {
    const categoryId = await resolveCategory(tx, actor.ownerId, input.categoryId);
    await tx.insert(notes).values({
      id,
      ownerId: actor.ownerId,
      categoryId,
      kind: input.kind ?? "note",
      title: input.title ?? null,
      body: input.body,
      sourceRef: input.sourceRef ?? null,
    });
    await record(tx, actor, {
      action: "note.create",
      entityType: "note",
      entityId: id,
      after: { kind: input.kind ?? "note", categoryId },
    });
  });
  const [row] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.ownerId, actor.ownerId)));
  if (!row) throw new NotFoundError("Note");
  return row;
}
export { record as recordAction };
