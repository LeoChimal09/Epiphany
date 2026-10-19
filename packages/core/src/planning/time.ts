// Timezone-aware calendar math. Local "wall" times are converted to instants with explicit
// daylight-saving rules so fixed appointments never shift silently.

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// A local calendar date as YYYY-MM-DD.
export type DateKey = string;

const DAY_MS = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY = /^(\d{2}):(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(instant: Date, timezone: string): LocalParts {
  const parts: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type in parts) parts[part.type as keyof LocalParts] = Number(part.value);
  }
  parts.hour %= 24;
  return parts;
}

// Local wall-clock time minus UTC, in milliseconds, at the given instant.
export function zoneOffsetMs(instantMs: number, timezone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const p = localParts(new Date(whole), timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function formatDateKey(ms: number): DateKey {
  const date = new Date(ms);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function parseDateKey(key: DateKey): { year: number; month: number; day: number } {
  const match = DATE_KEY.exec(key);
  if (!match) throw new RangeError(`Invalid date "${key}"; expected YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar date "${key}".`);
  }
  return { year, month, day };
}

export function addDays(key: DateKey, days: number): DateKey {
  const { year, month, day } = parseDateKey(key);
  return formatDateKey(Date.UTC(year, month - 1, day) + days * DAY_MS);
}

// Whole calendar days from a to b (negative when b is earlier).
export function daysBetween(a: DateKey, b: DateKey): number {
  const first = parseDateKey(a);
  const second = parseDateKey(b);
  return Math.round(
    (Date.UTC(second.year, second.month - 1, second.day) -
      Date.UTC(first.year, first.month - 1, first.day)) /
      DAY_MS,
  );
}

export function weekdayOf(key: DateKey): Weekday {
  const { year, month, day } = parseDateKey(key);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] as Weekday;
}

export function dateKeyOf(instant: Date, timezone: string): DateKey {
  const p = localParts(instant, timezone);
  return formatDateKey(Date.UTC(p.year, p.month - 1, p.day));
}

// "HH:MM" to minutes after local midnight. "24:00" is only valid as an end time.
export function parseTimeOfDay(value: string, options: { allow24?: boolean } = {}): number {
  const match = TIME_OF_DAY.exec(value);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 24 && minutes < 60) return hours * 60 + minutes;
    if (options.allow24 && hours === 24 && minutes === 0) return 1440;
  }
  throw new RangeError(`Invalid time "${value}"; expected HH:MM.`);
}

// Converts a local date and minutes-after-midnight to an instant. A time skipped by a
// spring-forward gap moves forward by the gap; a repeated fall-back time uses its first
// occurrence.
export function localWallToUtc(date: DateKey, minutes: number, timezone: string): Date {
  const { year, month, day } = parseDateKey(date);
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const before = zoneOffsetMs(wall - DAY_MS, timezone);
  const after = zoneOffsetMs(wall + DAY_MS, timezone);
  const valid = [wall - before, wall - after]
    .filter((candidate) => zoneOffsetMs(candidate, timezone) === wall - candidate)
    .toSorted((first, second) => first - second);
  const [earliest] = valid;
  return new Date(earliest ?? wall - before);
}
