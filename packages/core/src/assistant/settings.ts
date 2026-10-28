import { z } from "zod";
import { splitReminderSchema } from "../reminders/policy";

// The preferences a conversation may change. Each has a strict shape so a misheard value is
// refused instead of stored, and the owner can only set things Epi actually uses.
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const window = z
  .object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/),
  })
  .strict()
  .refine((w) => w.start !== w.end, "empty window");
const weekday = z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

const SCHEMAS = {
  "reminders.quiet_hours": z
    .object({ start: time, end: time })
    .strict()
    .refine((w) => w.start !== w.end)
    .nullable(),
  "reminders.briefing_time": time.nullable(),
  "reminders.daily_limit": z.number().int().min(1).max(100),
  "reminders.event_lead_minutes": z.number().int().min(1).max(1440),
  "reminders.deadline_lead_hours": z.array(z.number().int().min(1).max(336)).min(1).max(5),
  "reminders.split": splitReminderSchema,
  "routine.bedtime": z.object({ time }).strict(),
  "routine.workout": z
    .object({
      days: z.array(weekday).min(1),
      time,
      label: z.string().trim().min(1).max(60).optional(),
    })
    .strict(),
  "routine.awareness": z
    .object({ from: time, to: time, everyHours: z.number().int().min(1).max(12).optional() })
    .strict()
    .refine((w) => w.from < w.to),
  "planning.preferred_hours": z.record(weekday, z.array(window).max(4)),
  "planning.sleep": window,
  "planning.meals": z.array(window).max(6),
  "tracking.enabled": z.boolean(),
  "tracking.paused": z.boolean(),
  "voice.replies": z.boolean(),
  "planning.buffer_minutes": z.number().min(0).max(120),
  "planning.min_block_minutes": z.number().min(10).max(240),
} as const;

export type SettableKey = keyof typeof SCHEMAS;
export const SETTABLE_KEYS = Object.keys(SCHEMAS) as SettableKey[];

export function isSettableKey(key: string): key is SettableKey {
  return Object.hasOwn(SCHEMAS, key);
}

// Returns the validated value, or null when it is not an acceptable value for that setting.
export function parseSettingValue(key: SettableKey, raw: string): { value: unknown } | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = SCHEMAS[key].safeParse(json);
  // "Off" is stored as false: a JSON column cannot hold an SQL NULL, and false reads clearly.
  return parsed.success ? { value: parsed.data === null ? false : parsed.data } : null;
}

// Raising how much Epi may notify the owner, or starting to learn from their habits, expands what it
// may do, so it needs a clear yes first.
export function needsConsent(key: SettableKey, value: unknown, current: unknown): boolean {
  // Turning learning from the owner's habits on also needs a clear yes.
  if (key === "tracking.enabled") return value === true && current !== true;
  if (key === "reminders.split") {
    const before = splitReminderSchema.safeParse(current);
    const after = splitReminderSchema.parse(value);
    return (
      after.enabled && (!before.success || !before.data.enabled || after.count > before.data.count)
    );
  }
  if (key !== "reminders.daily_limit") return false;
  const before = typeof current === "number" ? current : 12;
  return typeof value === "number" && value > before;
}
