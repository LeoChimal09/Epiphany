import { mergeSpans, subtractSpans, type Span } from "./spans";
import {
  addDays,
  dateKeyOf,
  localWallToUtc,
  parseDateKey,
  parseTimeOfDay,
  weekdayOf,
  type DateKey,
  type Weekday,
} from "./time";

// Structurally compatible with the events table rows.
export interface FixedEvent {
  id: string;
  title?: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timezone: string;
  status: "scheduled" | "canceled";
  // All-day events (birthdays, holidays) are informational unless this is true. Timed events
  // always block unless this is false.
  blocking?: boolean | undefined;
  travelBeforeMinutes?: number | undefined;
  travelAfterMinutes?: number | undefined;
}

export interface PlannedBlock {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: "planned" | "completed" | "removed";
}

// Local wall-clock window; `end` may be "24:00".
export interface TimeWindow {
  start: string;
  end: string;
}

export type ProtectedTime =
  | { label: string; weekdays?: Weekday[]; window: TimeWindow }
  | { label: string; startsAt: Date; endsAt: Date };

export interface PlanningPreferences {
  // The owner's current timezone. Preference windows are local to it; fixed events are instants
  // and keep their exact time when it changes.
  timezone: string;
  // Hours the owner is willing to plan work. A weekday with no windows is unusable, so an empty
  // calendar is not treated as free time.
  preferredHours: Partial<Record<Weekday, TimeWindow[]>>;
  // May cross midnight (for example 23:00 to 07:00).
  sleep?: TimeWindow | undefined;
  meals?: TimeWindow[] | undefined;
  protectedTime?: ProtectedTime[] | undefined;
  // Applied after travel on both sides of blocking events.
  bufferMinutes: number;
  travelBeforeMinutes?: number;
  travelAfterMinutes?: number;
  // Free windows shorter than this are discarded.
  minBlockMinutes: number;
}

export type BlockerKind =
  "event" | "travel" | "buffer" | "work_block" | "sleep" | "meal" | "protected";

export interface Blocker extends Span {
  kind: BlockerKind;
  label?: string | undefined;
  refId?: string | undefined;
}

export interface FreeWindow {
  start: Date;
  end: Date;
  minutes: number;
  // Local date in the owner's timezone on which the window starts.
  date: DateKey;
}

export interface AvailabilityInput {
  // Inclusive local dates in `preferences.timezone`.
  range: { from: DateKey; to: DateKey };
  events: FixedEvent[];
  workBlocks: PlannedBlock[];
  preferences: PlanningPreferences;
  // Nothing before this instant is offered (usually "now").
  notBefore?: Date | undefined;
}

const MS_PER_MINUTE = 60_000;
const MAX_RANGE_DAYS = 366;

function wall(date: DateKey, minutes: number, timezone: string): number {
  return localWallToUtc(date, minutes, timezone).getTime();
}

function dateRange(from: DateKey, to: DateKey): DateKey[] {
  parseDateKey(from);
  parseDateKey(to);
  const dates: DateKey[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    dates.push(date);
    if (dates.length > MAX_RANGE_DAYS) throw new RangeError("Availability range is too large.");
  }
  return dates;
}

// An overnight window belongs to its starting date and ends on the following morning.
function windowSpans(date: DateKey, window: TimeWindow, timezone: string): Span[] {
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end, { allow24: true });
  if (end === start) throw new RangeError(`Window ${window.start}-${window.end} is empty.`);
  if (end > start) return [{ start: wall(date, start, timezone), end: wall(date, end, timezone) }];
  return [{ start: wall(date, start, timezone), end: wall(addDays(date, 1), end, timezone) }];
}

function usableSpans(dates: DateKey[], preferences: PlanningPreferences): Span[] {
  const spans: Span[] = [];
  for (const date of dates) {
    for (const window of preferences.preferredHours[weekdayOf(date)] ?? []) {
      if (parseTimeOfDay(window.end, { allow24: true }) <= parseTimeOfDay(window.start)) {
        throw new RangeError(
          `Preferred window ${window.start}-${window.end} must end after it starts.`,
        );
      }
      spans.push(...windowSpans(date, window, preferences.timezone));
    }
  }
  return spans;
}

function recurringBlockers(dates: DateKey[], preferences: PlanningPreferences): Blocker[] {
  const { timezone } = preferences;
  const blockers: Blocker[] = [];
  const recurringDates = dates.length ? [addDays(dates[0]!, -1), ...dates] : [];
  for (const date of recurringDates) {
    if (preferences.sleep) {
      for (const span of windowSpans(date, preferences.sleep, timezone)) {
        blockers.push({ ...span, kind: "sleep" });
      }
    }
    for (const meal of preferences.meals ?? []) {
      for (const span of windowSpans(date, meal, timezone))
        blockers.push({ ...span, kind: "meal" });
    }
    for (const item of preferences.protectedTime ?? []) {
      if (!("window" in item)) continue;
      if (item.weekdays && !item.weekdays.includes(weekdayOf(date))) continue;
      for (const span of windowSpans(date, item.window, timezone)) {
        blockers.push({ ...span, kind: "protected", label: item.label });
      }
    }
  }
  for (const item of preferences.protectedTime ?? []) {
    if ("window" in item) continue;
    blockers.push({
      start: item.startsAt.getTime(),
      end: item.endsAt.getTime(),
      kind: "protected",
      label: item.label,
    });
  }
  return blockers;
}

// Whole local days in the event's own timezone, so the day does not move when the owner travels.
// `endExclusive` is the first date after the event.
export function allDayDateRange(event: Pick<FixedEvent, "startsAt" | "endsAt" | "timezone">): {
  first: DateKey;
  endExclusive: DateKey;
} {
  const first = dateKeyOf(event.startsAt, event.timezone);
  const last = dateKeyOf(event.endsAt, event.timezone);
  const endsAfterMidnight = event.endsAt.getTime() > wall(last, 0, event.timezone);
  return { first, endExclusive: endsAfterMidnight || last === first ? addDays(last, 1) : last };
}

function allDaySpan(event: FixedEvent): Span {
  const { first, endExclusive } = allDayDateRange(event);
  return { start: wall(first, 0, event.timezone), end: wall(endExclusive, 0, event.timezone) };
}

function eventBlockers(event: FixedEvent, bufferMinutes: number): Blocker[] {
  if (event.status !== "scheduled") return [];
  const ref = { label: event.title, refId: event.id };
  if (event.allDay) {
    return event.blocking === true ? [{ ...allDaySpan(event), kind: "event", ...ref }] : [];
  }
  if (event.blocking === false) return [];
  const start = event.startsAt.getTime();
  const end = event.endsAt.getTime();
  const travelBefore = (event.travelBeforeMinutes ?? 0) * MS_PER_MINUTE;
  const travelAfter = (event.travelAfterMinutes ?? 0) * MS_PER_MINUTE;
  const buffer = bufferMinutes * MS_PER_MINUTE;
  const blockers: Blocker[] = [
    { start, end, kind: "event", ...ref },
    { start: start - travelBefore, end: start, kind: "travel", ...ref },
    { start: start - travelBefore - buffer, end: start - travelBefore, kind: "buffer", ...ref },
    { start: end, end: end + travelAfter, kind: "travel", ...ref },
    { start: end + travelAfter, end: end + travelAfter + buffer, kind: "buffer", ...ref },
  ];
  return blockers.filter((blocker) => blocker.end > blocker.start);
}

function calendarBlockers(
  events: FixedEvent[],
  workBlocks: PlannedBlock[],
  preferences: PlanningPreferences,
): Blocker[] {
  return [
    ...events.flatMap((event) =>
      eventBlockers(
        {
          ...event,
          travelBeforeMinutes: event.travelBeforeMinutes ?? preferences.travelBeforeMinutes,
          travelAfterMinutes: event.travelAfterMinutes ?? preferences.travelAfterMinutes,
        },
        preferences.bufferMinutes,
      ),
    ),
    ...workBlocks
      .filter((block) => block.status === "planned")
      .map((block) => ({
        start: block.startsAt.getTime(),
        end: block.endsAt.getTime(),
        kind: "work_block" as const,
        refId: block.id,
      })),
  ];
}

function validatePreferences(preferences: PlanningPreferences): void {
  new Intl.DateTimeFormat("en-US", { timeZone: preferences.timezone });
  if (!Number.isFinite(preferences.bufferMinutes) || preferences.bufferMinutes < 0) {
    throw new RangeError("Buffer minutes must be zero or more.");
  }
  if (!Number.isFinite(preferences.minBlockMinutes) || preferences.minBlockMinutes < 1) {
    throw new RangeError("Minimum block length must be at least one minute.");
  }
  for (const minutes of [preferences.travelBeforeMinutes, preferences.travelAfterMinutes]) {
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes < 0))
      throw new RangeError("Travel minutes must be zero or more.");
  }
}

export function computeAvailability(input: AvailabilityInput): {
  windows: FreeWindow[];
  blockers: Blocker[];
} {
  const { preferences } = input;
  validatePreferences(preferences);
  const dates = dateRange(input.range.from, input.range.to);
  const blockers = [
    ...recurringBlockers(dates, preferences),
    ...calendarBlockers(input.events, input.workBlocks, preferences),
  ];
  const blocked = mergeSpans(blockers);
  const notBefore = input.notBefore?.getTime() ?? -Infinity;

  const windows: FreeWindow[] = [];
  for (const usable of mergeSpans(usableSpans(dates, preferences))) {
    for (const free of subtractSpans(usable, blocked)) {
      const start = Math.max(free.start, notBefore);
      const minutes = Math.floor((free.end - start) / MS_PER_MINUTE);
      if (minutes < preferences.minBlockMinutes) continue;
      windows.push({
        start: new Date(start),
        end: new Date(free.end),
        minutes,
        date: dateKeyOf(new Date(start), preferences.timezone),
      });
    }
  }
  return { windows, blockers };
}

export interface Conflict {
  kind: BlockerKind | "outside_preferred_hours";
  label?: string | undefined;
  refId?: string | undefined;
}

// Why a proposed block cannot be scheduled. An empty result means it fits entirely inside
// preferred hours without touching events, travel, buffers, sleep, meals, protected time, or
// another planned block. Pass `ignoreBlockId` when rescheduling an existing block.
export function findConflicts(
  candidate: { startsAt: Date; endsAt: Date },
  input: Omit<AvailabilityInput, "range" | "notBefore"> & { ignoreBlockId?: string },
): Conflict[] {
  const { preferences } = input;
  validatePreferences(preferences);
  const start = candidate.startsAt.getTime();
  const end = candidate.endsAt.getTime();
  if (!(end > start)) throw new RangeError("A proposed block must end after it starts.");

  const from = addDays(dateKeyOf(candidate.startsAt, preferences.timezone), -1);
  const to = addDays(dateKeyOf(candidate.endsAt, preferences.timezone), 1);
  const dates = dateRange(from, to);
  const blockers = [
    ...recurringBlockers(dates, preferences),
    ...calendarBlockers(
      input.events,
      input.workBlocks.filter((block) => block.id !== input.ignoreBlockId),
      preferences,
    ),
  ];

  const conflicts: Conflict[] = blockers
    .filter((blocker) => blocker.start < end && blocker.end > start)
    .map(({ kind, label, refId }) => ({ kind, label, refId }));

  const inside = mergeSpans(usableSpans(dates, preferences)).some(
    (span) => span.start <= start && span.end >= end,
  );
  if (!inside) conflicts.push({ kind: "outside_preferred_hours" });
  return conflicts;
}
