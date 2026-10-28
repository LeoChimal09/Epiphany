import { and, asc, desc, eq, gt, inArray, lt, lte, notInArray, or, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { newId } from "../db/domain";
import { actionHistory, events, reminders, tasks, type Reminder } from "../db/schema";

export async function eventAcknowledged(
  db: Database,
  ownerId: string,
  eventId: string,
  version: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: actionHistory.id })
    .from(actionHistory)
    .where(
      and(
        eq(actionHistory.ownerId, ownerId),
        eq(actionHistory.entityId, eventId),
        eq(actionHistory.action, "event.acknowledge"),
        sql`JSON_EXTRACT(${actionHistory.after}, '$.version') = ${version}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export interface NewReminder {
  kind: Reminder["kind"];
  subjectType?: "task" | "event";
  subjectId?: string;
  dedupeKey: string;
  message: string;
  urgency?: "normal" | "high";
  dueAt: Date;
}

// Creates a reminder unless one with the same dedupe key already exists. Returns whether it was new,
// so scheduling can be repeated at every cycle without ever creating a second copy.
export async function scheduleReminder(
  db: Database,
  ownerId: string,
  input: NewReminder,
): Promise<boolean> {
  const [result] = await db
    .insert(reminders)
    .ignore()
    .values({
      id: newId(),
      ownerId,
      kind: input.kind,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      dedupeKey: input.dedupeKey.slice(0, 191),
      message: input.message.slice(0, 1000),
      urgency: input.urgency ?? "normal",
      dueAt: input.dueAt,
    });
  return result.affectedRows === 1;
}

export async function scheduleSplitReminder(
  db: Database,
  ownerId: string,
  input: NewReminder,
): Promise<boolean> {
  if (await scheduleReminder(db, ownerId, input)) return true;
  // Re-enabling a canceled future slot must not replay a sent or uncertain delivery.
  const [result] = await db
    .update(reminders)
    .set({
      status: "scheduled",
      dueAt: input.dueAt,
      message: input.message.slice(0, 1000),
      attempts: 0,
      nextAttemptAt: null,
      claimedAt: null,
      detail: null,
    })
    .where(
      and(
        eq(reminders.ownerId, ownerId),
        eq(reminders.dedupeKey, input.dedupeKey),
        eq(reminders.status, "canceled"),
      ),
    );
  return result.affectedRows === 1;
}

// A briefing is scheduled once per local date. If its configured time changes while it is still
// pending, move that job instead of letting the unique daily key preserve the old time.
export async function scheduleBriefing(
  db: Database,
  ownerId: string,
  input: { dedupeKey: string; dueAt: Date; message: string },
): Promise<boolean> {
  const inserted = await scheduleReminder(db, ownerId, { ...input, kind: "briefing" });
  if (inserted) return true;

  const [existing] = await db
    .select({
      id: reminders.id,
      status: reminders.status,
      dueAt: reminders.dueAt,
      message: reminders.message,
      nextAttemptAt: reminders.nextAttemptAt,
      detail: reminders.detail,
    })
    .from(reminders)
    .where(and(eq(reminders.ownerId, ownerId), eq(reminders.dedupeKey, input.dedupeKey)));
  if (!existing) return false;

  const wasDisabled = existing.status === "canceled" && existing.detail === "briefing disabled";
  if (existing.status !== "scheduled" && !wasDisabled) return false;
  if (
    !wasDisabled &&
    existing.dueAt.getTime() === input.dueAt.getTime() &&
    existing.message === input.message &&
    existing.nextAttemptAt === null &&
    existing.detail === null
  ) {
    return false;
  }

  const conditions = [
    eq(reminders.id, existing.id),
    eq(reminders.status, existing.status),
    ...(wasDisabled ? [eq(reminders.detail, "briefing disabled")] : []),
  ];
  await db
    .update(reminders)
    .set({
      status: "scheduled",
      dueAt: input.dueAt,
      message: input.message.slice(0, 1000),
      nextAttemptAt: null,
      claimedAt: null,
      detail: null,
      version: sql`${reminders.version} + 1`,
    })
    .where(and(...conditions));
  return false;
}

export async function cancelScheduledBriefings(db: Database, ownerId: string): Promise<number> {
  const [result] = await db
    .update(reminders)
    .set({
      status: "canceled",
      detail: "briefing disabled",
      version: sql`${reminders.version} + 1`,
    })
    .where(
      and(
        eq(reminders.ownerId, ownerId),
        eq(reminders.kind, "briefing"),
        eq(reminders.status, "scheduled"),
      ),
    );
  return result.affectedRows;
}

// Cancels scheduled reminders for a subject whose reminder set changed (for example a new deadline).
export async function cancelOtherReminders(
  db: Database,
  ownerId: string,
  subjectType: "task" | "event",
  subjectId: string,
  keepKeys: string[],
  detail: string,
): Promise<number> {
  const filters = [
    eq(reminders.ownerId, ownerId),
    eq(reminders.subjectType, subjectType),
    eq(reminders.subjectId, subjectId),
    eq(reminders.status, "scheduled"),
  ];
  if (keepKeys.length > 0) filters.push(notInArray(reminders.dedupeKey, keepKeys));
  const [result] = await db
    .update(reminders)
    .set({
      status: "canceled",
      detail: detail.slice(0, 160),
      version: sql`${reminders.version} + 1`,
    })
    .where(and(...filters));
  return result.affectedRows;
}

// Cancels scheduled reminders about tasks that are finished or archived, and events that were
// canceled, so nothing fires for work that no longer needs it.
export async function cancelObsoleteReminders(db: Database, ownerId: string): Promise<number> {
  const [doneTasks] = await db
    .update(reminders)
    .set({
      status: "canceled",
      detail: "task no longer open",
      version: sql`${reminders.version} + 1`,
    })
    .where(
      and(
        eq(reminders.ownerId, ownerId),
        eq(reminders.status, "scheduled"),
        eq(reminders.subjectType, "task"),
        inArray(
          reminders.subjectId,
          db
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.ownerId, ownerId),
                or(eq(tasks.status, "completed"), sql`${tasks.archivedAt} IS NOT NULL`),
              ),
            ),
        ),
      ),
    );
  const [canceledEvents] = await db
    .update(reminders)
    .set({ status: "canceled", detail: "event canceled", version: sql`${reminders.version} + 1` })
    .where(
      and(
        eq(reminders.ownerId, ownerId),
        eq(reminders.status, "scheduled"),
        eq(reminders.subjectType, "event"),
        inArray(
          reminders.subjectId,
          db
            .select({ id: events.id })
            .from(events)
            .where(and(eq(events.ownerId, ownerId), eq(events.status, "canceled"))),
        ),
      ),
    );
  return doneTasks.affectedRows + canceledEvents.affectedRows;
}

// A job still marked "sending" after this long was interrupted (a crash or restart) at an unknown
// point. It is not sent again, because it may already have reached the owner.
export const SENDING_STALE_MS = 2 * 60_000;

export async function markInterruptedUnknown(
  db: Database,
  ownerId: string,
  now: Date,
  staleMs = SENDING_STALE_MS,
): Promise<number> {
  const [result] = await db
    .update(reminders)
    .set({
      status: "unknown",
      detail: "delivery not confirmed (interrupted); not resent",
      version: sql`${reminders.version} + 1`,
    })
    .where(
      and(
        eq(reminders.ownerId, ownerId),
        eq(reminders.status, "sending"),
        lt(reminders.claimedAt, new Date(now.getTime() - staleMs)),
      ),
    );
  return result.affectedRows;
}

// Takes up to `limit` due reminders for sending. Each is claimed with a conditional update, so two
// workers (or a worker restarting mid-cycle) can never both send the same one.
export async function claimDue(
  db: Database,
  ownerId: string,
  now: Date,
  limit = 25,
): Promise<Reminder[]> {
  const candidates = await db
    .select({ id: reminders.id })
    .from(reminders)
    .where(
      and(
        eq(reminders.ownerId, ownerId),
        eq(reminders.status, "scheduled"),
        lte(reminders.dueAt, now),
        or(isNull(reminders.nextAttemptAt), lte(reminders.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(reminders.dueAt))
    .limit(limit);

  const claimed: Reminder[] = [];
  for (const { id } of candidates) {
    const [result] = await db
      .update(reminders)
      .set({
        status: "sending",
        claimedAt: now,
        attempts: sql`${reminders.attempts} + 1`,
        version: sql`${reminders.version} + 1`,
      })
      .where(and(eq(reminders.id, id), eq(reminders.status, "scheduled")));
    if (result.affectedRows !== 1) continue;
    const [row] = await db.select().from(reminders).where(eq(reminders.id, id));
    if (row) claimed.push(row);
  }
  return claimed;
}

const bump = () => sql`${reminders.version} + 1`;

export const markSent = (db: Database, id: string, now: Date, detail?: string) =>
  db
    .update(reminders)
    .set({ status: "sent", sentAt: now, detail: detail ?? null, version: bump() })
    .where(eq(reminders.id, id));

export const markSkipped = (db: Database, id: string, reason: string) =>
  db
    .update(reminders)
    .set({ status: "skipped", detail: reason.slice(0, 160), version: bump() })
    .where(eq(reminders.id, id));

export const markFailed = (db: Database, id: string, reason: string) =>
  db
    .update(reminders)
    .set({ status: "failed", detail: reason.slice(0, 160), version: bump() })
    .where(eq(reminders.id, id));

// Puts a claimed reminder back to wait. A deferral (quiet hours) does not count as an attempt.
export const releaseUntil = (
  db: Database,
  id: string,
  until: Date,
  options: { countAttempt: boolean; detail?: string },
) =>
  db
    .update(reminders)
    .set({
      status: "scheduled",
      nextAttemptAt: until,
      claimedAt: null,
      detail: options.detail?.slice(0, 160) ?? null,
      ...(options.countAttempt ? {} : { attempts: sql`GREATEST(${reminders.attempts} - 1, 0)` }),
      version: bump(),
    })
    .where(eq(reminders.id, id));

export async function countSentBetween(
  db: Database,
  ownerId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(reminders)
    .where(
      and(
        eq(reminders.ownerId, ownerId),
        eq(reminders.status, "sent"),
        eq(reminders.urgency, "normal"),
        gt(reminders.sentAt, from),
        lte(reminders.sentAt, to),
      ),
    );
  return Number(row?.count ?? 0);
}

// Pushes a scheduled reminder back to a later time (its due time moves too, so it is not
// judged late against the original time). Only a reminder that has not been sent can
// be snoozed; anything else is left alone.
export async function snoozeReminder(
  db: Database,
  ownerId: string,
  id: string,
  until: Date,
): Promise<boolean> {
  const [result] = await db
    .update(reminders)
    .set({ dueAt: until, nextAttemptAt: until, detail: "snoozed", version: bump() })
    .where(
      and(eq(reminders.id, id), eq(reminders.ownerId, ownerId), eq(reminders.status, "scheduled")),
    );
  return result.affectedRows === 1;
}

export async function recentReminders(
  db: Database,
  ownerId: string,
  limit = 20,
): Promise<Reminder[]> {
  return db
    .select()
    .from(reminders)
    .where(eq(reminders.ownerId, ownerId))
    .orderBy(desc(reminders.dueAt))
    .limit(limit);
}
