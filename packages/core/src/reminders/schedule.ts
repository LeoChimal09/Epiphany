import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { events, tasks, type CalendarEvent, type Task } from "../db/schema";
import { addDays, dateKeyOf, localWallToUtc, parseTimeOfDay, weekdayOf } from "../planning/time";
import { maxLatenessMs, type ReminderSettings } from "./policy";
import { cancelObsoleteReminders, cancelOtherReminders, scheduleReminder } from "./store";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DATE_ONLY_REMINDER_MINUTE = 9 * 60;
const MAJOR_DEADLINE_LEADS_HOURS = [14 * 24, 7 * 24, 3 * 24] as const;

// A date-only deadline means the end of that local day, not midnight UTC.
export function effectiveDue(task: Task, timezone: string): Date | null {
  if (!task.dueAt) return null;
  if (!task.dueDateOnly) return task.dueAt;
  return localWallToUtc(task.dueAt.toISOString().slice(0, 10), 23 * 60 + 59, timezone);
}

const clean = (title: string) => title.replace(/\s+/g, " ").trim().slice(0, 120);

function leadWords(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "tomorrow" : `in ${days} days`;
  }
  return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
}

function dueClock(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(at)
    .replace(/\u202f/g, " ");
}

function dayDistance(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * HOUR);
}

function dateOnlyDuePhrase(reminderDay: string, dueDay: string): string {
  const days = dayDistance(reminderDay, dueDay);
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days} days`;
}

export interface SyncReport {
  created: number;
  canceled: number;
}

// Makes the reminder jobs match the records: deadline reminders ahead of every open task that has
// one, and reminders before (and a "still going?" check after the start of) upcoming events. It is
// idempotent, because every job has a dedupe key built from the subject and its time, so running it
// at every cycle creates only what is new. When a deadline moves, the old jobs are canceled and new
// ones created; finished or canceled work has its pending jobs canceled.
export async function syncReminders(options: {
  db: Database;
  ownerId: string;
  now: Date;
  timezone: string;
  settings: ReminderSettings;
  horizonDays?: number;
}): Promise<SyncReport> {
  const { db, ownerId, now, timezone, settings } = options;
  const horizonDays = options.horizonDays ?? 14;
  const horizon = new Date(now.getTime() + horizonDays * 24 * HOUR);
  const majorHorizon = new Date(
    now.getTime() +
      Math.max(horizonDays * 24, ...MAJOR_DEADLINE_LEADS_HOURS) * HOUR +
      settings.catchUpHours * HOUR,
  );
  const earliest = new Date(now.getTime() - settings.catchUpHours * HOUR);
  const today = dateKeyOf(now, timezone);
  const report: SyncReport = { created: 0, canceled: 0 };

  report.canceled += await cancelObsoleteReminders(db, ownerId);

  const openTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.ownerId, ownerId), eq(tasks.status, "open"), isNull(tasks.archivedAt)));

  for (const task of openTasks) {
    const due = effectiveDue(task, timezone);
    if (!due || due.getTime() > (task.priority === "major" ? majorHorizon : horizon).getTime())
      continue;
    const priorityLabel = task.priority === "major" ? "Major deadline: " : "";
    const deadlineLeads =
      task.priority === "major"
        ? [...new Set([...MAJOR_DEADLINE_LEADS_HOURS, ...settings.deadlineLeadHours])].toSorted(
            (a, b) => b - a,
          )
        : settings.deadlineLeadHours;
    const keep: string[] = [];
    if (task.dueDateOnly) {
      const dueDay = task.dueAt!.toISOString().slice(0, 10);
      const reminderDays = new Set(
        deadlineLeads.map((lead) => dateKeyOf(new Date(due.getTime() - lead * HOUR), timezone)),
      );
      for (const day of reminderDays) {
        const key = `task:${task.id}:date:${day}:${due.getTime()}`;
        const morning = localWallToUtc(day, DATE_ONLY_REMINDER_MINUTE, timezone);
        const at = day === today && morning.getTime() < now.getTime() ? now : morning;
        if (at.getTime() < earliest.getTime()) continue;
        keep.push(key);
        if (
          await scheduleReminder(db, ownerId, {
            kind: "task_deadline",
            subjectType: "task",
            subjectId: task.id,
            dedupeKey: key,
            dueAt: at,
            message: `Heads up: ${priorityLabel}"${clean(task.title)}" is ${dateOnlyDuePhrase(day, dueDay)} (${dueClock(due, timezone)}). Tell me when you've finished, or mark it done on the dashboard. No reply leaves it open.`,
          })
        ) {
          report.created++;
        }
      }
    } else {
      for (const lead of deadlineLeads) {
        const at = new Date(due.getTime() - lead * HOUR);
        const key = `task:${task.id}:lead${lead}h:${due.getTime()}`;
        // A reminder whose moment passed longer ago than a deadline reminder stays useful is not made.
        if (at.getTime() < earliest.getTime()) continue;
        keep.push(key);
        if (
          await scheduleReminder(db, ownerId, {
            kind: "task_deadline",
            subjectType: "task",
            subjectId: task.id,
            dedupeKey: key,
            dueAt: at,
            message: `Heads up: ${priorityLabel}"${clean(task.title)}" is due ${leadWords(lead)} (${dueClock(due, timezone)}). Tell me when you've finished, or mark it done on the dashboard. No reply leaves it open.`,
          })
        ) {
          report.created++;
        }
      }
    }
    report.canceled += await cancelOtherReminders(
      db,
      ownerId,
      "task",
      task.id,
      keep,
      "deadline changed",
    );
  }

  const upcoming: CalendarEvent[] = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.ownerId, ownerId),
        eq(events.status, "scheduled"),
        gt(events.startsAt, earliest),
        lte(events.startsAt, horizon),
      ),
    );

  for (const event of upcoming) {
    const keep: string[] = [];
    if (event.allDay) {
      const eventDay = dateKeyOf(event.startsAt, event.timezone);
      const key = `event:${event.id}:all-day:${event.startsAt.getTime()}`;
      const morning = localWallToUtc(eventDay, DATE_ONLY_REMINDER_MINUTE, timezone);
      const at = morning.getTime() < now.getTime() ? now : morning;
      keep.push(key);
      if (
        await scheduleReminder(db, ownerId, {
          kind: "event",
          subjectType: "event",
          subjectId: event.id,
          dedupeKey: key,
          dueAt: at,
          message: `You have "${clean(event.title)}" on your calendar today (${eventDay}).`,
        })
      ) {
        report.created++;
      }
      report.canceled += await cancelOtherReminders(
        db,
        ownerId,
        "event",
        event.id,
        keep,
        "event time changed",
      );
      continue;
    }
    const lead = settings.eventLeadMinutes;
    const before = new Date(event.startsAt.getTime() - lead * MINUTE);
    const beforeKey = `event:${event.id}:lead${lead}m:${event.startsAt.getTime()}`;
    const checkAt = new Date(event.startsAt.getTime() + 30 * MINUTE);
    const checkKey = `event:${event.id}:still-going:${event.startsAt.getTime()}`;
    keep.push(beforeKey, checkKey);

    if (
      await scheduleReminder(db, ownerId, {
        kind: "event",
        subjectType: "event",
        subjectId: event.id,
        dedupeKey: beforeKey,
        dueAt: before,
        message: `"${clean(event.title)}" starts in ${lead} minutes (${dueClock(event.startsAt, timezone)}).`,
      })
    ) {
      report.created++;
    }
    if (
      event.endsAt.getTime() > checkAt.getTime() &&
      (await scheduleReminder(db, ownerId, {
        kind: "check_in",
        subjectType: "event",
        subjectId: event.id,
        dedupeKey: checkKey,
        dueAt: checkAt,
        message: `Still going with "${clean(event.title)}"? Tell me if you're done or want to replan.`,
      }))
    ) {
      report.created++;
    }
    report.canceled += await cancelOtherReminders(
      db,
      ownerId,
      "event",
      event.id,
      keep,
      "event time changed",
    );
  }

  report.created += await syncDailyReminders({ db, ownerId, now, timezone, settings });
  return report;
}

// The morning briefing and the owner's routines (bedtime wind-down, a recurring workout, hourly
// awareness prompts) for today and tomorrow. Nothing is made for a moment that is already too far
// in the past to matter, and every job has a dedupe key, so repeating this creates nothing new.
async function syncDailyReminders(options: {
  db: Database;
  ownerId: string;
  now: Date;
  timezone: string;
  settings: ReminderSettings;
}): Promise<number> {
  const { db, ownerId, now, timezone, settings } = options;
  const today = dateKeyOf(now, timezone);
  let created = 0;

  async function plan(
    kind: "briefing" | "wind_down" | "check_in",
    key: string,
    time: string,
    dedupeKey: string,
    message: string,
  ) {
    const at = localWallToUtc(key, parseTimeOfDay(time), timezone);
    if (at.getTime() + maxLatenessMs(kind, settings) <= now.getTime()) return;
    if (await scheduleReminder(db, ownerId, { kind, dedupeKey, dueAt: at, message })) created++;
  }

  for (const offset of [0, 1]) {
    const key = addDays(today, offset);
    const { briefingTime, routines } = settings;
    if (briefingTime) {
      await plan(
        "briefing",
        key,
        briefingTime,
        `briefing:${key}`,
        "Good morning! Here is your day.",
      );
    }
    if (routines.bedtime) {
      await plan(
        "wind_down",
        key,
        routines.bedtime,
        `routine:bedtime:${key}`,
        "It's getting close to bedtime. Want to wrap up and wind down for the night?",
      );
    }
    const workout = routines.workout;
    if (workout && workout.days.includes(weekdayOf(key))) {
      await plan(
        "check_in",
        key,
        workout.time,
        `routine:workout:${key}`,
        `Time for your ${workout.label}. Want to start now, or move it?`,
      );
    }
    const awareness = routines.awareness;
    if (awareness) {
      const end = parseTimeOfDay(awareness.to);
      for (
        let minutes = parseTimeOfDay(awareness.from);
        minutes <= end;
        minutes += awareness.everyHours * 60
      ) {
        const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
        await plan(
          "check_in",
          key,
          time,
          `routine:awareness:${key}:${time}`,
          "Quick check-in: what are you working on right now?",
        );
      }
    }
  }
  return created;
}
