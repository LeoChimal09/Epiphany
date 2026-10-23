import { describe, expect, it } from "vitest";
import {
  countdownLabel,
  deadlineNotifications,
  dateTimeLocalValue,
  formatDate,
  localDateTimeToIso,
  parseEffort,
  taskPage,
  visibleHistoryTasks,
  visibleNotes,
  visibleTasks,
  type DashboardTask,
} from "./model";

const task = (overrides: Partial<DashboardTask> = {}): DashboardTask => ({
  id: "task-one",
  categoryId: "inbox",
  title: "Chemistry worksheet",
  details: "Chapter three",
  sourceText: null,
  reviewNote: null,
  status: "open",
  dueAt: null,
  dueDateOnly: false,
  estimatedMinutes: 45,
  completedAt: null,
  archivedAt: null,
  createdAt: "2026-10-13T12:00:00.000Z",
  version: 1,
  ...overrides,
});

describe("dashboard views", () => {
  it("pages large task lists without losing records or changing their order", () => {
    const tasks = Array.from({ length: 101 }, (_, index) => task({ id: `task-${index}` }));
    const pages = Array.from({ length: 6 }, (_, page) => taskPage(tasks, page));
    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 20, 20, 20, 1]);
    expect(pages.flatMap((page) => page.items)).toEqual(tasks);
    expect(pages[0]?.pages).toBe(6);
    expect(taskPage(tasks, 100).page).toBe(5);
    expect(taskPage(tasks, -1).page).toBe(0);
    expect(taskPage(tasks.slice(0, 5), 5).page).toBe(0);
    expect(taskPage([], 0)).toEqual({ items: [], page: 0, pages: 1 });
  });

  it("keeps completed tasks out of the active list without discarding history", () => {
    const tasks = [task(), task({ id: "done", status: "completed" })];
    expect(visibleTasks(tasks, "tasks", "").map((item) => item.id)).toEqual(["task-one"]);
    expect(visibleTasks(tasks, "completed", "").map((item) => item.id)).toEqual(["done"]);
    expect(tasks).toHaveLength(2);
    expect(visibleTasks(tasks, "notes", "")).toEqual([]);
  });

  it("searches titles and details, ignoring case and surrounding whitespace", () => {
    expect(visibleTasks([task()], "tasks", " CHAPTER ")).toHaveLength(1);
    expect(visibleTasks([task()], "tasks", "chemISTRY")).toHaveLength(1);
    expect(visibleTasks([task()], "tasks", "history")).toEqual([]);
  });

  it("sorts dated work before undated work without mutating the snapshot", () => {
    const tasks = [task(), task({ id: "due", dueAt: "2026-10-14T18:00:00Z" })];
    expect(visibleTasks(tasks, "tasks", "").map((item) => item.id)).toEqual(["due", "task-one"]);
    expect(tasks[0]?.id).toBe("task-one");
  });

  it("shows recently completed work first", () => {
    const tasks = [
      task({ id: "old", status: "completed", completedAt: "2025-10-01T12:00:00Z" }),
      task({ id: "new", status: "completed", completedAt: "2026-10-13T12:00:00Z" }),
    ];
    expect(visibleTasks(tasks, "completed", "").map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("filters planned and plain tasks within one task view across categories", () => {
    const tasks = [
      task({ id: "school", categoryId: "school", dueAt: "2026-10-15T00:00:00Z" }),
      task({ id: "fitness", categoryId: "fitness", dueAt: "2026-10-14T00:00:00Z" }),
      task({ id: "duration", title: "Duration task", dueAt: null, estimatedMinutes: 30 }),
      task({ id: "plain", dueAt: null, estimatedMinutes: null }),
      task({ id: "done", status: "completed", dueAt: "2026-10-14T00:00:00Z" }),
    ];
    expect(visibleTasks(tasks, "tasks", "", null, "planned").map((item) => item.id)).toEqual([
      "fitness",
      "school",
      "duration",
    ]);
    expect(visibleTasks(tasks, "tasks", "", null, "plain").map((item) => item.id)).toEqual([
      "plain",
    ]);
    expect(visibleTasks(tasks, "tasks", "", null, "all")).toHaveLength(4);
    expect(visibleTasks(tasks, "tasks", "duration", null, "planned")).toHaveLength(1);
    expect(visibleTasks(tasks, "tasks", "", "fitness", "planned").map((item) => item.id)).toEqual([
      "fitness",
    ]);
    expect(visibleTasks(tasks, "tasks", "missing", null, "plain")).toEqual([]);
  });

  it("searches saved notes and ideas even without a title", () => {
    const notes = [
      {
        id: "idea",
        categoryId: "inbox",
        title: null,
        body: "Workout app",
        kind: "idea" as const,
        createdAt: "",
        version: 1,
      },
    ];
    expect(visibleNotes(notes, "WORKOUT")).toHaveLength(1);
    expect(visibleNotes(notes, "chemistry")).toEqual([]);
  });

  it("filters task and note records to the selected category", () => {
    const tasks = [task(), task({ id: "school-task", categoryId: "school", title: "Study guide" })];
    const notes = [
      {
        id: "idea",
        categoryId: "inbox",
        title: null,
        body: "Workout app",
        kind: "idea" as const,
        createdAt: "",
        version: 1,
      },
    ];
    expect(visibleTasks(tasks, "category", "", "inbox").map((item) => item.id)).toEqual([
      "task-one",
    ]);
    expect(visibleNotes(notes, "", "school")).toEqual([]);
    expect(visibleNotes(notes, "", "inbox")).toHaveLength(1);
  });

  it("filters history by text, category, status, and date in the owner's timezone", () => {
    const history = [
      task({
        id: "old-work",
        title: "Annual review",
        details: "Project retrospective",
        sourceText: "Department: Operations",
        categoryId: "work",
        status: "completed",
        createdAt: "2025-06-10T16:00:00.000Z",
        completedAt: "2025-06-11T16:00:00.000Z",
      }),
      task({ id: "current", title: "Gym session", categoryId: "fitness" }),
      task({
        id: "archived",
        title: "Old report",
        archivedAt: "2024-01-01T00:00:00.000Z",
      }),
    ];
    const categories = [
      { id: "work", name: "Work", systemKey: null },
      { id: "fitness", name: "Fitness", systemKey: null },
    ];
    expect(
      visibleHistoryTasks(
        history,
        {
          status: "completed",
          search: "OPERATIONS",
          categoryId: "work",
          from: "2025-06-01",
          through: "2025-06-30",
        },
        categories,
        "America/Chicago",
      ).map((item) => item.id),
    ).toEqual(["old-work"]);
    expect(
      visibleHistoryTasks(
        history,
        { status: "all", search: "fitness", categoryId: "", from: "", through: "" },
        categories,
        "America/Chicago",
      ).map((item) => item.id),
    ).toEqual(["current"]);
  });
});

describe("dashboard dates and effort", () => {
  it("counts down in the owner's timezone for timed and date-only deadlines", () => {
    const now = new Date("2026-10-14T18:00:00.000Z");
    expect(countdownLabel("2026-10-14T22:00:00.000Z", "America/Chicago", false, now)).toBe(
      "Due in 4 hours",
    );
    expect(countdownLabel("2026-10-15T00:00:00.000Z", "America/Chicago", true, now)).toBe(
      "Due tomorrow",
    );
    expect(countdownLabel("2026-10-13T21:00:00.000Z", "America/Chicago", false, now)).toBe(
      "Overdue 21 hours",
    );
  });

  it.each([
    ["2026-10-22T09:41:00-05:00", "Due in 1 hour 1 minute"],
    ["2026-10-22T09:40:00-05:00", "Due in 1 hour"],
    ["2026-10-22T08:45:00-05:00", "Due in 5 minutes"],
    ["2026-10-22T08:40:30-05:00", "Due in less than 1 minute"],
    ["2026-10-22T08:40:00-05:00", "Due now"],
    ["2026-10-22T08:39:30-05:00", "Overdue less than 1 minute"],
    ["2026-10-22T08:35:00-05:00", "Overdue 5 minutes"],
    ["2026-10-22T07:10:00-05:00", "Overdue 1 hour 30 minutes"],
    ["2026-10-21T23:59:00-05:00", "Overdue 8 hours 41 minutes"],
    ["2026-10-21T07:10:00-05:00", "Overdue 1 day 1 hour 30 minutes"],
  ])("uses elapsed time for timed deadline %s", (dueAt, label) => {
    expect(
      countdownLabel(dueAt, "America/Chicago", false, new Date("2026-10-22T08:40:00-05:00")),
    ).toBe(label);
  });

  it("keeps date-only labels calendar-based throughout the local due day", () => {
    const due = "2026-10-22T00:00:00.000Z";
    for (const now of ["2026-10-22T00:01:00-05:00", "2026-10-22T23:59:59-05:00"]) {
      expect(countdownLabel(due, "America/Chicago", true, new Date(now))).toBe("Due today");
    }
    expect(
      countdownLabel(due, "America/Chicago", true, new Date("2026-10-23T00:00:00-05:00")),
    ).toBe("Overdue 1 day");
  });

  it("uses actual elapsed time across the daylight-saving fall-back", () => {
    expect(
      countdownLabel(
        "2026-11-01T01:30:00-06:00",
        "America/Chicago",
        false,
        new Date("2026-11-01T01:30:00-05:00"),
      ),
    ).toBe("Due in 1 hour");
  });

  it("formats timestamps in the configured timezone", () => {
    expect(formatDate("2026-10-14T01:00:00Z", "America/Chicago")).toContain("Oct 13");
  });

  describe("live deadline notifications", () => {
    const now = new Date("2026-10-22T08:40:00-05:00");
    const notifications = (tasks: DashboardTask[], clock = now) =>
      deadlineNotifications(tasks, "America/Chicago", clock);

    it.each([
      [61, null],
      [60, "due-soon"],
      [5, "due-soon"],
      [0, "due-now"],
      [-1, "overdue"],
      [-90, "overdue"],
      [-521, "overdue"],
    ])("warns at the one-hour boundary, not before (%i minutes)", (minutes, kind) => {
      const dueAt = new Date(now.getTime() + minutes * 60_000).toISOString();
      const result = notifications([task({ dueAt })]);
      expect(result.map((item) => item.kind)).toEqual(kind ? [kind] : []);
    });

    it("keeps overdue work visible across refreshes and days without changing it", () => {
      const original = task({ dueAt: "2026-10-21T23:59:00-05:00" });
      expect(notifications([original])[0]?.label).toBe("Overdue 8 hours 41 minutes");
      expect(notifications([original], new Date("2026-10-24T08:40:00-05:00"))[0]?.kind).toBe(
        "overdue",
      );
      expect(original.status).toBe("open");
      expect(original.completedAt).toBeNull();
      expect(notifications([{ ...original, status: "completed" }])).toEqual([]);
    });

    it("excludes completed, archived, undated, and invalid tasks", () => {
      const dueAt = now.toISOString();
      expect(
        notifications([
          task({ status: "completed", dueAt }),
          task({ archivedAt: now.toISOString(), dueAt }),
          task(),
          task({ dueAt: "invalid" }),
        ]),
      ).toEqual([]);
    });

    it("does not invent a time for date-only work, including near local midnight", () => {
      const tasks = [
        task({ id: "yesterday", dueAt: "2026-10-21T00:00:00Z", dueDateOnly: true }),
        task({ id: "today", dueAt: "2026-10-22T00:00:00Z", dueDateOnly: true }),
        task({ id: "tomorrow", dueAt: "2026-10-23T00:00:00Z", dueDateOnly: true }),
      ];
      expect(notifications(tasks).map(({ task, kind, label }) => [task.id, kind, label])).toEqual([
        ["yesterday", "overdue", "Overdue 1 day"],
        ["today", "due-today", "Due today"],
      ]);
      expect(notifications([tasks[1]!], new Date("2026-10-22T23:59:59-05:00"))[0]?.kind).toBe(
        "due-today",
      );
      expect(notifications([tasks[1]!], new Date("2026-10-23T00:00:00-05:00"))[0]?.kind).toBe(
        "overdue",
      );
    });

    it("keeps imminent warnings ahead of overdue backlogs without changing the authorized snapshot", () => {
      const tasks = [
        task({ id: "soon", dueAt: "2026-10-22T09:40:00-05:00" }),
        task({ id: "late", dueAt: "2026-10-21T23:59:00-05:00" }),
      ];
      expect(notifications(tasks).map((item) => item.task.id)).toEqual(["soon", "late"]);
      expect(tasks.map((task) => task.id)).toEqual(["soon", "late"]);
    });
  });

  it("does not shift a date-only deadline to the previous calendar day", () => {
    expect(formatDate("2026-10-14T00:00:00Z", "America/Chicago", true)).toBe("Oct 14, 2026");
  });

  it("round-trips configured-zone datetime-local values without using the device timezone", () => {
    const instant = localDateTimeToIso("2026-10-13T09:30", "America/Chicago");
    expect(instant).toBe("2026-10-13T14:30:00.000Z");
    expect(dateTimeLocalValue(instant, "America/Chicago")).toBe("2026-10-13T09:30");
  });

  it("rejects local times skipped by a daylight-saving transition", () => {
    expect(() => localDateTimeToIso("2026-03-08T02:30", "America/Chicago")).toThrow(
      "timezone clock change",
    );
  });

  it("handles missing and invalid dates", () => {
    expect(formatDate(null, "UTC")).toBe("No deadline");
    expect(formatDate("invalid", "UTC")).toBe("Date unavailable");
  });

  it("accepts optional positive whole-minute estimates", () => {
    expect(parseEffort(null)).toBeUndefined();
    expect(parseEffort("")).toBeUndefined();
    expect(parseEffort("45")).toBe(45);
  });

  it.each(["0", "-1", "1.5", "NaN", "100001", " "])("rejects invalid effort %s", (value) => {
    expect(() => parseEffort(value)).toThrow();
  });
});
