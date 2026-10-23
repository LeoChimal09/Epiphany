import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeadlineNotificationItems, DeadlineNotifications } from "./deadline-notifications";
import { deadlineNotifications, type DashboardTask } from "./model";

const now = new Date("2026-10-22T08:40:00-05:00");
const timezone = "America/Chicago";
const task = (id: string, dueAt = "2026-10-21T23:59:00-05:00"): DashboardTask => ({
  id,
  categoryId: "inbox",
  title: `Assignment ${id}`,
  details: null,
  sourceText: null,
  reviewNote: null,
  status: "open",
  dueAt,
  dueDateOnly: false,
  estimatedMinutes: null,
  completedAt: null,
  archivedAt: null,
  createdAt: "2026-10-21T12:00:00Z",
  version: 1,
});

function button(node: ReactNode, label: string): { onClick: () => void } | undefined {
  for (const child of Children.toArray(node)) {
    if (
      !isValidElement<{ children?: ReactNode; "aria-label"?: string; onClick: () => void }>(child)
    )
      continue;
    if (child.type === "button" && child.props["aria-label"] === label) return child.props;
    const found = button(child.props.children, label);
    if (found) return found;
  }
  return undefined;
}

describe("dashboard deadline notification area", () => {
  it("bounds the list to five with paging, explicit completion and access to all records", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => task(String(index).padStart(2, "0")));
    const html = renderToStaticMarkup(
      createElement(DeadlineNotifications, {
        tasks,
        timezone,
        now,
        pending: false,
        truncated: true,
        onComplete: vi.fn(),
        onOpen: vi.fn(),
        onHistory: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Deadline notifications"');
    expect(html).toContain('aria-label="Notifications: 12+ deadlines need attention"');
    expect(html).toContain('popover="auto"');
    expect(html).toContain('popoverTargetAction="hide"');
    expect(html).toContain("Close notifications");
    expect(html.match(/aria-label="Mark done:/g)).toHaveLength(5);
    expect(html).toContain("Overdue 8 hours 41 minutes");
    expect(html).not.toContain("Assignment 05");
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain("Next notifications");
    expect(html).toContain("Browse all task history");
    expect(html).toContain("No response never means completed");
    expect(html).toContain("Background Discord DMs require");
  });

  it("renders due-soon, exact due, overdue and date-only labels but excludes completed work", () => {
    const html = renderToStaticMarkup(
      createElement(DeadlineNotifications, {
        tasks: [
          task("soon", "2026-10-22T09:40:00-05:00"),
          task("now", now.toISOString()),
          task("late"),
          { ...task("date", "2026-10-22T00:00:00Z"), dueDateOnly: true },
          { ...task("completed"), status: "completed" },
        ],
        timezone,
        now,
        pending: false,
        truncated: false,
        onComplete: vi.fn(),
        onOpen: vi.fn(),
        onHistory: vi.fn(),
      }),
    );
    expect(html).toContain("Due in 1 hour");
    expect(html).toContain("Due now");
    expect(html).toContain("Due today");
    expect(html).toContain("Overdue 8 hours 41 minutes");
    expect(html).not.toContain("Assignment completed");
  });

  it("calls completion only on the explicit button and passes the exact task ID", () => {
    const record = task("specific-id");
    const onComplete = vi.fn();
    const onOpen = vi.fn();
    const tree = DeadlineNotificationItems({
      items: deadlineNotifications([record], timezone, now),
      timezone,
      pending: false,
      onComplete,
      onOpen,
    });
    expect(onComplete).not.toHaveBeenCalled();
    const view = button(tree, "View task Assignment specific-id");
    expect(view).toBeDefined();
    view!.onClick();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(record);
    expect(onComplete).not.toHaveBeenCalled();
    const done = button(tree, "Mark done: Assignment specific-id");
    expect(done).toBeDefined();
    done!.onClick();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("specific-id");
    expect(record.status).toBe("open");
  });

  it("disables mutation controls while saving and has a truthful empty state", () => {
    const html = renderToStaticMarkup(
      createElement(DeadlineNotificationItems, {
        items: deadlineNotifications([task("saving")], timezone, now),
        timezone,
        pending: true,
        onComplete: vi.fn(),
        onOpen: vi.fn(),
      }),
    );
    expect(html).toMatch(/disabled="" aria-label="Mark done:/);
    const empty = renderToStaticMarkup(
      createElement(DeadlineNotificationItems, {
        items: [],
        timezone,
        pending: false,
        onComplete: vi.fn(),
        onOpen: vi.fn(),
      }),
    );
    expect(empty).toContain("No deadlines need attention right now");
    expect(empty).not.toContain("Mark done");
  });
});
