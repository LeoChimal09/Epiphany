import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { events, tasks, type Reminder } from "../db/schema";
import { addDays, dateKeyOf, localWallToUtc } from "../planning/time";
import { decideDelivery, retryDelayMs, type ReminderSettings } from "./policy";
import {
  claimDue,
  countSentBetween,
  markFailed,
  markInterruptedUnknown,
  markSent,
  markSkipped,
  releaseUntil,
} from "./store";

export type DeliveryResult =
  // channelId is where the message landed, so a reply there can be tied to the reminder.
  | { ok: true; channelId?: string }
  // blocked: the configured private destination cannot be reached; retrying will not help.
  // rate_limited: try again later. error: anything else, worth a few more tries.
  | { ok: false; reason: "blocked" | "rate_limited" | "error"; retryAfterMs?: number };

export interface ReminderDelivery {
  send(text: string): Promise<DeliveryResult>;
}

export interface CycleReport {
  sent: number;
  skipped: number;
  deferred: number;
  retrying: number;
  failed: number;
  unknown: number;
  summarized: number;
}

// After an outage, more than this many late reminders are sent as one short summary instead of a
// burst of individual messages.
export const MAX_LATE_INDIVIDUAL = 3;

async function subjectActive(db: Database, reminder: Reminder, now: Date): Promise<boolean> {
  if (!reminder.subjectId) return true;
  if (reminder.subjectType === "task") {
    const [task] = await db
      .select({ status: tasks.status, archivedAt: tasks.archivedAt })
      .from(tasks)
      .where(and(eq(tasks.id, reminder.subjectId), eq(tasks.ownerId, reminder.ownerId)));
    return task !== undefined && task.status === "open" && task.archivedAt === null;
  }
  if (reminder.subjectType === "event") {
    const [event] = await db
      .select({ status: events.status, endsAt: events.endsAt })
      .from(events)
      .where(and(eq(events.id, reminder.subjectId), eq(events.ownerId, reminder.ownerId)));
    return (
      event !== undefined && event.status === "scheduled" && event.endsAt.getTime() > now.getTime()
    );
  }
  return true;
}

// One pass of the reminder service: handle jobs interrupted by a restart, claim what is due, decide
// for each whether it is still worth sending (see decideDelivery), deliver, and record exactly what
// happened. It uses no AI call, so reminders keep working when the model provider is down. Nothing
// here can send a reminder twice: a job is claimed before sending, and one found half-sent after a
// crash is marked unknown rather than sent again.
export async function runReminderCycle(options: {
  db: Database;
  ownerId: string;
  now: Date;
  timezone: string;
  settings: ReminderSettings;
  delivery: ReminderDelivery;
  // Builds the text at send time (the morning briefing reads today's records then, not when it
  // was scheduled). Returning null keeps the stored message.
  compose?: (reminder: Reminder) => Promise<string | null>;
  // Called after a reminder was delivered, so a reply can be understood in its context.
  onDelivered?: (reminders: Reminder[], result: { channelId?: string }) => Promise<void> | void;
}): Promise<CycleReport> {
  const { db, ownerId, now, timezone, settings, delivery } = options;
  const report: CycleReport = {
    sent: 0,
    skipped: 0,
    deferred: 0,
    retrying: 0,
    failed: 0,
    unknown: 0,
    summarized: 0,
  };

  report.unknown = await markInterruptedUnknown(db, ownerId, now);
  const claimed = await claimDue(db, ownerId, now);
  if (claimed.length === 0) return report;

  const today = dateKeyOf(now, timezone);
  const dayStart = localWallToUtc(today, 0, timezone);
  const dayEnd = localWallToUtc(addDays(today, 1), 0, timezone);
  let sentToday = await countSentBetween(db, ownerId, dayStart, dayEnd);

  const toSend: { reminder: Reminder; late: boolean }[] = [];
  for (const reminder of claimed) {
    const decision = decideDelivery({
      reminder: {
        kind: reminder.kind,
        urgency: reminder.urgency,
        dueAt: reminder.dueAt,
        hasSubject: reminder.subjectId !== null,
      },
      now,
      timezone,
      settings,
      subjectActive: await subjectActive(db, reminder, now),
      sentToday,
    });
    if (decision.action === "skip") {
      await markSkipped(db, reminder.id, decision.reason.replace("_", " "));
      report.skipped++;
    } else if (decision.action === "defer") {
      await releaseUntil(db, reminder.id, decision.until, {
        countAttempt: false,
        detail: "held for quiet hours",
      });
      report.deferred++;
    } else {
      toSend.push({ reminder, late: decision.late });
      if (reminder.urgency === "normal") sentToday++;
    }
  }

  const late = toSend.filter((entry) => entry.late);
  const merge = late.length > MAX_LATE_INDIVIDUAL;
  const individual = toSend.filter((entry) => !merge || !entry.late);

  for (const { reminder, late: isLate } of individual) {
    let body = reminder.message;
    try {
      body = (await options.compose?.(reminder)) ?? body;
    } catch {
      // Keep the stored message if composing fails; the reminder still goes out.
    }
    await deliver([reminder], isLate ? `(a little late) ${body}` : body);
  }
  if (merge) {
    const lines = late.map((entry) => entry.reminder.message.replace(/^Heads up: /, ""));
    const text = `While I was away I missed ${late.length} reminders that still matter:\n${lines
      .slice(0, 8)
      .map((line) => `• ${line}`)
      .join("\n")}${lines.length > 8 ? `\n…and ${lines.length - 8} more` : ""}`;
    if (
      await deliver(
        late.map((entry) => entry.reminder),
        text,
        "included in a catch-up summary",
      )
    ) {
      report.summarized += late.length;
    }
  }
  return report;

  async function deliver(group: Reminder[], text: string, detail?: string): Promise<boolean> {
    let result: DeliveryResult;
    try {
      result = await delivery.send(text);
    } catch {
      result = { ok: false, reason: "error" };
    }
    if (result.ok) {
      try {
        await options.onDelivered?.(group, { channelId: result.channelId });
      } catch {
        // Context for replies is a convenience; it never changes what was delivered.
      }
    }
    for (const reminder of group) {
      if (result.ok) {
        await markSent(db, reminder.id, now, detail);
        report.sent++;
      } else if (result.reason === "blocked") {
        await markFailed(db, reminder.id, "could not deliver to the private Discord channel");
        report.failed++;
      } else if (reminder.attempts >= settings.maxAttempts) {
        await markFailed(
          db,
          reminder.id,
          `gave up after ${reminder.attempts} tries (${result.reason})`,
        );
        report.failed++;
      } else {
        await releaseUntil(
          db,
          reminder.id,
          new Date(now.getTime() + retryDelayMs(reminder.attempts, settings, result.retryAfterMs)),
          { countAttempt: true, detail: `retrying: ${result.reason}` },
        );
        report.retrying++;
      }
    }
    return result.ok;
  }
}
