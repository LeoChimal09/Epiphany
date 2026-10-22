import {
  WEEKDAYS,
  addDays,
  dateKeyOf,
  localParts,
  localWallToUtc,
  parseTimeOfDay,
  type Weekday,
} from "../planning/time";
import type { Preference } from "../db/schema";

// Reminder behavior the owner can change. Defaults (chosen for Goal 15, see docs/reminders.md):
// a time-sensitive reminder (an event, a check-in, a wind-down) is only worth sending for 30
// minutes after it was due; a deadline or custom reminder stays worth sending for 24 hours;
// at most 12 ordinary reminders a day; quiet hours are off until the owner sets them.
export interface RoutineSettings {
  // Daily bedtime wind-down prompt, "HH:MM".
  bedtime: string | null;
  // A recurring activity on chosen weekdays.
  workout: { days: Weekday[]; time: string; label: string } | null;
  // Hourly awareness prompts between two times.
  awareness: { from: string; to: string; everyHours: number } | null;
}

export interface ReminderSettings {
  paused: boolean;
  // Local time of the morning briefing, or null for none.
  briefingTime: string | null;
  routines: RoutineSettings;
  quietHours: { start: string; end: string } | null;
  graceMinutes: number;
  catchUpHours: number;
  dailyLimit: number;
  maxAttempts: number;
  backoffMinutes: number[];
  deadlineLeadHours: number[];
  eventLeadMinutes: number;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  paused: false,
  briefingTime: "08:00",
  routines: { bedtime: null, workout: null, awareness: null },
  quietHours: null,
  graceMinutes: 30,
  catchUpHours: 24,
  dailyLimit: 12,
  maxAttempts: 4,
  backoffMinutes: [1, 5, 15],
  deadlineLeadHours: [24, 2, 1],
  eventLeadMinutes: 30,
};

const TIME = /^\d{2}:\d{2}$/;

function validTime(value: string): boolean {
  try {
    parseTimeOfDay(value);
    return true;
  } catch {
    return false;
  }
}

const number = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : null;

// Reads settings from the owner's confirmed preferences. Anything missing or invalid falls back to
// the default, so a bad value can never stop reminders from working.
export function parseReminderSettings(
  preferences: readonly Preference[],
  now: Date = new Date(),
): ReminderSettings {
  const settings: ReminderSettings = {
    ...DEFAULT_REMINDER_SETTINGS,
    routines: { bedtime: null, workout: null, awareness: null },
    backoffMinutes: [...DEFAULT_REMINDER_SETTINGS.backoffMinutes],
    deadlineLeadHours: [...DEFAULT_REMINDER_SETTINGS.deadlineLeadHours],
  };
  for (const preference of preferences) {
    if (preference.status !== "confirmed") continue;
    const value = preference.value as unknown;
    switch (preference.key) {
      case "reminders.paused":
        if (typeof value === "boolean") settings.paused = value;
        break;
      case "reminders.paused_until":
        // A pause that ends by itself: "Pause reminders for two hours".
        if (typeof value === "string" && new Date(value).getTime() > now.getTime()) {
          settings.paused = true;
        }
        break;
      case "reminders.briefing_time":
        if (value === null || value === false) settings.briefingTime = null;
        else if (typeof value === "string" && TIME.test(value) && validTime(value)) {
          settings.briefingTime = value;
        }
        break;
      case "routine.bedtime": {
        const time = (value as { time?: unknown } | null)?.time;
        if (typeof time === "string" && TIME.test(time) && validTime(time)) {
          settings.routines.bedtime = time;
        }
        break;
      }
      case "routine.workout": {
        const { days, time, label } = (value ?? {}) as {
          days?: unknown;
          time?: unknown;
          label?: unknown;
        };
        if (Array.isArray(days) && typeof time === "string" && TIME.test(time) && validTime(time)) {
          const valid = days.filter((day): day is Weekday => WEEKDAYS.includes(day as Weekday));
          if (valid.length > 0) {
            settings.routines.workout = {
              days: valid,
              time,
              label:
                typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : "workout",
            };
          }
        }
        break;
      }
      case "routine.awareness": {
        const { from, to, everyHours } = (value ?? {}) as {
          from?: unknown;
          to?: unknown;
          everyHours?: unknown;
        };
        const every = number(everyHours ?? 1, 1, 12);
        if (
          typeof from === "string" &&
          typeof to === "string" &&
          TIME.test(from) &&
          TIME.test(to) &&
          validTime(from) &&
          validTime(to) &&
          every !== null &&
          from < to
        ) {
          settings.routines.awareness = { from, to, everyHours: every };
        }
        break;
      }
      case "reminders.quiet_hours": {
        if (value === null || value === false) settings.quietHours = null;
        else if (value && typeof value === "object") {
          const { start, end } = value as { start?: unknown; end?: unknown };
          if (
            typeof start === "string" &&
            typeof end === "string" &&
            TIME.test(start) &&
            TIME.test(end)
          ) {
            try {
              parseTimeOfDay(start);
              parseTimeOfDay(end);
              if (start !== end) settings.quietHours = { start, end };
            } catch {
              // An invalid time leaves quiet hours unchanged.
            }
          }
        }
        break;
      }
      case "reminders.grace_minutes":
        settings.graceMinutes = number(value, 1, 24 * 60) ?? settings.graceMinutes;
        break;
      case "reminders.catch_up_hours":
        settings.catchUpHours = number(value, 1, 24 * 7) ?? settings.catchUpHours;
        break;
      case "reminders.daily_limit":
        settings.dailyLimit = number(value, 1, 100) ?? settings.dailyLimit;
        break;
      case "reminders.deadline_lead_hours":
        if (Array.isArray(value)) {
          const leads = value
            .map((entry) => number(entry, 1, 24 * 14))
            .filter((entry): entry is number => entry !== null);
          if (leads.length > 0)
            settings.deadlineLeadHours = [...new Set(leads)].toSorted((a, b) => b - a).slice(0, 5);
        }
        break;
      case "reminders.event_lead_minutes":
        settings.eventLeadMinutes = number(value, 1, 24 * 60) ?? settings.eventLeadMinutes;
        break;
    }
  }
  return settings;
}

export function inQuietHours(
  now: Date,
  timezone: string,
  quiet: { start: string; end: string } | null,
): boolean {
  if (!quiet) return false;
  const parts = localParts(now, timezone);
  const minutes = parts.hour * 60 + parts.minute;
  const start = parseTimeOfDay(quiet.start);
  const end = parseTimeOfDay(quiet.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// The next moment quiet hours end, or now when they are not in effect.
export function quietHoursEnd(
  now: Date,
  timezone: string,
  quiet: { start: string; end: string } | null,
): Date {
  if (!quiet || !inQuietHours(now, timezone, quiet)) return now;
  const end = parseTimeOfDay(quiet.end);
  const today = dateKeyOf(now, timezone);
  const parts = localParts(now, timezone);
  const endToday = localWallToUtc(today, end, timezone);
  if (endToday.getTime() > now.getTime() && parts.hour * 60 + parts.minute < end) return endToday;
  return localWallToUtc(addDays(today, 1), end, timezone);
}

export interface DecisionInput {
  reminder: {
    kind: "task_deadline" | "event" | "check_in" | "briefing" | "wind_down" | "custom";
    urgency: "normal" | "high";
    dueAt: Date;
    hasSubject: boolean;
  };
  now: Date;
  timezone: string;
  settings: ReminderSettings;
  // Whether the task or event it is about still needs the reminder (open, not canceled or over).
  subjectActive: boolean;
  // Ordinary reminders already sent today.
  sentToday: number;
}

export type SkipReason = "paused" | "obsolete" | "stale" | "daily_limit";

export type Decision =
  | { action: "send"; late: boolean }
  | { action: "skip"; reason: SkipReason }
  | { action: "defer"; until: Date };

const LATE_MS = 5 * 60_000;
// A morning briefing sent after lunch is no longer a morning briefing.
const BRIEFING_GRACE_MS = 3 * 3_600_000;

// How long after its time a reminder is still worth sending.
export function maxLatenessMs(
  kind: DecisionInput["reminder"]["kind"],
  settings: ReminderSettings,
): number {
  if (kind === "briefing") return BRIEFING_GRACE_MS;
  return kind === "task_deadline" || kind === "custom"
    ? settings.catchUpHours * 3_600_000
    : settings.graceMinutes * 60_000;
}

// The single place that decides whether a due reminder is sent, held back, or dropped. A reminder
// that is no longer relevant, or far too late to help, is skipped rather than replayed: after an
// outage the owner gets what still matters, not every missed prompt.
export function decideDelivery(input: DecisionInput): Decision {
  const { reminder, now, timezone, settings } = input;
  if (settings.paused) return { action: "skip", reason: "paused" };
  if (reminder.hasSubject && !input.subjectActive) return { action: "skip", reason: "obsolete" };

  const latenessMs = now.getTime() - reminder.dueAt.getTime();
  const limit = maxLatenessMs(reminder.kind, settings);
  if (latenessMs > limit) return { action: "skip", reason: "stale" };

  if (reminder.urgency === "normal" && inQuietHours(now, timezone, settings.quietHours)) {
    const until = quietHoursEnd(now, timezone, settings.quietHours);
    // If waiting would make it too late to matter, drop it instead of sending it at the wrong time.
    if (until.getTime() - reminder.dueAt.getTime() > limit)
      return { action: "skip", reason: "stale" };
    return { action: "defer", until };
  }

  if (reminder.urgency === "normal" && input.sentToday >= settings.dailyLimit) {
    return { action: "skip", reason: "daily_limit" };
  }
  return { action: "send", late: latenessMs > LATE_MS };
}

// How long to wait before the next try after a failed delivery. A rate-limit answer from the
// service is honored when it asks for longer than the normal backoff.
export function retryDelayMs(
  attempts: number,
  settings: ReminderSettings,
  retryAfterMs?: number,
): number {
  const steps = settings.backoffMinutes;
  const base = (steps[Math.min(Math.max(attempts - 1, 0), steps.length - 1)] ?? 15) * 60_000;
  return Math.max(base, retryAfterMs ?? 0);
}
