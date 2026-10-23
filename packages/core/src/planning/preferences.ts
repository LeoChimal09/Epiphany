import type { Preference } from "../db/schema";
import { z } from "zod";
import { parseTimeOfDay, WEEKDAYS, type Weekday } from "./time";
import type { PlanningPreferences, TimeWindow } from "./availability";

const windowSchema = z
  .object({ start: z.string(), end: z.string() })
  .strict()
  .refine((value) => validWindow(value) !== null, "Use valid, different start and end times.");
const daytimeSchema = windowSchema.refine(
  (value) =>
    validWindow(value) !== null &&
    parseTimeOfDay(value.end, { allow24: true }) > parseTimeOfDay(value.start),
  "Preferred hours must end after they start. Split overnight hours across two days.",
);
const weekdaySchema = z.enum(WEEKDAYS);
const protectedSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    weekdays: z.array(weekdaySchema).min(1).max(7),
    window: windowSchema,
  })
  .strict();
const settingSchemas = {
  "planning.preferred_hours": z.partialRecord(weekdaySchema, z.array(daytimeSchema).max(8)),
  "planning.sleep": windowSchema.nullable(),
  "planning.meals": z.array(windowSchema).max(8),
  "planning.protected_time": z.array(protectedSchema).max(30),
  "planning.buffer_minutes": z.number().int().min(0).max(120),
  "planning.min_block_minutes": z.number().int().min(10).max(240),
  "planning.travel_before_minutes": z.number().int().min(0).max(240),
  "planning.travel_after_minutes": z.number().int().min(0).max(240),
};
export type PlanningSettingKey = keyof typeof settingSchemas;

export function validatePlanningSetting(key: unknown, value: unknown) {
  if (typeof key !== "string" || !Object.hasOwn(settingSchemas, key)) {
    throw new RangeError("Unknown planning setting.");
  }
  return settingSchemas[key as PlanningSettingKey].parse(value);
}

// When the owner has set nothing, work is only planned after school/work hours on weekdays and in
// the daytime on weekends, never overnight or at meals. These are defaults, not facts about the
// owner: they are replaced by the owner's own `planning.*` preferences.
export function defaultPlanningPreferences(timezone: string): PlanningPreferences {
  const weekday: TimeWindow[] = [{ start: "15:00", end: "21:00" }];
  const weekend: TimeWindow[] = [{ start: "10:00", end: "18:00" }];
  return {
    timezone,
    preferredHours: {
      mon: weekday,
      tue: weekday,
      wed: weekday,
      thu: weekday,
      fri: weekday,
      sat: weekend,
      sun: weekend,
    },
    sleep: { start: "23:00", end: "07:00" },
    meals: [
      { start: "12:00", end: "13:00" },
      { start: "18:00", end: "19:00" },
    ],
    bufferMinutes: 10,
    minBlockMinutes: 30,
  };
}

function validWindow(value: unknown): TimeWindow | null {
  if (!value || typeof value !== "object") return null;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (typeof start !== "string" || typeof end !== "string") return null;
  try {
    parseTimeOfDay(start);
    parseTimeOfDay(end, { allow24: true });
  } catch {
    return null;
  }
  return start === end ? null : { start, end };
}

// Reads `planning.preferred_hours` ({ mon: [{start, end}], ... }), `planning.sleep`,
// `planning.meals`, `planning.buffer_minutes`, and `planning.min_block_minutes` from the owner's
// confirmed preferences. Anything invalid is ignored in favor of the default.
export function parsePlanningPreferences(
  preferences: readonly Preference[],
  timezone: string,
): PlanningPreferences {
  const result = defaultPlanningPreferences(timezone);
  for (const preference of preferences) {
    if (preference.status !== "confirmed") continue;
    const value = preference.value as unknown;
    switch (preference.key) {
      case "planning.preferred_hours": {
        if (!value || typeof value !== "object") break;
        const hours: Partial<Record<Weekday, TimeWindow[]>> = {};
        for (const day of WEEKDAYS) {
          const raw = (value as Record<string, unknown>)[day];
          if (!Array.isArray(raw)) continue;
          hours[day] = raw.flatMap((window) => {
            const parsed = daytimeSchema.safeParse(window);
            return parsed.success ? [parsed.data] : [];
          });
        }
        result.preferredHours = hours;
        break;
      }
      case "planning.sleep": {
        if (value === null) {
          result.sleep = undefined;
          break;
        }
        const window = validWindow(value);
        if (window) result.sleep = window;
        break;
      }
      case "planning.meals":
        if (Array.isArray(value)) {
          result.meals = value.map(validWindow).filter((w): w is TimeWindow => w !== null);
        }
        break;
      case "planning.protected_time": {
        const parsed = settingSchemas["planning.protected_time"].safeParse(value);
        if (parsed.success) result.protectedTime = parsed.data;
        break;
      }
      case "planning.buffer_minutes":
        if (typeof value === "number" && value >= 0 && value <= 120) {
          result.bufferMinutes = Math.round(value);
        }
        break;
      case "planning.min_block_minutes":
        if (typeof value === "number" && value >= 10 && value <= 240) {
          result.minBlockMinutes = Math.round(value);
        }
        break;
      case "planning.travel_before_minutes":
      case "planning.travel_after_minutes":
        if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 240) {
          if (preference.key === "planning.travel_before_minutes")
            result.travelBeforeMinutes = Math.round(value);
          else result.travelAfterMinutes = Math.round(value);
        }
        break;
    }
  }
  return result;
}
