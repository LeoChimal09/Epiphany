import { describe, expect, it } from "vitest";
import {
  countdownLabel,
  dateTimeLocalValue,
  formatDate,
  localDateTimeToIso,
  parseEffort,
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

  it("builds a priorities view from due tasks across categories only", () => {
    const tasks = [
      task({ id: "school", categoryId: "school", dueAt: "2026-10-15T00:00:00Z" }),
      task({ id: "fitness", categoryId: "fitness", dueAt: "2026-10-14T00:00:00Z" }),
      task({ id: "no-date", dueAt: null }),
      task({ id: "done", status: "completed", dueAt: "2026-10-14T00:00:00Z" }),
    ];
    expect(visibleTasks(tasks, "priorities", "").map((item) => item.id)).toEqual([
      "fitness",
      "school",
    ]);
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
      "Due today",
    );
    expect(countdownLabel("2026-10-15T00:00:00.000Z", "America/Chicago", true, now)).toBe(
      "Due tomorrow",
    );
    expect(countdownLabel("2026-10-13T21:00:00.000Z", "America/Chicago", false, now)).toBe(
      "Overdue 1 day",
    );
  });

  it("formats timestamps in the configured timezone", () => {
    expect(formatDate("2026-10-14T01:00:00Z", "America/Chicago")).toContain("Oct 13");
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
