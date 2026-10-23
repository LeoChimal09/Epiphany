import { describe, expect, it } from "vitest";
import {
  buildDay,
  currentMinute,
  formatDayLabel,
  formatDuration,
  formatHourLabel,
  formatWeekRange,
  hourBounds,
  markConflicts,
  monthDays,
  shiftMonth,
  timelineItems,
  weekDays,
  weekStartOf,
  type ScheduleData,
} from "./schedule";
import type { DashboardTask } from "./model";
import { localWallToUtc } from "@epiphany/core/planning";
import { parseCourseList } from "../../../../packages/core/src/assistant/intake";
import { COURSE_LIST_PASTE } from "../../../../packages/core/src/assistant/course-list.fixture";

const CHICAGO = "America/Chicago";

// Wednesday 2026-10-14, Chicago daylight time (UTC-5).
const iso = (local: string) => new Date(`${local}:00-05:00`).toISOString();

const schedule = (over: Partial<ScheduleData> = {}): ScheduleData => ({
  weekStart: "2026-10-12",
  events: [],
  blocks: [],
  truncated: false,
  ...over,
});

const event = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  location: null,
  startsAt: iso(from),
  endsAt: iso(to),
  allDay: false,
  timezone: CHICAGO,
  ...extra,
});

const block = (id: string, from: string, to: string) => ({
  id,
  taskId: null,
  title: null,
  startsAt: iso(from),
  endsAt: iso(to),
});

const task = (over: Partial<DashboardTask>): DashboardTask => ({
  id: "task",
  categoryId: "inbox",
  title: "Task",
  details: null,
  sourceText: null,
  reviewNote: null,
  status: "open",
  dueAt: null,
  dueDateOnly: false,
  estimatedMinutes: null,
  completedAt: null,
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  version: 1,
  ...over,
});

describe("week math", () => {
  it("builds complete Monday-first months with spillover days and leap years", () => {
    const october = monthDays("2026-10-21");
    expect(october).toHaveLength(35);
    expect(october[0]).toBe("2026-09-28");
    expect(october.at(-1)).toBe("2026-11-01");
    expect(october.filter((day) => day.startsWith("2026-10"))).toHaveLength(31);
    expect(monthDays("2028-02-12")).toContain("2028-02-29");
    expect(monthDays("2026-02-12")).not.toContain("2026-02-29");
    expect(monthDays("2021-02-01")).toHaveLength(28);
    expect(monthDays("2026-03-01")).toHaveLength(42);
  });

  it("navigates months without skipping short months or breaking year boundaries", () => {
    expect(shiftMonth("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftMonth("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
  });

  it("places all six imported assignments on their local due dates without inventing work blocks", () => {
    const capture = parseCourseList(COURSE_LIST_PASTE, "2026-10-21");
    if (capture?.kind !== "capture") throw new Error("expected course capture");
    const tasks = capture.items.map((item, index) => {
      if (!item.dueDate || !item.dueTime) throw new Error("expected assignment deadline");
      const [hours, minutes] = item.dueTime.split(":").map(Number);
      return task({
        id: `assignment-${index}`,
        title: item.title,
        dueAt: localWallToUtc(item.dueDate, hours! * 60 + minutes!, CHICAGO).toISOString(),
      });
    });
    const days = ["2026-10-21", "2026-10-22", "2026-10-25", "2026-10-26"].map((date) =>
      buildDay(date, [], tasks, CHICAGO),
    );
    expect(days.map((day) => day.deadlines.length)).toEqual([1, 1, 3, 1]);
    expect(days.flatMap((day) => day.deadlines)).toHaveLength(6);
    expect(days.every((day) => day.entries.length === 0)).toBe(true);
  });

  it("finds Monday and lists seven days", () => {
    expect(weekStartOf("2026-10-14")).toBe("2026-10-12");
    expect(weekStartOf("2026-10-12")).toBe("2026-10-12");
    expect(weekStartOf("2026-10-18")).toBe("2026-10-12");
    expect(weekDays("2026-10-12")).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
  });

  it("crosses month and year boundaries", () => {
    expect(weekDays("2026-12-28").at(-1)).toBe("2027-01-03");
    expect(weekStartOf("2027-01-01")).toBe("2026-12-28");
  });
});

describe("conflicts", () => {
  const items = timelineItems(
    schedule({
      events: [event("lecture", "2026-10-14T10:00", "2026-10-14T11:30")],
      blocks: [
        block("overlaps", "2026-10-14T11:00", "2026-10-14T12:00"),
        block("after", "2026-10-14T12:00", "2026-10-14T13:00"),
        block("clear", "2026-10-14T14:00", "2026-10-14T15:00"),
      ],
    }),
  );
  const flagged = (id: string) => items.find((item) => item.id === id)?.conflict;

  it("flags genuine overlaps between events and work blocks", () => {
    expect(flagged("lecture")).toBe(true);
    expect(flagged("overlaps")).toBe(true);
  });

  it("does not flag back-to-back or separate items", () => {
    // "after" starts exactly when "overlaps" ends.
    expect(flagged("after")).toBe(false);
    expect(flagged("clear")).toBe(false);
    const back = markConflicts(
      timelineItems(
        schedule({
          events: [event("a", "2026-10-14T09:00", "2026-10-14T10:00")],
          blocks: [block("b", "2026-10-14T10:00", "2026-10-14T11:00")],
        }),
      ),
    );
    expect(back.every((item) => !item.conflict)).toBe(true);
  });

  it("never marks all-day events as conflicts", () => {
    const result = timelineItems(
      schedule({
        events: [
          event("holiday", "2026-10-14T00:00", "2026-10-15T00:00", { allDay: true }),
          event("class", "2026-10-14T09:00", "2026-10-14T10:00"),
        ],
      }),
    );
    expect(result.every((item) => !item.conflict)).toBe(true);
  });
});

describe("a day's timeline", () => {
  const data = schedule({
    events: [
      event("lecture", "2026-10-14T10:00", "2026-10-14T11:30"),
      event("holiday", "2026-10-14T00:00", "2026-10-15T00:00", { allDay: true }),
    ],
    blocks: [block("study", "2026-10-14T11:00", "2026-10-14T12:00")],
  });
  const tasks = [
    task({ id: "due", dueAt: iso("2026-10-14T17:00"), estimatedMinutes: 90 }),
    task({
      id: "due-date-only",
      dueAt: "2026-10-14T00:00:00.000Z",
      dueDateOnly: true,
      estimatedMinutes: 30,
    }),
    task({ id: "tomorrow", dueAt: iso("2026-10-15T09:00"), estimatedMinutes: 60 }),
    task({ id: "late-night", dueAt: "2026-10-15T04:30:00.000Z", estimatedMinutes: 10 }),
    task({ id: "finished", status: "completed", completedAt: iso("2026-10-14T08:15") }),
    task({ id: "finished-before", status: "completed", completedAt: iso("2026-10-13T08:15") }),
  ];
  const day = buildDay("2026-10-14", timelineItems(data), tasks, CHICAGO);

  it("places timed items by local minute and keeps all-day events separate", () => {
    const lecture = day.entries.find((entry) => entry.item.id === "lecture");
    expect(lecture).toMatchObject({ startMinute: 600, endMinute: 690 });
    expect(day.allDay.map((item) => item.id)).toEqual(["holiday"]);
    expect(day.entries.map((entry) => entry.item.id)).not.toContain("holiday");
  });

  it("lays overlapping items side by side and leaves others full width", () => {
    const columns = day.entries.map((entry) => [entry.item.id, entry.column, entry.columns]);
    expect(columns).toEqual([
      ["lecture", 0, 2],
      ["study", 1, 2],
    ]);
    const lone = buildDay(
      "2026-10-14",
      timelineItems(schedule({ blocks: [block("solo", "2026-10-14T15:00", "2026-10-14T16:00")] })),
      [],
      CHICAGO,
    );
    expect(lone.entries[0]).toMatchObject({ column: 0, columns: 1 });
  });

  it("counts conflicts, planned work, and due effort for the day", () => {
    expect(day.conflictCount).toBe(2);
    expect(day.plannedMinutes).toBe(60);
    // 23:30 local on the 14th is 04:30Z on the 15th, so that task is still due on the 14th.
    expect(day.deadlines.map((entry) => entry.id).toSorted()).toEqual([
      "due",
      "due-date-only",
      "late-night",
    ]);
    expect(day.dueEffortMinutes).toBe(130);
  });

  it("lists tasks completed that local day for history access", () => {
    expect(day.completed.map((entry) => entry.id)).toEqual(["finished"]);
  });

  it("clips an item that runs past midnight to each day it touches", () => {
    const overnight = timelineItems(
      schedule({ blocks: [block("late", "2026-10-14T23:00", "2026-10-15T01:00")] }),
    );
    const first = buildDay("2026-10-14", overnight, [], CHICAGO);
    const second = buildDay("2026-10-15", overnight, [], CHICAGO);
    expect(first.entries[0]).toMatchObject({ startMinute: 1380, endMinute: 1440 });
    expect(second.entries[0]).toMatchObject({ startMinute: 0, endMinute: 60 });
    expect(first.plannedMinutes).toBe(60);
    expect(second.plannedMinutes).toBe(60);
  });

  it("keeps a multi-day all-day event on every day it covers and no others", () => {
    const trip = timelineItems(
      schedule({
        events: [event("trip", "2026-10-14T00:00", "2026-10-17T00:00", { allDay: true })],
      }),
    );
    const covered = (date: string) => buildDay(date, trip, [], CHICAGO).allDay.length;
    expect([
      covered("2026-10-13"),
      covered("2026-10-14"),
      covered("2026-10-16"),
      covered("2026-10-17"),
    ]).toEqual([0, 1, 1, 0]);
  });

  it("gives zero-length events a visible height", () => {
    const point = timelineItems(
      schedule({ events: [event("ping", "2026-10-14T09:00", "2026-10-14T09:00")] }),
    );
    const entry = buildDay("2026-10-14", point, [], CHICAGO).entries[0];
    expect(entry!.endMinute - entry!.startMinute).toBeGreaterThan(0);
  });
});

describe("formatting and bounds", () => {
  it("widens hour bounds to fit early and late items", () => {
    const early = buildDay(
      "2026-10-14",
      timelineItems(schedule({ blocks: [block("dawn", "2026-10-14T05:30", "2026-10-14T06:30")] })),
      [],
      CHICAGO,
    );
    const late = buildDay(
      "2026-10-14",
      timelineItems(schedule({ blocks: [block("night", "2026-10-14T21:30", "2026-10-14T22:15")] })),
      [],
      CHICAGO,
    );
    expect(hourBounds([])).toEqual({ start: 7, end: 21 });
    expect(hourBounds([early, late])).toEqual({ start: 5, end: 23 });
  });

  it("reports the current minute only on today's date", () => {
    const now = new Date("2026-10-14T15:30:00Z");
    expect(currentMinute(CHICAGO, "2026-10-14", now)).toBe(10 * 60 + 30);
    expect(currentMinute(CHICAGO, "2026-10-15", now)).toBeNull();
  });

  it("formats labels", () => {
    expect(formatDayLabel("2026-10-14")).toBe("Wed, Oct 14");
    expect(formatDayLabel("2026-10-14", "long")).toBe("Wednesday, Oct 14");
    expect(formatWeekRange("2026-10-12")).toBe("Oct 12 to Oct 18");
    expect(formatHourLabel(0)).toBe("12 AM");
    expect(formatHourLabel(13)).toBe("1 PM");
    expect(formatHourLabel(24)).toBe("12 AM");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(120)).toBe("2 hr");
    expect(formatDuration(95)).toBe("1 hr 35 min");
  });
});

describe("daylight saving days", () => {
  it("places items by wall-clock minute on a 25-hour fall-back day", () => {
    // 2026-11-01 in Chicago: 08:00 CST is 14:00Z.
    const data = schedule({
      weekStart: "2026-10-26",
      blocks: [
        {
          id: "morning",
          taskId: null,
          title: null,
          startsAt: "2026-11-01T14:00:00.000Z",
          endsAt: "2026-11-01T15:00:00.000Z",
        },
      ],
    });
    const entry = buildDay("2026-11-01", timelineItems(data), [], CHICAGO).entries[0];
    expect(entry).toMatchObject({ startMinute: 480, endMinute: 540 });
  });
});
