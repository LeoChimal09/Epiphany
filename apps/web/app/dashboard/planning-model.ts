import {
  addDays,
  computeAvailability,
  DEFAULT_TASK_MINUTES,
  findConflicts,
  dateKeyOf,
  localWallToUtc,
  mergeSpans,
  type FreeWindow,
} from "@epiphany/core/planning";
import type { DashboardTask } from "./model";
import type { ScheduleData } from "./schedule";
import type { CalendarOverview } from "@epiphany/core/calendar";

export function calendarSyncWarning(overview: CalendarOverview): string | null {
  const { account, calendars } = overview;
  if (!account || account.status === "revoked") return null;
  if (account.status === "needs_reauth")
    return "Google Calendar needs reconnecting. Imported appointments may be out of date.";
  if (
    account.lastError ||
    calendars.some((calendar) => calendar.selected && calendar.syncStatus === "error")
  )
    return "Google Calendar has a sync problem. Imported appointments may be incomplete.";
  if (
    !calendars.length ||
    calendars.some((calendar) => calendar.selected && calendar.syncStatus === "pending")
  )
    return "Google Calendar is waiting for its first sync. Your appointments may be missing.";
  if (calendars.some((calendar) => calendar.selected && calendar.syncStatus === "stale"))
    return "Google Calendar is out of date. Recent appointment changes may be missing.";
  return null;
}

export type PreparationHint = {
  taskId: string;
  title: string;
  assumedDuration: boolean;
} & (
  | {
      state: "overdue";
      remainingMinutes: number | null;
      startBy: null;
    }
  | { state: "conflict"; remainingMinutes: number | null; startBy: null }
  | { state: "covered"; remainingMinutes: number; startBy: null }
  | { state: "insufficient"; remainingMinutes: number; startBy: null }
  | { state: "prepare"; remainingMinutes: number; startBy: Date }
);

// Suggestions are per-task feasibility checks, not reservations or a combined plan.
export function preparationHints(
  tasks: DashboardTask[],
  schedule: ScheduleData,
  windows: FreeWindow[],
  timezone: string,
  from: string,
  to: string,
  now: Date,
): PreparationHint[] {
  const rangeEnd = localWallToUtc(addDays(to, 1), 0, timezone).getTime();
  const context = planningInput(schedule);
  const conflicting = new Set(
    schedule.blocks
      .filter(
        (block) =>
          context &&
          new Date(block.endsAt).getTime() > now.getTime() &&
          findConflicts(
            { startsAt: new Date(block.startsAt), endsAt: new Date(block.endsAt) },
            { ...context, ignoreBlockId: block.id },
          ).length > 0,
      )
      .map((block) => block.taskId),
  );
  return tasks
    .filter((task): task is DashboardTask & { dueAt: string } => {
      if (task.status !== "open" || task.archivedAt || !task.dueAt) return false;
      const day = dateKeyOf(new Date(task.dueAt), timezone);
      return day >= from && day <= to;
    })
    .toSorted((a, b) => a.dueAt.localeCompare(b.dueAt))
    .slice(0, 10)
    .map((task): PreparationHint => {
      const due = new Date(task.dueAt);
      const deadline = task.dueDateOnly
        ? localWallToUtc(addDays(dateKeyOf(due, timezone), 1), 0, timezone).getTime()
        : due.getTime();
      const estimate = task.estimatedMinutes ?? DEFAULT_TASK_MINUTES;
      const base = {
        taskId: task.id,
        title: task.title,
        startBy: null,
        assumedDuration: task.estimatedMinutes === null,
      };
      if (deadline <= now.getTime())
        return { ...base, state: "overdue", remainingMinutes: estimate };
      if (conflicting.has(task.id))
        return { ...base, state: "conflict", remainingMinutes: estimate };
      const planned = mergeSpans(
        schedule.blocks
          .filter((block) => block.taskId === task.id)
          .map((block) => ({
            start: Math.max(new Date(block.startsAt).getTime(), now.getTime()),
            end: Math.min(new Date(block.endsAt).getTime(), deadline),
          })),
      ).reduce((total, span) => total + (span.end - span.start) / 60_000, 0);
      const remaining = Math.max(0, Math.ceil(estimate - planned));
      if (!remaining) return { ...base, state: "covered", remainingMinutes: 0 };
      let needed = remaining;
      for (const window of windows.toReversed()) {
        const end = Math.min(window.end.getTime(), deadline, rangeEnd);
        const available = Math.max(0, Math.floor((end - window.start.getTime()) / 60_000));
        if (available >= needed)
          return {
            ...base,
            state: "prepare",
            remainingMinutes: remaining,
            startBy: new Date(end - needed * 60_000),
          };
        needed -= available;
      }
      return { ...base, state: "insufficient", remainingMinutes: remaining };
    });
}

function planningInput(schedule: ScheduleData) {
  if (!schedule.planningPreferences) return null;
  return {
    preferences: schedule.planningPreferences,
    events: schedule.events.map((event) => ({
      ...event,
      startsAt: new Date(event.startsAt),
      endsAt: new Date(event.endsAt),
      status: "scheduled" as const,
    })),
    workBlocks: schedule.blocks.map((block) => ({
      ...block,
      startsAt: new Date(block.startsAt),
      endsAt: new Date(block.endsAt),
      status: "planned" as const,
    })),
  };
}

export function scheduleAvailability(schedule: ScheduleData, from: string, to: string, now: Date) {
  const input = planningInput(schedule);
  if (schedule.truncated || !input) return null;
  return computeAvailability({
    ...input,
    range: { from, to },
    notBefore: now,
  }).windows;
}
