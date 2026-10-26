import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError, VersionConflictError } from "@epiphany/core/services";
import {
  addDashboardCategory,
  addDashboardEvent,
  addDashboardNote,
  addDashboardTask,
  addDashboardWorkBlock,
  cancelDashboardEvent,
  editDashboardNote,
  editDashboardTask,
  finishDashboardTask,
  finishDashboardTasks,
  proposeDashboardNoteDeletion,
  confirmDashboardNoteDeletion,
  cancelDashboardNoteDeletion,
  loadDashboardEvents,
  loadDashboardHistory,
  loadDashboardSchedule,
  loadMoreDashboardNotes,
  refreshDashboard,
  removeDashboardWorkBlock,
  reopenDashboardTask,
} from "./actions";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  load: vi.fn(),
  loadSchedule: vi.fn(),
  taskCreate: vi.fn(),
  taskList: vi.fn(),
  taskComplete: vi.fn(),
  taskUpdate: vi.fn(),
  taskReopen: vi.fn(),
  noteCreate: vi.fn(),
  noteList: vi.fn(),
  noteUpdate: vi.fn(),
  categoryCreate: vi.fn(),
  eventCreate: vi.fn(),
  eventCancel: vi.fn(),
  eventList: vi.fn(),
  blockCreate: vi.fn(),
  blockRemove: vi.fn(),
  propose: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("./server-data", () => ({
  categoryForDashboard: (record: unknown) => record,
  dashboardContext: mocks.context,
  loadDashboardData: mocks.load,
  loadSchedule: mocks.loadSchedule,
  taskForDashboard: (record: unknown) => record,
  noteForDashboard: (record: unknown) => record,
}));

const principal = { authenticated: "fixture-owner" };
const task = { id: "persisted-task", title: "Trimmed title", status: "open" };
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({
    principal,
    timezone: "America/Chicago",
    services: {
      tasks: {
        list: mocks.taskList,
        create: mocks.taskCreate,
        complete: mocks.taskComplete,
        update: mocks.taskUpdate,
        reopen: mocks.taskReopen,
      },
      notes: { create: mocks.noteCreate, list: mocks.noteList, update: mocks.noteUpdate },
      categories: { create: mocks.categoryCreate },
      events: { create: mocks.eventCreate, cancel: mocks.eventCancel, list: mocks.eventList },
      workBlocks: { create: mocks.blockCreate, remove: mocks.blockRemove },
      confirmations: { propose: mocks.propose, confirm: mocks.confirm, cancel: mocks.cancel },
    },
  });
});

describe("dashboard mutations", () => {
  it("loads upcoming events within the bounded date range", async () => {
    const startsAt = new Date("2026-10-27T17:00:00.000Z");
    const endsAt = new Date("2026-10-27T18:00:00.000Z");
    mocks.eventList.mockResolvedValue([
      {
        id: "event-1",
        title: "Dinner",
        location: "Cafe",
        startsAt,
        endsAt,
        allDay: false,
        timezone: "America/Chicago",
      },
    ]);

    const result = await loadDashboardEvents("2026-10-27");

    expect(mocks.eventList).toHaveBeenCalledWith(principal, {
      from: expect.any(Date),
      to: expect.any(Date),
      limit: 200,
    });
    expect(result).toEqual({
      ok: true,
      events: [
        {
          id: "event-1",
          title: "Dinner",
          location: "Cafe",
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          allDay: false,
          timezone: "America/Chicago",
        },
      ],
      truncated: false,
    });
  });

  it("rejects invalid event date ranges before loading events", async () => {
    expect(await loadDashboardEvents("not-a-date")).toMatchObject({ ok: false });
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("completes only unique selected tasks and returns reloaded state", async () => {
    mocks.taskComplete.mockResolvedValue({ changed: true, task });
    mocks.load.mockResolvedValue({
      tasks: [{ ...task, status: "completed" }],
      notes: [],
      categories: [],
    });
    const result = await finishDashboardTasks(["a", "b", "a"]);
    expect(mocks.taskComplete.mock.calls).toEqual([
      [principal, "a"],
      [principal, "b"],
    ]);
    expect(result).toMatchObject({
      ok: true,
      partialFailure: false,
      message: "2 tasks marked done.",
    });
    expect(mocks.load).toHaveBeenCalledOnce();
  });
  it("reports partial completion explicitly instead of silently claiming all succeeded", async () => {
    mocks.taskComplete
      .mockResolvedValueOnce({ changed: true, task })
      .mockRejectedValueOnce(new ValidationError(["task changed"]));
    mocks.load.mockResolvedValue({ tasks: [], notes: [], categories: [] });
    expect(await finishDashboardTasks(["a", "b"])).toMatchObject({
      ok: true,
      partialFailure: true,
      message: expect.stringContaining("1 could not be completed"),
    });
  });
  it("returns failure when no selected tasks can be completed", async () => {
    mocks.taskComplete.mockRejectedValue(new ValidationError(["task changed"]));
    const result = await finishDashboardTasks(["a", "b"]);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("No selected tasks"),
    });
  });
  it("rejects empty and oversized bulk selections before writes", async () => {
    expect(await finishDashboardTasks([])).toMatchObject({ ok: false });
    expect(
      await finishDashboardTasks(Array.from({ length: 101 }, (_, i) => String(i))),
    ).toMatchObject({ ok: false });
    expect(mocks.taskComplete).not.toHaveBeenCalled();
  });
  it("prepares version-bound idea deletion without executing it", async () => {
    mocks.propose.mockResolvedValue({
      confirmationId: "proposal",
      payloadHash: "hash",
      preview: { summary: "Delete idea" },
    });
    expect(await proposeDashboardNoteDeletion("idea")).toEqual({
      ok: true,
      proposal: { confirmationId: "proposal", payloadHash: "hash", summary: "Delete idea" },
    });
    expect(mocks.propose).toHaveBeenCalledWith(principal, {
      action: "note.delete",
      payload: { noteId: "idea" },
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("executes deletion only with the existing confirmation service and refreshes notes", async () => {
    mocks.confirm.mockResolvedValue({ result: { deleted: "note", id: "idea" } });
    mocks.load.mockResolvedValue({ notes: [] });
    const proposal = { confirmationId: "proposal", payloadHash: "hash", summary: "Delete idea" };
    expect(await confirmDashboardNoteDeletion(proposal)).toMatchObject({
      ok: true,
      data: { notes: [] },
    });
    expect(mocks.confirm).toHaveBeenCalledWith(principal, {
      confirmationId: "proposal",
      payloadHash: "hash",
    });
  });
  it("cancels the proposal without deleting anything", async () => {
    await cancelDashboardNoteDeletion("proposal");
    expect(mocks.cancel).toHaveBeenCalledWith(principal, "proposal");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("authenticates and passes the owner to shared services, returning the saved task", async () => {
    mocks.taskCreate.mockResolvedValue(task);
    const result = await addDashboardTask(
      form({ title: "  Trimmed title ", estimatedMinutes: "45" }),
    );
    expect(mocks.context).toHaveBeenCalledOnce();
    expect(mocks.taskCreate).toHaveBeenCalledWith(principal, {
      title: "  Trimmed title ",
      taskType: "task",
      priority: "minor",
      details: undefined,
      dueAt: undefined,
      estimatedMinutes: 45,
      categoryId: undefined,
    });
    expect(result).toMatchObject({ ok: true, task });
  });

  it("saves major priority when requested", async () => {
    mocks.taskCreate.mockResolvedValue(task);
    await addDashboardTask(
      form({
        title: "Final exam",
        priority: "major",
        dueAt: "2026-10-30T15:00:00.000Z",
      }),
    );
    expect(mocks.taskCreate).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ title: "Final exam", priority: "major" }),
    );
  });

  it("automatically saves an item with neither deadline nor effort as a todo", async () => {
    mocks.taskCreate.mockResolvedValue(task);
    await addDashboardTask(form({ title: "Buy the right part" }));
    expect(mocks.taskCreate).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        title: "Buy the right part",
        taskType: "todo",
        priority: "minor",
        dueAt: undefined,
        estimatedMinutes: undefined,
      }),
    );
  });

  it("keeps the task deadline unchanged when an effort estimate is also provided", async () => {
    mocks.taskCreate.mockResolvedValue(task);
    await addDashboardTask(
      form({
        title: "Head home",
        dueAt: "2026-10-23T21:30:00.000Z",
        estimatedMinutes: "30",
      }),
    );
    expect(mocks.taskCreate).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        title: "Head home",
        dueAt: "2026-10-23T21:30:00.000Z",
        estimatedMinutes: 30,
      }),
    );
  });

  it("saves a todo without effort, deadline, or major priority", async () => {
    mocks.taskCreate.mockResolvedValue(task);
    await addDashboardTask(
      form({
        title: "Buy a snack",
        entryType: "todo",
        estimatedMinutes: "45",
        dueAt: "2026-10-23T21:30:00.000Z",
        dueDateOnly: "on",
        priority: "major",
      }),
    );
    expect(mocks.taskCreate).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        title: "Buy a snack",
        taskType: "todo",
        dueAt: undefined,
        estimatedMinutes: undefined,
        priority: "minor",
      }),
    );
    expect(mocks.taskCreate.mock.calls[0]?.[1]).not.toHaveProperty("dueDateOnly");
  });

  it("rejects an unknown task entry type", async () => {
    expect(await addDashboardTask(form({ title: "Task", entryType: "sometime" }))).toMatchObject({
      ok: false,
    });
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("does not write when authentication fails", async () => {
    mocks.context.mockRejectedValue(new Error("not authenticated"));
    await expect(addDashboardTask(form({ title: "Private" }))).rejects.toThrow("not authenticated");
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("rejects invalid effort before calling the data service", async () => {
    expect(await addDashboardTask(form({ title: "Task", estimatedMinutes: "-1" }))).toMatchObject({
      ok: false,
    });
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("reports shared-service validation instead of claiming a save", async () => {
    mocks.taskCreate.mockRejectedValue(new ValidationError(["title must not be empty"]));
    expect(await addDashboardTask(form({ title: " " }))).toEqual({
      ok: false,
      error: "title must not be empty",
    });
  });

  it("completes only the identified task and returns the persisted completion", async () => {
    const completed = { ...task, status: "completed" };
    mocks.taskComplete.mockResolvedValue({ changed: true, task: completed });
    expect(await finishDashboardTask(task.id)).toMatchObject({ ok: true, task: completed });
    expect(mocks.taskComplete).toHaveBeenCalledWith(principal, task.id);
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("creates notes and ideas through the same authenticated boundary", async () => {
    const note = { id: "persisted-note", body: "A workout idea", kind: "idea" };
    mocks.noteCreate.mockResolvedValue(note);
    expect(await addDashboardNote(form({ body: note.body, kind: "idea" }))).toMatchObject({
      ok: true,
      note,
    });
    expect(mocks.noteCreate).toHaveBeenCalledWith(principal, {
      title: undefined,
      body: note.body,
      kind: "idea",
      categoryId: undefined,
    });
  });

  it("edits a task against its loaded version and applies category changes", async () => {
    mocks.taskUpdate.mockResolvedValue({ changed: true, task: { ...task, version: 2 } });
    const result = await editDashboardTask(
      task.id,
      form({
        title: "Updated title",
        taskType: "task",
        details: "Updated details",
        dueAt: "",
        estimatedMinutes: "",
        categoryId: "school",
        expectedVersion: "1",
      }),
    );
    expect(mocks.taskUpdate).toHaveBeenCalledWith(principal, task.id, {
      expectedVersion: 1,
      taskType: "todo",
      title: "Updated title",
      priority: "minor",
      details: "Updated details",
      dueAt: null,
      dueDateOnly: false,
      estimatedMinutes: null,
      categoryId: "school",
    });
    expect(result).toMatchObject({ ok: true, task: { version: 2 } });
  });

  it("clears task-only planning fields when converting to a todo", async () => {
    mocks.taskUpdate.mockResolvedValue({ changed: true, task: { ...task, version: 2 } });
    await editDashboardTask(
      task.id,
      form({
        expectedVersion: "1",
        taskType: "todo",
        title: "Buy a snack",
        priority: "major",
        dueAt: "",
        dueDateOnly: "on",
        estimatedMinutes: "45",
        details: "",
      }),
    );
    expect(mocks.taskUpdate).toHaveBeenCalledWith(principal, task.id, {
      expectedVersion: 1,
      taskType: "todo",
      title: "Buy a snack",
      priority: "minor",
      details: "",
      dueAt: null,
      dueDateOnly: false,
      estimatedMinutes: null,
      categoryId: undefined,
    });
  });

  it("reports stale task edits rather than claiming success", async () => {
    mocks.taskUpdate.mockRejectedValue(new VersionConflictError("Task", 2));
    expect(
      await editDashboardTask(task.id, form({ title: "Local", expectedVersion: "1" })),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed elsewhere"),
    });
  });

  it("reopens completed work through the shared service", async () => {
    mocks.taskReopen.mockResolvedValue({ changed: true, task: { ...task, status: "open" } });
    expect(await reopenDashboardTask(task.id)).toMatchObject({
      ok: true,
      message: "Task reopened.",
      task: { status: "open" },
    });
    expect(mocks.taskReopen).toHaveBeenCalledWith(principal, task.id);
  });

  it("edits notes with version checks and category changes", async () => {
    const note = {
      id: "note-id",
      categoryId: "inbox",
      title: "Idea",
      body: "Text",
      kind: "idea",
      version: 3,
    };
    mocks.noteUpdate.mockResolvedValue({ changed: true, note });
    const result = await editDashboardNote(
      "note-id",
      form({
        title: "Idea",
        body: "Text",
        kind: "idea",
        categoryId: "inbox",
        expectedVersion: "2",
      }),
    );
    expect(result).toMatchObject({ ok: true, note });
    expect(mocks.noteUpdate).toHaveBeenCalledWith(principal, "note-id", {
      expectedVersion: 2,
      title: "Idea",
      body: "Text",
      kind: "idea",
      categoryId: "inbox",
    });
  });

  it("creates categories using the authenticated owner service", async () => {
    const category = { id: "school", name: "School", systemKey: null };
    mocks.categoryCreate.mockResolvedValue(category);
    expect(await addDashboardCategory(form({ name: "School" }))).toMatchObject({
      ok: true,
      category,
    });
    expect(mocks.categoryCreate).toHaveBeenCalledWith(principal, "School");
  });

  it("refresh failures do not return a fake empty dashboard", async () => {
    mocks.load.mockRejectedValue(new Error("database offline"));
    const result = await refreshDashboard();
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("data");
  });

  it("loads history through owner-scoped service pages including archived records", async () => {
    const historyTask = { ...task, archivedAt: "2024-10-01T00:00:00.000Z" };
    mocks.taskList.mockResolvedValue([historyTask]);
    expect(await loadDashboardHistory(50)).toMatchObject({
      ok: true,
      tasks: [historyTask],
      nextOffset: null,
    });
    expect(mocks.taskList).toHaveBeenCalledWith(principal, {
      status: "all",
      includeArchived: true,
      limit: 50,
      offset: 50,
    });
  });

  it("offers another page only when the requested page is full", async () => {
    mocks.taskList.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({ ...task, id: `history-${index}` })),
    );
    expect(await loadDashboardHistory(0)).toMatchObject({ ok: true, nextOffset: 50 });
    mocks.taskList.mockResolvedValue([{ ...task, id: "last-history" }]);
    expect(await loadDashboardHistory(50)).toMatchObject({
      ok: true,
      tasks: [{ id: "last-history" }],
      nextOffset: null,
    });
  });

  it("rejects invalid history offsets without querying the service", async () => {
    expect(await loadDashboardHistory(-1)).toMatchObject({ ok: false });
    expect(mocks.taskList).not.toHaveBeenCalled();
  });

  it("loads older notes in bounded owner-scoped pages", async () => {
    const notes = Array.from({ length: 100 }, (_, index) => ({ id: `note-${index}` }));
    mocks.noteList.mockResolvedValue(notes);
    expect(await loadMoreDashboardNotes(100)).toMatchObject({
      ok: true,
      notes,
      hasMore: true,
    });
    expect(mocks.noteList).toHaveBeenCalledWith(principal, { limit: 100, offset: 100 });
    mocks.noteList.mockResolvedValue([{ id: "last-note" }]);
    expect(await loadMoreDashboardNotes(200)).toMatchObject({
      ok: true,
      notes: [{ id: "last-note" }],
      hasMore: false,
    });
  });
});

describe("dashboard schedule loading", () => {
  it("normalizes any date in the week to its Monday and loads through the shared services", async () => {
    const schedule = { weekStart: "2026-10-12", events: [], blocks: [], truncated: false };
    mocks.loadSchedule.mockResolvedValue(schedule);
    const result = await loadDashboardSchedule("2026-10-15");
    expect(result).toEqual({ ok: true, schedule });
    expect(mocks.loadSchedule).toHaveBeenCalledWith(expect.anything(), "2026-10-12");
  });

  it("rejects malformed or impossible dates without touching the services", async () => {
    for (const bad of ["", "tomorrow", "2026-13-01", "2026-02-30", "2026-10-1"]) {
      expect(await loadDashboardSchedule(bad)).toEqual({
        ok: false,
        error: "That week is not valid. Refresh and try again.",
      });
    }
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.loadSchedule).not.toHaveBeenCalled();
  });

  it("reports a failed load without exposing the cause", async () => {
    mocks.loadSchedule.mockRejectedValue(new Error("mysql://secret-host refused"));
    const result = await loadDashboardSchedule("2026-10-12");
    expect(result).toEqual({
      ok: false,
      error: "The schedule could not be loaded. Your tasks and notes are unchanged.",
    });
  });
});

describe("dashboard schedule changes", () => {
  it("saves a timed event using the configured timezone, not the browser's", async () => {
    mocks.eventCreate.mockResolvedValue({ id: "event-1" });
    const result = await addDashboardEvent(
      form({
        title: "Lecture",
        location: "Hall 2",
        date: "2026-10-14",
        startTime: "09:00",
        endTime: "10:30",
      }),
    );
    expect(result).toEqual({ ok: true, message: "Event saved." });
    expect(mocks.eventCreate).toHaveBeenCalledWith(principal, {
      title: "Lecture",
      location: "Hall 2",
      timezone: "America/Chicago",
      allDay: false,
      startsAt: new Date("2026-10-14T14:00:00.000Z"),
      endsAt: new Date("2026-10-14T15:30:00.000Z"),
    });
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("calculates an event end from its explicit duration", async () => {
    mocks.eventCreate.mockResolvedValue({ id: "event-2" });
    const result = await addDashboardEvent(
      form({
        title: "Dinner",
        date: "2026-10-14",
        startTime: "09:00",
        eventTimingMode: "duration",
        durationMinutes: "45",
      }),
    );
    expect(result).toMatchObject({ ok: true, message: "Event saved." });
    expect(mocks.eventCreate).toHaveBeenCalledWith(principal, {
      title: "Dinner",
      location: undefined,
      timezone: "America/Chicago",
      allDay: false,
      startsAt: new Date("2026-10-14T14:00:00.000Z"),
      endsAt: new Date("2026-10-14T14:45:00.000Z"),
    });
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("saves an all-day event as whole local days", async () => {
    mocks.eventCreate.mockResolvedValue({ id: "event-2" });
    await addDashboardEvent(form({ title: "Holiday", date: "2026-11-01", allDay: "on" }));
    expect(mocks.eventCreate).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        allDay: true,
        startsAt: new Date("2026-11-01T05:00:00.000Z"),
        // The fall-back day is 25 hours long.
        endsAt: new Date("2026-11-02T06:00:00.000Z"),
      }),
    );
  });

  it("rejects bad dates and times without calling the services", async () => {
    const bad = [
      { title: "x", date: "", startTime: "09:00", endTime: "10:00" },
      { title: "x", date: "2026-02-30", startTime: "09:00", endTime: "10:00" },
      { title: "x", date: "2026-10-14", startTime: "9am", endTime: "10:00" },
      { title: "x", date: "2026-10-14", startTime: "10:00", endTime: "10:00" },
      { title: "x", date: "2026-10-14", startTime: "11:00", endTime: "10:00" },
    ];
    for (const fields of bad) {
      expect(await addDashboardEvent(form(fields))).toMatchObject({ ok: false });
      expect(await addDashboardWorkBlock(form(fields))).toMatchObject({ ok: false });
    }
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    expect(mocks.blockCreate).not.toHaveBeenCalled();
  });

  it("saves a work block linked to a task as an explicit owner request", async () => {
    mocks.blockCreate.mockResolvedValue({ id: "block-1" });
    const result = await addDashboardWorkBlock(
      form({
        title: "Essay",
        taskId: "task-1",
        date: "2026-10-14",
        startTime: "14:00",
        endTime: "15:30",
      }),
    );
    expect(result).toEqual({ ok: true, message: "Work block saved." });
    expect(mocks.blockCreate).toHaveBeenCalledWith(
      principal,
      {
        title: "Essay",
        taskId: "task-1",
        startsAt: new Date("2026-10-14T19:00:00.000Z"),
        endsAt: new Date("2026-10-14T20:30:00.000Z"),
      },
      { intent: "explicit" },
    );
  });

  it("surfaces validation errors from the shared services", async () => {
    mocks.eventCreate.mockRejectedValue(new ValidationError(["title must not be empty"]));
    expect(
      await addDashboardEvent(form({ date: "2026-10-14", startTime: "09:00", endTime: "10:00" })),
    ).toEqual({ ok: false, error: "title must not be empty" });
  });

  it("cancels an event and removes a work block, reporting repeats honestly", async () => {
    mocks.eventCancel
      .mockResolvedValueOnce({ changed: true })
      .mockResolvedValueOnce({ changed: false });
    expect(await cancelDashboardEvent("e1")).toEqual({ ok: true, message: "Event canceled." });
    expect(await cancelDashboardEvent("e1")).toEqual({
      ok: true,
      message: "Event was already canceled.",
    });
    mocks.blockRemove.mockResolvedValue({ changed: true });
    expect(await removeDashboardWorkBlock("b1")).toMatchObject({ ok: true });
    expect(mocks.blockRemove).toHaveBeenCalledWith(principal, "b1", "manual", {
      intent: "explicit",
    });
  });

  it("reports an unexpected failure without exposing the cause", async () => {
    mocks.eventCancel.mockRejectedValue(new Error("mysql://secret-host refused"));
    const result = await cancelDashboardEvent("e1");
    expect(result).toEqual({
      ok: false,
      error: "The change could not be saved. Refresh and try again.",
    });
  });
});
