import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DashboardShell,
  EventList,
  EventRepeatFields,
  EventTimeEditor,
  TaskRow,
} from "./dashboard-shell";
import type { DashboardTask } from "./model";

vi.mock("./actions", () => ({}));
vi.mock("./reminders/actions", () => ({}));
vi.mock("./account-menu", () => ({ AccountMenu: () => null }));
vi.mock("./voice-actions", () => ({}));

describe("compact assistant dashboard", () => {
  it("offers a direct event date/time edit rather than requiring an assistant conversation", () => {
    const html = renderToStaticMarkup(
      createElement(EventTimeEditor, {
        event: {
          id: "godzilla",
          version: 2,
          title: "Watching Godzilla movie",
          location: null,
          startsAt: "2026-11-04T19:00:00Z",
          endsAt: "2026-11-04T21:00:00Z",
          allDay: false,
          timezone: "America/Chicago",
        },
        pending: false,
        onSave: () => {},
      }),
    );
    expect(html).toContain("Edit date or time");
    expect(html).not.toContain("<details");
  });
  it("uses accessible icon actions without dropping event facts or cancellation scope", () => {
    const html = renderToStaticMarkup(
      createElement(EventList, {
        result: {
          ok: true,
          events: [
            {
              id: "godzilla",
              version: 2,
              title: "GODZILLA MINUS ZERO",
              location: "Cinemark Davenport",
              startsAt: "2026-11-07T18:45:00Z",
              endsAt: "2026-11-07T19:45:00Z",
              allDay: false,
              timezone: "America/Chicago",
              seriesId: "series",
            },
          ],
          truncated: false,
        },
        search: "",
        pending: false,
        onCancel: () => {},
        onComplete: () => {},
        onEdit: () => {},
        clearSearch: () => {},
      }),
    );
    for (const label of ["Edit date or time", "Mark done", "Cancel occurrence", "Cancel series"]) {
      expect(html).toContain(`aria-label="${label}: GODZILLA MINUS ZERO"`);
      expect(html).toContain(`title="${label}"`);
      expect(html).not.toContain(`>${label}</button>`);
    }
    expect(html).toContain("<h2>GODZILLA MINUS ZERO</h2>");
    expect(html).toContain("Cinemark Davenport");
    expect(html).toContain("<dt>Duration</dt><dd>1 hour</dd>");
  });
  const task: DashboardTask = {
    id: "fixture",
    categoryId: "inbox",
    taskType: "task",
    title: "Test assignment",
    priority: "major",
    details: "Keep these detailed instructions available.",
    sourceText: null,
    reviewNote: "Confirm the deadline",
    status: "open",
    dueAt: "2026-10-29T12:00:00Z",
    dueDateOnly: false,
    estimatedMinutes: 45,
    completedAt: null,
    archivedAt: null,
    createdAt: "2026-10-28T12:00:00Z",
    version: 1,
  };
  function renderTask(value: DashboardTask) {
    return renderToStaticMarkup(
      createElement(TaskRow, {
        task: value,
        categories: [{ id: "inbox", name: "Inbox", systemKey: "inbox" }],
        timezone: "America/Chicago",
        now: new Date("2026-10-30T12:00:00Z"),
        pending: false,
        selected: false,
        onSelect: () => {},
        onComplete: () => {},
        onReopen: () => {},
        onCancel: () => {},
        onSave: () => {},
      }),
    );
  }
  it("separates status and labeled facts while keeping full task details accessible", () => {
    const html = renderTask(task);
    expect(html).toContain("Overdue");
    expect(html).toContain("Major priority");
    expect(html).toContain("<dt>Deadline</dt>");
    expect(html).toContain("<dt>Estimated effort</dt><dd>45 min</dd>");
    expect(html).toContain("<dt>Category</dt><dd>Inbox</dd>");
    expect(html).toContain("Needs review: Confirm the deadline");
    expect(html).toContain("<summary>Task details</summary>");
    expect(html).toContain(task.details);
    expect(html).not.toContain("<details open");
    expect(html).toContain("Mark done");
  });
  it("does not show overdue urgency or completion controls on a completed history record", () => {
    const html = renderTask({ ...task, status: "completed", completedAt: "2026-10-29T13:00:00Z" });
    expect(html).toContain("<dt>Completed</dt>");
    expect(html).not.toContain("Overdue");
    expect(html).not.toContain("Needs review");
    expect(html).not.toContain("Mark done");
    expect(html).toContain("Reopen");
  });
  it("keeps canceled task history distinct from completion and permits reopening", () => {
    const active = renderTask(task);
    expect(active).toContain('aria-label="Cancel: Test assignment"');
    const canceled = renderTask({ ...task, status: "canceled" });
    expect(canceled).toContain("Canceled, not completed");
    expect(canceled).not.toContain("Mark done");
    expect(canceled).toContain("Reopen");
  });
  it.each(["task", "todo"] as const)(
    "uses matching accessible icon actions for %s rows",
    (taskType) => {
      const html = renderTask({ ...task, taskType });
      for (const label of ["Edit", "Mark done", "Cancel"]) {
        expect(html).toContain(`aria-label="${label}: Test assignment"`);
        expect(html).toContain(`title="${label}"`);
        expect(html).not.toContain(`>${label}</button>`);
      }
      expect(html.indexOf('aria-label="Edit:')).toBeLessThan(
        html.indexOf('aria-label="Mark done:'),
      );
      expect(html.indexOf('aria-label="Mark done:')).toBeLessThan(
        html.indexOf('aria-label="Cancel:'),
      );
    },
  );
  it("keeps todo facts free of task-only deadline and priority fields", () => {
    const html = renderTask({
      ...task,
      taskType: "todo",
      dueAt: null,
      estimatedMinutes: null,
      reviewNote: null,
    });
    expect(html).toContain("No deadline");
    expect(html).not.toContain("<dt>Deadline</dt>");
    expect(html).not.toContain("<dt>Priority</dt>");
    expect(html).not.toContain("Major priority");
  });
  it("hides the occurrence count until a repeat schedule is selected", () => {
    const oneOff = renderToStaticMarkup(
      createElement(EventRepeatFields, {
        frequency: "none",
        onChange: () => {},
      }),
    );
    expect(oneOff).toContain('name="repeatFrequency"');
    expect(oneOff).not.toContain('name="repeatCount"');
    for (const frequency of ["daily", "weekly"] as const) {
      const repeating = renderToStaticMarkup(
        createElement(EventRepeatFields, {
          frequency,
          onChange: () => {},
        }),
      );
      expect(repeating).toContain(`value="${frequency}" selected`);
      expect(repeating).toContain('name="repeatCount"');
      expect(repeating).toContain('required=""');
    }
  });
  it("renders only five upcoming tasks while retaining the full task count and navigation", () => {
    const tasks: DashboardTask[] = Array.from({ length: 40 }, (_, index) => ({
      id: `task-${index}`,
      categoryId: "inbox",
      taskType: "task",
      title: `Assignment ${index + 1}`,
      priority: "minor",
      details: null,
      sourceText: null,
      reviewNote: null,
      status: "open",
      dueAt: `2026-10-${String(21 + Math.floor(index / 4)).padStart(2, "0")}T23:59:00-05:00`,
      dueDateOnly: false,
      estimatedMinutes: null,
      completedAt: null,
      archivedAt: null,
      createdAt: "2026-10-21T12:00:00Z",
      version: 1,
    }));
    const html = renderToStaticMarkup(
      createElement(DashboardShell, {
        initialData: {
          tasks,
          notes: [],
          categories: [{ id: "inbox", name: "Inbox", systemKey: "inbox" }],
          timezone: "America/Chicago",
          capturedAt: "2026-10-21T12:00:00Z",
          tasksTruncated: false,
          notesTruncated: false,
        },
        initialSchedule: null,
        assistantSetup: "ready",
        devBypass: true,
        owner: { displayName: "Test owner", avatarUrl: null },
        voice: { listen: false, speak: false },
      }),
    );
    expect(html.match(/aria-label="Select Assignment /g)).toHaveLength(5);
    expect(html).toContain("Select Assignment 5");
    expect(html).not.toContain("Select Assignment 6");
    expect(html).toContain("Checkboxes select tasks; they do not mark them done.");
    expect(html).toContain("Mark selected done (0)");
    expect(html).toContain("Select this page");
    expect(html).toContain("View all tasks");
    expect(html).toContain("View this week");
    expect(html).toContain(">40<");
    expect(html).toContain("<span>Calendar</span>");
    expect(html).not.toContain("<span>Today</span>");
    expect(html).not.toContain("<span>Week</span>");
    expect(html).toContain('data-kind="task"');
    expect(html).toContain("Deadline task");
    expect(html).toContain('href="/dashboard/planning"');
    expect(html).toContain('href="/dashboard/calendars"');
    expect(html).toContain("Personal field station");
    expect(html).toContain("PERSONAL OPERATIONS / EPIPHANY");
    expect(html).not.toContain('id="dashboard-categories" hidden=""');
  });
});
