import {
  addDays,
  allDayDateRange,
  dateKeyOf,
  localParts,
  localWallToUtc,
  weekdayOf,
  type DateKey,
} from "@epiphany/core/planning";
import type { DashboardTask } from "./model";

export interface ScheduleEvent {
  id: string;
  title: string;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timezone: string;
}

export interface ScheduleBlock {
  id: string;
  taskId: string | null;
  title: string | null;
  startsAt: string;
  endsAt: string;
}

export interface ScheduleData {
  // Monday of the loaded week, as a local date in the owner's timezone.
  weekStart: DateKey;
  events: ScheduleEvent[];
  blocks: ScheduleBlock[];
  // True when the per-request record limit was reached, so some items may be missing.
  truncated: boolean;
}

export interface TimelineItem {
  key: string;
  kind: "event" | "work";
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  timezone: string;
  location: string | null;
  taskId: string | null;
  // Overlaps another timed item.
  conflict: boolean;
}

export interface DayEntry {
  item: TimelineItem;
  startMinute: number;
  endMinute: number;
  column: number;
  columns: number;
}

export interface DayView {
  date: DateKey;
  allDay: TimelineItem[];
  entries: DayEntry[];
  deadlines: DashboardTask[];
  completed: DashboardTask[];
  plannedMinutes: number;
  dueEffortMinutes: number;
  conflictCount: number;
}

const MINUTE_MS = 60_000;
const MIN_VISIBLE_MINUTES = 20;

export function weekStartOf(date: DateKey): DateKey {
  const index = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(weekdayOf(date));
  return addDays(date, -index);
}

export function weekDays(weekStart: DateKey): DateKey[] {
  return Array.from({ length: 7 }, (_, offset) => addDays(weekStart, offset));
}

export function todayKey(timezone: string, now = new Date()): DateKey {
  return dateKeyOf(now, timezone);
}

export function timelineItems(schedule: ScheduleData): TimelineItem[] {
  const items: TimelineItem[] = [
    ...schedule.events.map((event) => ({
      key: `event:${event.id}`,
      kind: "event" as const,
      id: event.id,
      title: event.title,
      start: Date.parse(event.startsAt),
      end: Date.parse(event.endsAt),
      allDay: event.allDay,
      timezone: event.timezone,
      location: event.location,
      taskId: null,
      conflict: false,
    })),
    ...schedule.blocks.map((block) => ({
      key: `work:${block.id}`,
      kind: "work" as const,
      id: block.id,
      title: block.title ?? "Work block",
      start: Date.parse(block.startsAt),
      end: Date.parse(block.endsAt),
      allDay: false,
      timezone: "",
      location: null,
      taskId: block.taskId,
      conflict: false,
    })),
  ].filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));
  return markConflicts(items);
}

// Flags timed items that genuinely overlap each other. Back-to-back items do not conflict.
export function markConflicts(items: TimelineItem[]): TimelineItem[] {
  const timed = items
    .filter((item) => !item.allDay && item.end > item.start)
    .toSorted((first, second) => first.start - second.start);
  const conflicted = new Set<string>();
  for (let index = 0; index < timed.length; index += 1) {
    const current = timed[index]!;
    for (let next = index + 1; next < timed.length; next += 1) {
      const other = timed[next]!;
      if (other.start >= current.end) break;
      conflicted.add(current.key);
      conflicted.add(other.key);
    }
  }
  return items.map((item) => ({ ...item, conflict: conflicted.has(item.key) }));
}

function minuteOfDay(ms: number, timezone: string): number {
  const parts = localParts(new Date(ms), timezone);
  return parts.hour * 60 + parts.minute;
}

function dueKey(task: DashboardTask, timezone: string): DateKey | null {
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  // Date-only deadlines are stored as UTC midnight and mean that calendar date everywhere.
  return task.dueDateOnly ? task.dueAt.slice(0, 10) : dateKeyOf(due, timezone);
}

// Side-by-side columns for overlapping items; each overlap cluster shares one column count.
function layoutColumns(entries: Omit<DayEntry, "column" | "columns">[]): DayEntry[] {
  const sorted = entries.toSorted(
    (first, second) => first.startMinute - second.startMinute || first.endMinute - second.endMinute,
  );
  const placed: DayEntry[] = [];
  let cluster: DayEntry[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;

  const closeCluster = () => {
    for (const entry of cluster) entry.columns = columnEnds.length;
    cluster = [];
    columnEnds = [];
  };

  for (const entry of sorted) {
    if (cluster.length > 0 && entry.startMinute >= clusterEnd) closeCluster();
    let column = columnEnds.findIndex((end) => end <= entry.startMinute);
    if (column === -1) column = columnEnds.length;
    columnEnds[column] = entry.endMinute;
    clusterEnd = cluster.length === 0 ? entry.endMinute : Math.max(clusterEnd, entry.endMinute);
    const laidOut: DayEntry = { ...entry, column, columns: 1 };
    cluster.push(laidOut);
    placed.push(laidOut);
  }
  closeCluster();
  return placed;
}

export function buildDay(
  date: DateKey,
  items: TimelineItem[],
  tasks: DashboardTask[],
  timezone: string,
): DayView {
  const dayStart = localWallToUtc(date, 0, timezone).getTime();
  const dayEnd = localWallToUtc(addDays(date, 1), 0, timezone).getTime();

  const allDay = items.filter((item) => {
    if (!item.allDay) return false;
    const range = allDayDateRange({
      startsAt: new Date(item.start),
      endsAt: new Date(item.end),
      timezone: item.timezone,
    });
    return range.first <= date && date < range.endExclusive;
  });

  const timed = items.filter((item) => {
    if (item.allDay) return false;
    if (item.end > item.start) return item.start < dayEnd && item.end > dayStart;
    return item.start >= dayStart && item.start < dayEnd;
  });

  const entries = layoutColumns(
    timed.map((item) => {
      const startMinute = item.start <= dayStart ? 0 : minuteOfDay(item.start, timezone);
      const rawEnd = item.end >= dayEnd ? 1440 : minuteOfDay(item.end, timezone);
      return {
        item,
        startMinute,
        endMinute: Math.min(1440, Math.max(rawEnd, startMinute + MIN_VISIBLE_MINUTES)),
      };
    }),
  );

  const plannedMinutes = timed
    .filter((item) => item.kind === "work")
    .reduce(
      (total, item) =>
        total +
        Math.round((Math.min(item.end, dayEnd) - Math.max(item.start, dayStart)) / MINUTE_MS),
      0,
    );
  const deadlines = tasks
    .filter((task) => task.status === "open" && dueKey(task, timezone) === date)
    .toSorted((first, second) => (first.dueAt ?? "").localeCompare(second.dueAt ?? ""));
  const completed = tasks.filter(
    (task) =>
      task.status === "completed" &&
      task.completedAt !== null &&
      dateKeyOf(new Date(task.completedAt), timezone) === date,
  );

  return {
    date,
    allDay,
    entries,
    deadlines,
    completed,
    plannedMinutes,
    dueEffortMinutes: deadlines.reduce((total, task) => total + (task.estimatedMinutes ?? 0), 0),
    conflictCount: timed.filter((item) => item.conflict).length,
  };
}

// Whole-hour bounds shared by every day in a view, widened to fit anything scheduled outside
// the default waking hours.
export function hourBounds(
  days: DayView[],
  defaults = { start: 7, end: 21 },
): { start: number; end: number } {
  let start = defaults.start;
  let end = defaults.end;
  for (const day of days) {
    for (const entry of day.entries) {
      start = Math.min(start, Math.floor(entry.startMinute / 60));
      end = Math.max(end, Math.ceil(entry.endMinute / 60));
    }
  }
  return { start, end: Math.min(24, end) };
}

export function currentMinute(timezone: string, date: DateKey, now = new Date()): number | null {
  return todayKey(timezone, now) === date ? minuteOfDay(now.getTime(), timezone) : null;
}

export function formatClock(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function formatHourLabel(hour: number): string {
  const suffix = hour >= 12 && hour < 24 ? "PM" : "AM";
  return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`;
}

export function formatDayLabel(date: DateKey, style: "short" | "long" = "short"): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: style === "long" ? "long" : "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function formatWeekRange(weekStart: DateKey): string {
  const end = addDays(weekStart, 6);
  return `${formatDayLabel(weekStart).replace(/^\w+, /, "")} to ${formatDayLabel(end).replace(/^\w+, /, "")}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
