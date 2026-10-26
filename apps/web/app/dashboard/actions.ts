"use server";

import { ConfirmationError, ValidationError, VersionConflictError } from "@epiphany/core/services";
import {
  emptyConversation,
  MAX_MESSAGE_LENGTH,
  parseConversationState,
  type AssistantReply,
  type ConversationState,
} from "@epiphany/core/assistant";
import { addDays, localWallToUtc, parseDateKey, parseTimeOfDay } from "@epiphany/core/planning";
import {
  categoryForDashboard,
  dashboardContext,
  loadDashboardData,
  loadSchedule,
  noteForDashboard,
  taskForDashboard,
} from "./server-data";
import {
  parseEffort,
  type DashboardCategory,
  type DashboardData,
  type DashboardNote,
  type DashboardTask,
} from "./model";
import { weekStartOf, type ScheduleData } from "./schedule";
import { askAssistant, assistantAvailability } from "./assistant-server";

export type AskEpiResult =
  | { ok: true; reply: AssistantReply; state: ConversationState; budgetNote: string | null }
  | { ok: false; error: string };

export type DashboardResult =
  | {
      ok: true;
      message: string;
      task?: DashboardTask;
      note?: DashboardNote;
      category?: DashboardCategory;
      data?: DashboardData;
      partialFailure?: boolean;
      updatedTasks?: DashboardTask[];
    }
  | { ok: false; error: string };

export type DashboardHistoryResult =
  { ok: true; tasks: DashboardTask[]; nextOffset: number | null } | { ok: false; error: string };

export type DashboardNotesPageResult =
  { ok: true; notes: DashboardNote[]; hasMore: boolean } | { ok: false; error: string };

export type DashboardScheduleResult =
  { ok: true; schedule: ScheduleData } | { ok: false; error: string };
export type DashboardEventsResult =
  { ok: true; events: ScheduleData["events"]; truncated: boolean } | { ok: false; error: string };

export async function askEpi(message: string, state: unknown): Promise<AskEpiResult> {
  if (typeof message !== "string" || !message.trim()) {
    return { ok: false, error: "Write a message first." };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `That message is too long (${MAX_MESSAGE_LENGTH} characters at most).`,
    };
  }
  const conversation =
    state === null || state === undefined ? emptyConversation() : parseConversationState(state);
  if (!conversation) {
    return { ok: false, error: "This conversation could not be continued. Start a new one." };
  }
  const availability = assistantAvailability();
  if (availability === "needs_key") {
    return {
      ok: false,
      error:
        "Epi's language model is not set up yet. Add OPENAI_API_KEY to your .env file and restart the dashboard.",
    };
  }
  if (availability === "misconfigured") {
    return {
      ok: false,
      error: "The assistant settings are invalid. Check the dashboard server log.",
    };
  }
  const { principal } = await dashboardContext();
  try {
    const result = await askAssistant(principal.ownerId, message, conversation);
    return result
      ? { ok: true, ...result }
      : { ok: false, error: "Epi is unavailable right now. Nothing was changed." };
  } catch {
    console.error(JSON.stringify({ service: "dashboard", event: "assistant_failed" }));
    return { ok: false, error: "Epi couldn't answer just now. Nothing was changed." };
  }
}

function textField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ValidationError([`${name} must be text`]);
  return value;
}

function priorityField(form: FormData): "minor" | "major" | undefined {
  const value = textField(form, "priority");
  if (value === undefined) return undefined;
  if (value === "minor" || value === "major") return value;
  throw new ValidationError(["priority must be minor or major"]);
}

function failure(error: unknown): Extract<DashboardResult, { ok: false }> {
  if (error instanceof ValidationError) return { ok: false, error: error.issues.join(". ") };
  if (error instanceof VersionConflictError) {
    return {
      ok: false,
      error: "This record changed elsewhere. Refresh, review the latest version, then try again.",
    };
  }
  console.error(JSON.stringify({ service: "dashboard", event: "action_failed" }));
  return { ok: false, error: "The change could not be saved. Refresh and try again." };
}

export async function addDashboardTask(form: FormData): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  let estimatedMinutes: number | undefined;
  let dueAt: string | undefined;
  let dueDateOnly = false;
  let isTodo: boolean;
  try {
    const requestedType = textField(form, "entryType") ?? "task";
    if (requestedType !== "task" && requestedType !== "todo") {
      throw new ValidationError(["choose a task or todo"]);
    }
    isTodo = requestedType === "todo";
    if (!isTodo) {
      estimatedMinutes = parseEffort(form.get("estimatedMinutes"));
      dueDateOnly = form.get("dueDateOnly") === "on";
      const enteredDueAt = textField(form, "dueAt");
      if (enteredDueAt) {
        const deadline = new Date(enteredDueAt);
        if (Number.isNaN(deadline.getTime())) {
          throw new ValidationError(["enter a valid deadline"]);
        }
        dueAt = deadline.toISOString();
      }
      isTodo = !dueAt && estimatedMinutes === undefined;
      if (isTodo) dueDateOnly = false;
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, error: error.issues.join(". ") };
    }
    return { ok: false, error: "Enter a whole number of minutes between 1 and 100,000." };
  }
  try {
    const task = await services.tasks.create(principal, {
      title: textField(form, "title"),
      taskType: isTodo ? "todo" : "task",
      priority: isTodo ? "minor" : (priorityField(form) ?? "minor"),
      details: textField(form, "details"),
      dueAt,
      estimatedMinutes,
      ...(dueDateOnly ? { dueDateOnly: true } : {}),
      categoryId: textField(form, "categoryId"),
    });
    return { ok: true, message: "Task saved.", task: taskForDashboard(task) };
  } catch (error) {
    return failure(error);
  }
}

function versionField(form: FormData): number {
  const value = textField(form, "expectedVersion");
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError(["record version is missing; refresh before editing"]);
  }
  return version;
}

function editEffort(form: FormData): number | null | undefined {
  const value = form.get("estimatedMinutes");
  if (value === null) return undefined;
  if (value === "") return null;
  try {
    return parseEffort(value);
  } catch (error) {
    throw new ValidationError([error instanceof Error ? error.message : "invalid effort estimate"]);
  }
}

function editDeadline(form: FormData): string | null | undefined {
  const value = form.get("dueAt");
  if (value === null) return undefined;
  if (value === "") return null;
  if (typeof value !== "string") throw new ValidationError(["deadline must be text"]);
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new ValidationError(["enter a valid deadline"]);
  return instant.toISOString();
}

export async function editDashboardTask(taskId: string, form: FormData): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  try {
    const taskType = textField(form, "taskType");
    if (taskType !== undefined && taskType !== "task" && taskType !== "todo") {
      throw new ValidationError(["choose a task or todo"]);
    }
    const estimatedMinutes = taskType === "todo" ? null : editEffort(form);
    const dueAt = taskType === "todo" ? null : editDeadline(form);
    const becomesTodo = taskType !== "todo" && dueAt === null && estimatedMinutes === null;
    const effectiveType = becomesTodo ? "todo" : taskType;
    const result = await services.tasks.update(principal, taskId, {
      expectedVersion: versionField(form),
      ...(effectiveType ? { taskType: effectiveType } : {}),
      title: textField(form, "title"),
      priority: effectiveType === "todo" ? "minor" : priorityField(form),
      details: textField(form, "details") ?? "",
      dueAt: effectiveType === "todo" ? null : dueAt,
      dueDateOnly: effectiveType === "todo" ? false : form.get("dueDateOnly") === "on",
      estimatedMinutes: effectiveType === "todo" ? null : estimatedMinutes,
      categoryId: textField(form, "categoryId"),
    });
    return {
      ok: true,
      message: result.changed ? "Task updated." : "No changes to save.",
      task: taskForDashboard(result.task),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function finishDashboardTask(taskId: string): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  try {
    const result = await services.tasks.complete(principal, taskId);
    return { ok: true, message: "Task completed.", task: taskForDashboard(result.task) };
  } catch (error) {
    return failure(error);
  }
}

export async function finishDashboardTasks(taskIds: string[]): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  if (
    !Array.isArray(taskIds) ||
    !taskIds.length ||
    taskIds.length > 100 ||
    taskIds.some((id) => typeof id !== "string")
  ) {
    return { ok: false, error: "Select between 1 and 100 tasks." };
  }
  let completed = 0;
  let failed = 0;
  const updatedTasks: DashboardTask[] = [];
  for (const id of new Set(taskIds)) {
    try {
      const result = await services.tasks.complete(principal, id);
      updatedTasks.push(taskForDashboard(result.task));
      completed++;
    } catch (error) {
      failure(error);
      failed++;
    }
  }
  if (completed === 0)
    return {
      ok: false,
      error: "No selected tasks could be completed. Refresh and review before retrying.",
    };
  const data = await loadDashboardData();
  return {
    ok: true,
    data,
    updatedTasks,
    partialFailure: failed > 0,
    message: `${completed} task${completed === 1 ? "" : "s"} marked done.${failed ? ` ${failed} could not be completed. They remain selected; refresh and review before retrying.` : ""}`,
  };
}

export type NoteDeleteProposal = {
  confirmationId: string;
  payloadHash: string;
  summary: string;
};

export async function proposeDashboardNoteDeletion(
  noteId: string,
): Promise<{ ok: true; proposal: NoteDeleteProposal } | { ok: false; error: string }> {
  const { principal, services } = await dashboardContext();
  try {
    const proposal = await services.confirmations.propose(principal, {
      action: "note.delete",
      payload: { noteId },
    });
    return {
      ok: true,
      proposal: {
        confirmationId: proposal.confirmationId,
        payloadHash: proposal.payloadHash,
        summary: String(proposal.preview.summary),
      },
    };
  } catch (error) {
    const result = failure(error);
    return { ok: false, error: result.error };
  }
}

export async function confirmDashboardNoteDeletion(
  proposal: NoteDeleteProposal,
): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  try {
    await services.confirmations.confirm(principal, {
      confirmationId: proposal.confirmationId,
      payloadHash: proposal.payloadHash,
    });
    return {
      ok: true,
      message: "Note or idea permanently deleted.",
      data: await loadDashboardData(),
    };
  } catch (error) {
    if (error instanceof ConfirmationError)
      return {
        ok: false,
        error:
          "Deletion could not be confirmed. It may have expired or the item changed. Refresh and try again.",
      };
    return failure(error);
  }
}

export async function cancelDashboardNoteDeletion(confirmationId: string): Promise<void> {
  const { principal, services } = await dashboardContext();
  await services.confirmations.cancel(principal, confirmationId);
}

export async function reopenDashboardTask(taskId: string): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  try {
    const result = await services.tasks.reopen(principal, taskId);
    return {
      ok: true,
      message: result.changed ? "Task reopened." : "Task is already active.",
      task: taskForDashboard(result.task),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function addDashboardNote(form: FormData): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  try {
    const note = await services.notes.create(principal, {
      title: textField(form, "title"),
      body: textField(form, "body"),
      kind: textField(form, "kind") ?? "note",
      categoryId: textField(form, "categoryId"),
    });
    return { ok: true, message: "Note saved.", note: noteForDashboard(note) };
  } catch (error) {
    return failure(error);
  }
}

export async function editDashboardNote(noteId: string, form: FormData): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  try {
    const result = await services.notes.update(principal, noteId, {
      expectedVersion: versionField(form),
      title: textField(form, "title") ?? "",
      body: textField(form, "body"),
      kind: textField(form, "kind"),
      categoryId: textField(form, "categoryId"),
    });
    return {
      ok: true,
      message: result.changed ? "Note updated." : "No changes to save.",
      note: noteForDashboard(result.note),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function addDashboardCategory(form: FormData): Promise<DashboardResult> {
  const { principal, services } = await dashboardContext();
  try {
    const category = await services.categories.create(principal, textField(form, "name"));
    return {
      ok: true,
      message: "Category created.",
      category: categoryForDashboard(category),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function refreshDashboard(): Promise<DashboardResult> {
  try {
    return { ok: true, message: "Up to date.", data: await loadDashboardData() };
  } catch {
    return { ok: false, error: "Could not refresh. Your last loaded records are still shown." };
  }
}

export async function loadDashboardHistory(offset: number): Promise<DashboardHistoryResult> {
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    return { ok: false, error: "That history page is not valid. Refresh and try again." };
  }
  try {
    const { principal, services } = await dashboardContext();
    const rows = await services.tasks.list(principal, {
      status: "all",
      includeArchived: true,
      limit: 50,
      offset,
    });
    return {
      ok: true,
      tasks: rows.map(taskForDashboard),
      nextOffset: rows.length === 50 ? offset + rows.length : null,
    };
  } catch {
    return {
      ok: false,
      error: "History could not be loaded. Your other dashboard views are unchanged.",
    };
  }
}

export async function loadMoreDashboardNotes(offset: number): Promise<DashboardNotesPageResult> {
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    return { ok: false, error: "That notes page is not valid. Refresh and try again." };
  }
  try {
    const { principal, services } = await dashboardContext();
    const rows = await services.notes.list(principal, { limit: 100, offset });
    return {
      ok: true,
      notes: rows.map(noteForDashboard),
      hasMore: rows.length === 100,
    };
  } catch {
    return {
      ok: false,
      error: "Older notes could not be loaded. Your current notes are unchanged.",
    };
  }
}

export async function loadDashboardSchedule(weekStart: string): Promise<DashboardScheduleResult> {
  let monday: string;
  try {
    if (typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw new RangeError("invalid date");
    }
    monday = weekStartOf(weekStart);
  } catch {
    return { ok: false, error: "That week is not valid. Refresh and try again." };
  }
  try {
    const context = await dashboardContext();
    return { ok: true, schedule: await loadSchedule(context, monday) };
  } catch {
    return {
      ok: false,
      error: "The schedule could not be loaded. Your tasks and notes are unchanged.",
    };
  }
}

export async function loadDashboardEvents(fromDate: string): Promise<DashboardEventsResult> {
  let from: string;
  try {
    if (typeof fromDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
      throw new RangeError("invalid date");
    }
    parseDateKey(fromDate);
    from = fromDate;
  } catch {
    return { ok: false, error: "That event date is not valid. Refresh and try again." };
  }
  try {
    const { principal, services, timezone } = await dashboardContext();
    const start = localWallToUtc(from, 0, timezone);
    const end = localWallToUtc(addDays(from, 60), 0, timezone);
    const events = await services.events.list(principal, {
      from: start,
      to: end,
      limit: 200,
    });
    return {
      ok: true,
      events: events.map((event) => ({
        id: event.id,
        title: event.title,
        location: event.location,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt.toISOString(),
        allDay: event.allDay,
        timezone: event.timezone,
      })),
      truncated: events.length === 200,
    };
  } catch {
    return {
      ok: false,
      error: "Upcoming events could not be loaded. Your tasks and calendar are unchanged.",
    };
  }
}

export type DashboardScheduleChangeResult =
  { ok: true; message: string } | { ok: false; error: string };

// The owner's form fields are local wall-clock values; they become instants here, in the
// configured timezone, so the browser's own timezone never decides when something happens.
function scheduleWindow(
  form: FormData,
  timezone: string,
  allowAllDay: boolean,
  dateField = "date",
  allowDuration = false,
) {
  const date = textField(form, dateField);
  if (!date) throw new ValidationError(["date is required"]);
  try {
    parseDateKey(date);
  } catch {
    throw new ValidationError(["enter a valid date"]);
  }
  if (allowAllDay && form.get("allDay") === "on") {
    return {
      allDay: true,
      startsAt: localWallToUtc(date, 0, timezone),
      endsAt: localWallToUtc(addDays(date, 1), 0, timezone),
    };
  }
  const minutes = (name: string, label: string) => {
    try {
      return parseTimeOfDay(textField(form, name) ?? "");
    } catch {
      throw new ValidationError([`enter a valid ${label} time`]);
    }
  };
  const start = minutes("startTime", "start");
  const startsAt = localWallToUtc(date, start, timezone);
  if (allowDuration) {
    const timingMode = textField(form, "eventTimingMode") ?? "end";
    if (timingMode !== "end" && timingMode !== "duration") {
      throw new ValidationError(["choose an event end time or duration"]);
    }
    if (timingMode === "duration") {
      const value = textField(form, "durationMinutes");
      const duration = value ? Number(value) : Number.NaN;
      if (!Number.isInteger(duration) || duration < 1 || duration > 100_000) {
        throw new ValidationError(["duration must be between 1 and 100,000 whole minutes"]);
      }
      return {
        allDay: false,
        startsAt,
        endsAt: new Date(startsAt.getTime() + duration * 60_000),
      };
    }
  }
  const end = minutes("endTime", "end");
  if (end <= start) throw new ValidationError(["end time must be after the start time"]);
  return {
    allDay: false,
    startsAt,
    endsAt: localWallToUtc(date, end, timezone),
  };
}

export async function addDashboardEvent(form: FormData): Promise<DashboardScheduleChangeResult> {
  const { principal, services, timezone } = await dashboardContext();
  try {
    await services.events.create(principal, {
      title: textField(form, "title"),
      location: textField(form, "location"),
      timezone,
      ...scheduleWindow(form, timezone, true, "date", true),
    });
    return { ok: true, message: "Event saved." };
  } catch (error) {
    return failure(error);
  }
}

export async function addDashboardWorkBlock(
  form: FormData,
): Promise<DashboardScheduleChangeResult> {
  const { principal, services, timezone } = await dashboardContext();
  try {
    const { startsAt, endsAt } = scheduleWindow(form, timezone, false);
    await services.workBlocks.create(
      principal,
      {
        title: textField(form, "title"),
        taskId: textField(form, "taskId"),
        startsAt,
        endsAt,
      },
      { intent: "explicit" },
    );
    return { ok: true, message: "Work block saved." };
  } catch (error) {
    return failure(error);
  }
}

// Canceling keeps the event's record; it never completes or deletes a task.
export async function cancelDashboardEvent(
  eventId: string,
): Promise<DashboardScheduleChangeResult> {
  const { principal, services } = await dashboardContext();
  try {
    const result = await services.events.cancel(principal, eventId);
    return {
      ok: true,
      message: result.changed ? "Event canceled." : "Event was already canceled.",
    };
  } catch (error) {
    return failure(error);
  }
}

export async function removeDashboardWorkBlock(
  blockId: string,
): Promise<DashboardScheduleChangeResult> {
  const { principal, services } = await dashboardContext();
  try {
    await services.workBlocks.remove(principal, blockId, "manual", { intent: "explicit" });
    return { ok: true, message: "Work block removed. The task is unchanged." };
  } catch (error) {
    return failure(error);
  }
}
