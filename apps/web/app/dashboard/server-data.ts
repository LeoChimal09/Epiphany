import "server-only";
import { createServices, type OwnerProfile } from "@epiphany/core/services";
import { addDays, localWallToUtc, type DateKey } from "@epiphany/core/planning";
import type { CalendarEvent, Category, Note, Task, WorkBlock } from "@epiphany/core/db";
import { verifySession } from "../../lib/auth/dal";
import { getAuthDeps } from "../../lib/auth/deps";
import type { DashboardData, DashboardNote, DashboardTask } from "./model";
import type { ScheduleBlock, ScheduleData, ScheduleEvent } from "./schedule";
import { todayKey, weekStartOf } from "./schedule";

export function taskForDashboard(task: Task): DashboardTask {
  return {
    id: task.id,
    categoryId: task.categoryId,
    title: task.title,
    details: task.details,
    sourceText: task.sourceText,
    reviewNote: task.reviewNote,
    status: task.status,
    dueAt: task.dueAt?.toISOString() ?? null,
    dueDateOnly: task.dueDateOnly,
    estimatedMinutes: task.estimatedMinutes,
    completedAt: task.completedAt?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    version: task.version,
  };
}

export function noteForDashboard(note: Note): DashboardNote {
  return {
    id: note.id,
    categoryId: note.categoryId,
    title: note.title,
    body: note.body,
    kind: note.kind,
    createdAt: note.createdAt.toISOString(),
    version: note.version,
  };
}

export function categoryForDashboard(category: Category) {
  return { id: category.id, name: category.name, systemKey: category.systemKey };
}

export function eventForSchedule(event: CalendarEvent): ScheduleEvent {
  return {
    id: event.id,
    title: event.title,
    location: event.location,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    allDay: event.allDay,
    timezone: event.timezone,
  };
}

export function blockForSchedule(block: WorkBlock): ScheduleBlock {
  return {
    id: block.id,
    taskId: block.taskId,
    title: block.title,
    startsAt: block.startsAt.toISOString(),
    endsAt: block.endsAt.toISOString(),
  };
}

export const SCHEDULE_LIMIT = 200;

export async function dashboardContext() {
  const principal = await verifySession();
  const deps = getAuthDeps();
  if (!deps) throw new Error("Dashboard sign-in is not configured.");
  return {
    principal,
    timezone: deps.config.timezone,
    devBypass: deps.config.devBypass,
    services: createServices(deps.db, { clock: deps.clock }),
  };
}

export async function loadSchedule(
  context: Awaited<ReturnType<typeof dashboardContext>>,
  weekStart: DateKey,
): Promise<ScheduleData> {
  const from = localWallToUtc(weekStart, 0, context.timezone);
  const to = localWallToUtc(addDays(weekStart, 7), 0, context.timezone);
  const [events, blocks] = await Promise.all([
    context.services.events.list(context.principal, { from, to, limit: SCHEDULE_LIMIT }),
    context.services.workBlocks.list(context.principal, { from, to, limit: SCHEDULE_LIMIT }),
  ]);
  return {
    weekStart,
    events: events.map(eventForSchedule),
    blocks: blocks.map(blockForSchedule),
    truncated: events.length === SCHEDULE_LIMIT || blocks.length === SCHEDULE_LIMIT,
  };
}

export async function loadDashboardData(): Promise<
  DashboardData & { devBypass: boolean; owner: OwnerProfile }
> {
  const context = await dashboardContext();
  const [open, completed, notes, categories, owner] = await Promise.all([
    context.services.tasks.list(context.principal, { status: "open", limit: 100 }),
    context.services.tasks.list(context.principal, { status: "completed", limit: 100 }),
    context.services.notes.list(context.principal, { limit: 100 }),
    context.services.categories.list(context.principal),
    context.services.owner.profile(context.principal),
  ]);
  return {
    tasks: [...open, ...completed].map(taskForDashboard),
    notes: notes.map(noteForDashboard),
    categories: categories.map(categoryForDashboard),
    timezone: context.timezone,
    capturedAt: new Date().toISOString(),
    tasksTruncated: open.length === 100 || completed.length === 100,
    notesTruncated: notes.length === 100,
    devBypass: context.devBypass,
    owner,
  };
}

// The first paint shows the current week. A failure leaves the schedule empty with a retry
// instead of blocking tasks and notes.
export async function loadInitialSchedule(): Promise<ScheduleData | null> {
  try {
    const context = await dashboardContext();
    return await loadSchedule(context, weekStartOf(todayKey(context.timezone)));
  } catch {
    return null;
  }
}
