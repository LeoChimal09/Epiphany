import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDashboardSchedule } from "./actions";
import { CalendarView, loadCalendarSchedule, MonthView } from "./calendar-view";
import type { ScheduleData } from "./schedule";
import type { DashboardTask } from "./model";

vi.mock("./actions", () => ({ loadDashboardSchedule: vi.fn() }));

const schedule: ScheduleData = {
  weekStart: "2026-10-19",
  events: [
    {
      id: "event",
      title: "Lecture",
      location: null,
      startsAt: "2026-10-21T15:00:00Z",
      endsAt: "2026-10-21T16:00:00Z",
      allDay: false,
      timezone: "America/Chicago",
    },
  ],
  blocks: [
    {
      id: "work",
      title: "Study",
      taskId: null,
      startsAt: "2026-10-21T17:00:00Z",
      endsAt: "2026-10-21T18:00:00Z",
    },
  ],
  truncated: false,
};

const task: DashboardTask = {
  id: "task",
  categoryId: "inbox",
  taskType: "task",
  title: "Homework",
  priority: "minor",
  details: null,
  sourceText: null,
  reviewNote: null,
  status: "open",
  dueAt: "2026-10-22T04:59:00Z",
  dueDateOnly: false,
  estimatedMinutes: null,
  completedAt: null,
  archivedAt: null,
  createdAt: "2026-10-21T12:00:00Z",
  version: 1,
};

beforeEach(() => vi.resetAllMocks());

describe("unified calendar", () => {
  it("offers Day, Week, Month and date navigation in a single view", () => {
    const html = renderToStaticMarkup(
      createElement(CalendarView, {
        initialSchedule: schedule,
        initialMode: "day",
        tasks: [task],
        timezone: "America/Chicago",
        today: "2026-10-21",
        now: new Date("2026-10-21T19:00:00Z"),
        pending: false,
        onComplete: () => {},
        onRemove: () => {},
      }),
    );
    expect(html).toContain('aria-label="Calendar view"');
    expect(html).toContain('aria-pressed="true">Day');
    expect(html).toContain(">Week</button>");
    expect(html).toContain(">Month</button>");
    expect(html).toContain('aria-label="Previous day"');
    expect(html).toContain('aria-label="Next day"');
    expect(html).toContain("Homework");
    expect(html).toContain("Due at 11:59 PM");
    expect(html).toContain("Lecture");
    expect(html).toContain('aria-label="Due at 11:59 PM: Homework"');
    expect(html).toContain('aria-label="Complete Homework"');
    expect(html).toMatch(/class="[^"]*agendaComplete[^"]*"[^>]*>Mark done<\/button>/);
    expect(html).toMatch(
      /class="[^"]*slotDeadline[^"]*" style="[^"]*transform:translateY\(-50%\);[^"]*max-width:calc\(100% - 8px\)/,
    );
  });

  it("renders a bounded month with deadlines, events, work blocks, and today's marker", () => {
    const html = renderToStaticMarkup(
      createElement(MonthView, {
        schedule,
        tasks: [task, ...Array.from({ length: 4 }, (_, i) => ({ ...task, id: `extra-${i}` }))],
        timezone: "America/Chicago",
        date: "2026-10-21",
        today: "2026-10-21",
        onSelect: () => {},
      }),
    );
    expect(html.match(/<button/g)).toHaveLength(35);
    expect(html).toContain('aria-current="date"');
    expect(html).toContain("Wednesday, Oct 21, 7 items");
    expect(html).toContain("Due at 11:59 PM: Homework");
    expect(html).toContain("+4 more");
    const simple = renderToStaticMarkup(
      createElement(MonthView, {
        schedule,
        tasks: [task],
        timezone: "America/Chicago",
        date: "2026-10-21",
        today: "2026-10-21",
        onSelect: () => {},
      }),
    );
    expect(simple).toContain("Event: Lecture");
    expect(simple).toContain("Work: Study");
  });

  it("marks only dates before the owner's today as past without hiding their items", () => {
    const html = renderToStaticMarkup(
      createElement(MonthView, {
        schedule,
        tasks: [task],
        timezone: "America/Chicago",
        date: "2026-10-22",
        today: "2026-10-22",
        onSelect: () => {},
      }),
    );
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
    const yesterday = buttons.find((button) => button.includes("Wednesday, Oct 21,"))!;
    expect(yesterday).toContain("past day");
    expect(yesterday).toContain(">Past</span>");
    expect(yesterday).toContain("monthPast");
    expect(yesterday).toContain("Due at 11:59 PM: Homework");
    expect(yesterday).toContain("Event: Lecture");
    expect(yesterday).not.toContain('aria-current="date"');
    const today = buttons.find((button) => button.includes("Thursday, Oct 22,"))!;
    expect(today).toContain('aria-current="date"');
    expect(today).toContain("monthToday");
    expect(today).toContain(">Today</span>");
    expect(today).not.toContain("monthPast");
    const tomorrow = buttons.find((button) => button.includes("Friday, Oct 23,"))!;
    expect(tomorrow).not.toContain("past day");
    expect(tomorrow).not.toContain(">Past</span>");
    expect(tomorrow).not.toContain("monthPast");
    expect(buttons[0]).toContain("past day");
    expect(buttons.at(-1)).not.toContain("past day");
    expect(buttons.every((button) => !button.includes("disabled"))).toBe(true);
  });

  it("loads every week in a month and deduplicates records crossing week boundaries", async () => {
    vi.mocked(loadDashboardSchedule).mockResolvedValue({
      ok: true,
      schedule: { ...schedule, truncated: true },
    });
    const result = await loadCalendarSchedule("2026-09-28", 5, schedule);
    expect(vi.mocked(loadDashboardSchedule).mock.calls.map(([week]) => week)).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-26",
    ]);
    expect(result.events).toHaveLength(1);
    expect(result.blocks).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.weekStart).toBe("2026-09-28");
  });

  it("surfaces a failed week rather than returning an incomplete success-shaped month", async () => {
    vi.mocked(loadDashboardSchedule).mockResolvedValue({
      ok: false,
      error: "Calendar unavailable.",
    });
    await expect(loadCalendarSchedule("2026-09-28", 5, schedule)).rejects.toThrow(
      "Calendar unavailable.",
    );
  });
});
