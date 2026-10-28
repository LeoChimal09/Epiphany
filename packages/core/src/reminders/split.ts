import { addDays, dateKeyOf, localWallToUtc, parseTimeOfDay } from "../planning/time";
import type { ReminderSettings } from "./policy";

export function splitReminderWindow(
  due: Date,
  createdAt: Date,
  timezone: string,
  settings: ReminderSettings,
): { start: Date; end: Date } | null {
  const morning = parseTimeOfDay(settings.briefingTime ?? "08:00");
  let day = dateKeyOf(due, timezone);
  if (due <= localWallToUtc(day, morning, timezone)) day = addDays(day, -1);
  let start = Math.max(localWallToUtc(day, morning, timezone).getTime(), createdAt.getTime());
  let end = Math.min(due.getTime(), localWallToUtc(addDays(day, 1), 0, timezone).getTime());
  const windows = [
    settings.quietHours,
    settings.sleepHours,
    settings.routines.bedtime
      ? { start: settings.routines.bedtime, end: settings.briefingTime ?? "08:00" }
      : null,
  ].filter((window) => window !== null);
  const protectedTimes = [-1, 0, 1]
    .flatMap((offset) =>
      windows.map((window) => {
        const date = addDays(day, offset);
        const from = parseTimeOfDay(window.start);
        const to = parseTimeOfDay(window.end, { allow24: true });
        return {
          start: localWallToUtc(date, from, timezone).getTime(),
          end: localWallToUtc(addDays(date, to <= from ? 1 : 0), to, timezone).getTime(),
        };
      }),
    )
    .sort((a, b) => a.start - b.start);
  for (const window of protectedTimes) {
    if (window.end <= start) continue;
    if (window.start <= start) start = window.end;
    else end = Math.min(end, window.start);
  }
  return start < end ? { start: new Date(start), end: new Date(end) } : null;
}

export function splitReminderTimes(start: Date, end: Date, count: number): Date[] {
  // Two reminders use 2/4 and 3/4; five use 2/7 through 6/7 of the usable window.
  return [
    ...new Set(
      Array.from(
        { length: count },
        (_, index) =>
          Math.floor(
            (start.getTime() + ((end.getTime() - start.getTime()) * (index + 2)) / (count + 2)) /
              60_000,
          ) * 60_000,
      ),
    ),
  ]
    .filter((at) => at > start.getTime() && at < end.getTime())
    .map((at) => new Date(at));
}
