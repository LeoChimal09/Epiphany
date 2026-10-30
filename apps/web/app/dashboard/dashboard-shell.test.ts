import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DashboardShell, EventRepeatFields } from "./dashboard-shell";
import type { DashboardTask } from "./model";

vi.mock("./actions", () => ({}));
vi.mock("./reminders/actions", () => ({}));
vi.mock("./account-menu", () => ({ AccountMenu: () => null }));
vi.mock("./voice-actions", () => ({}));

describe("compact assistant dashboard", () => {
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
  });
});
