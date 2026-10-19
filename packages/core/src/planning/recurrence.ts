import {
  addDays,
  daysBetween,
  localWallToUtc,
  parseDateKey,
  parseTimeOfDay,
  weekdayOf,
  WEEKDAYS,
  type DateKey,
  type Weekday,
} from "./time";
import type { FixedEvent } from "./availability";

export type SeriesException =
  | { date: DateKey; kind: "skipped" }
  | { date: DateKey; kind: "moved"; startsAt: Date; endsAt: Date };

// A recurring event. Its wall-clock time is fixed in the series timezone, so a 09:00 class
// stays at 09:00 local across daylight-saving changes (the instant moves, the wall time does not).
export interface EventSeries {
  id: string;
  title: string;
  timezone: string;
  startDate: DateKey;
  startTime: string;
  durationMinutes: number;
  frequency: "daily" | "weekly";
  interval: number;
  weekdays?: Weekday[];
  until?: DateKey;
  // Total occurrences from startDate, counting skipped ones.
  count?: number;
  blocking?: boolean;
  travelBeforeMinutes?: number;
  travelAfterMinutes?: number;
  exceptions: SeriesException[];
}

const MAX_SCAN_DAYS = 366 * 30;

export function validateSeries(series: EventSeries): void {
  parseDateKey(series.startDate);
  parseTimeOfDay(series.startTime);
  if (!Number.isInteger(series.interval) || series.interval < 1) {
    throw new RangeError("Recurrence interval must be a whole number of at least 1.");
  }
  if (!Number.isInteger(series.durationMinutes) || series.durationMinutes < 1) {
    throw new RangeError("Event duration must be at least one minute.");
  }
  if (series.until !== undefined) {
    parseDateKey(series.until);
    if (series.until < series.startDate) throw new RangeError("Series ends before it starts.");
  }
  if (series.count !== undefined && (!Number.isInteger(series.count) || series.count < 1)) {
    throw new RangeError("Recurrence count must be a whole number of at least 1.");
  }
  for (const day of series.weekdays ?? []) {
    if (!WEEKDAYS.includes(day)) throw new RangeError(`Unknown weekday "${day}".`);
  }
}

function mondayOf(key: DateKey): DateKey {
  return addDays(key, -((WEEKDAYS.indexOf(weekdayOf(key)) + 6) % 7));
}

function matches(series: EventSeries, date: DateKey, anchorMonday: DateKey): boolean {
  if (series.frequency === "daily")
    return daysBetween(series.startDate, date) % series.interval === 0;
  const days = series.weekdays?.length ? series.weekdays : [weekdayOf(series.startDate)];
  if (!days.includes(weekdayOf(date))) return false;
  return Math.floor(daysBetween(anchorMonday, date) / 7) % series.interval === 0;
}

// Local dates, in the series timezone, that the rule generates from `from` through `to` inclusive.
export function occurrenceDates(series: EventSeries, from: DateKey, to: DateKey): DateKey[] {
  validateSeries(series);
  const last = series.until !== undefined && series.until < to ? series.until : to;
  const first = series.count === undefined && from > series.startDate ? from : series.startDate;
  if (daysBetween(first, last) > MAX_SCAN_DAYS) {
    throw new RangeError("Recurrence range is too large to expand.");
  }
  const anchorMonday = mondayOf(series.startDate);
  const dates: DateKey[] = [];
  let produced = series.count === undefined ? Infinity : 0;
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (!matches(series, date, anchorMonday)) continue;
    if (series.count !== undefined) {
      produced += 1;
      if (produced > series.count) break;
    }
    if (date >= from) dates.push(date);
  }
  return dates;
}

function expandOne(series: EventSeries, date: DateKey): FixedEvent[] {
  const exception = series.exceptions.find((item) => item.date === date);
  if (exception?.kind === "skipped") return [];
  const common = {
    id: `${series.id}@${date}`,
    title: series.title,
    allDay: false,
    timezone: series.timezone,
    status: "scheduled" as const,
    blocking: series.blocking,
    travelBeforeMinutes: series.travelBeforeMinutes,
    travelAfterMinutes: series.travelAfterMinutes,
  };
  if (exception?.kind === "moved") {
    return [{ ...common, startsAt: exception.startsAt, endsAt: exception.endsAt }];
  }
  const startsAt = localWallToUtc(date, parseTimeOfDay(series.startTime), series.timezone);
  return [
    { ...common, startsAt, endsAt: new Date(startsAt.getTime() + series.durationMinutes * 60_000) },
  ];
}

// Concrete events overlapping [rangeStart, rangeEnd), with skipped and moved occurrences applied.
export function expandSeries(series: EventSeries, rangeStart: Date, rangeEnd: Date): FixedEvent[] {
  // Pad by a day each way so zone offsets and moved occurrences near the edges are not lost.
  const from = addDays(isoDate(rangeStart), -2);
  const to = addDays(isoDate(rangeEnd), 2);
  const events = [
    ...occurrenceDates(series, from, to).flatMap((date) => expandOne(series, date)),
    // A moved occurrence can originate on a date the padded scan did not generate.
    ...series.exceptions
      .filter((item) => item.kind === "moved" && (item.date < from || item.date > to))
      .flatMap((item) => expandOne(series, item.date)),
  ];
  return events.filter((event) => event.startsAt < rangeEnd && event.endsAt > rangeStart);
}

function isoDate(instant: Date): DateKey {
  return instant.toISOString().slice(0, 10);
}

function requireOccurrence(series: EventSeries, date: DateKey): void {
  if (occurrenceDates(series, date, date).length !== 1) {
    throw new RangeError(`${date} is not an occurrence of this series.`);
  }
}

function withException(series: EventSeries, exception: SeriesException): EventSeries {
  return {
    ...series,
    exceptions: [...series.exceptions.filter((item) => item.date !== exception.date), exception],
  };
}

// Occurrence scope: only that day changes; the series keeps its rule.
export function skipOccurrence(series: EventSeries, date: DateKey): EventSeries {
  requireOccurrence(series, date);
  return withException(series, { date, kind: "skipped" });
}

export function moveOccurrence(
  series: EventSeries,
  date: DateKey,
  startsAt: Date,
  endsAt: Date,
): EventSeries {
  requireOccurrence(series, date);
  if (!(endsAt > startsAt)) throw new RangeError("A moved occurrence must end after it starts.");
  return withException(series, { date, kind: "moved", startsAt, endsAt });
}

export type SeriesChanges = Partial<
  Pick<
    EventSeries,
    | "title"
    | "startTime"
    | "durationMinutes"
    | "weekdays"
    | "interval"
    | "blocking"
    | "travelBeforeMinutes"
    | "travelAfterMinutes"
  >
>;

// "This and following" scope. The original series ends the day before `fromDate`; a new series
// carries the changes forward. Earlier occurrences and their exceptions are left untouched.
// `earlier` is null when nothing precedes `fromDate`.
export function splitSeriesFrom(
  series: EventSeries,
  fromDate: DateKey,
  newId: string,
  changes: SeriesChanges,
): { earlier: EventSeries | null; following: EventSeries } {
  // One full recurrence cycle is always enough to reach the next occurrence.
  const cycleEnd = addDays(fromDate, series.interval * 7 + 7);
  const [firstFollowing] = occurrenceDates(series, fromDate, cycleEnd);
  if (!firstFollowing) throw new RangeError(`No occurrences on or after ${fromDate}.`);

  const earlierCount =
    daysBetween(series.startDate, fromDate) > 0
      ? occurrenceDates(series, series.startDate, addDays(fromDate, -1)).length
      : 0;
  const remaining = series.count === undefined ? undefined : series.count - earlierCount;

  const earlier: EventSeries | null =
    earlierCount > 0
      ? {
          ...series,
          until: addDays(fromDate, -1),
          count: undefined,
          exceptions: series.exceptions.filter((item) => item.date < fromDate),
        }
      : null;

  // Keep the original phase unless the owner changed the rule's shape.
  const reshaped = changes.weekdays !== undefined || changes.interval !== undefined;
  const following: EventSeries = {
    ...series,
    ...changes,
    id: newId,
    startDate: reshaped ? fromDate : firstFollowing,
    count: remaining,
    exceptions: [],
  };
  if (series.frequency === "weekly") {
    following.weekdays = changes.weekdays ?? series.weekdays ?? [weekdayOf(series.startDate)];
  }
  following.exceptions = series.exceptions.filter(
    (item) =>
      item.date >= fromDate && occurrenceDates(following, item.date, item.date).length === 1,
  );
  validateSeries(following);
  return { earlier, following };
}
