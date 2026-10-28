import { describe, expect, it } from "vitest";
import type { ActionHistoryEntry } from "@epiphany/core/db";
import { announcementText } from "./overview-discord";

const entry = (overrides: Partial<ActionHistoryEntry> = {}): ActionHistoryEntry => ({
  id: "history-1",
  ownerId: "owner-1",
  source: "dashboard",
  action: "task.create",
  entityType: "task",
  entityId: "task-1",
  before: null,
  after: { title: "Study for finals" },
  undoOfId: null,
  createdAt: new Date("2026-10-26T18:00:00.000Z"),
  ...overrides,
});

describe("Discord planner addition notices", () => {
  it("formats task and event additions without a generated response", () => {
    expect(
      announcementText([
        entry(),
        entry({
          id: "history-2",
          action: "event.create",
          entityType: "event",
          after: { title: "Office hours" },
        }),
      ]),
    ).toBe("✨ Added to your planner:\n• Task: Study for finals\n• Event: Office hours");
  });

  it("includes task deadline, estimate, priority, and event time when recorded", () => {
    expect(
      announcementText(
        [
          entry({
            after: {
              title: "Study for finals",
              dueAt: "2026-10-26T21:00:00.000Z",
              dueDateOnly: false,
              estimatedMinutes: 90,
              priority: "major",
            },
          }),
          entry({
            id: "history-2",
            action: "event.create",
            entityType: "event",
            after: {
              title: "Office hours",
              startsAt: "2026-10-26T15:00:00.000Z",
              endsAt: "2026-10-26T16:00:00.000Z",
              timezone: "America/Chicago",
            },
          }),
        ],
        "America/Chicago",
      ),
    ).toBe(
      "✨ Added to your planner:\n• Task: Study for finals (Due Oct 26, 2026, 4:00 PM · 90 min · Major)\n• Event: Office hours (Oct 26, 2026, 10:00 AM–11:00 AM)",
    );
  });

  it("formats date-only task deadlines and all-day events", () => {
    expect(
      announcementText([
        entry({
          after: {
            title: "Submit application",
            dueAt: "2026-10-27T00:00:00.000Z",
            dueDateOnly: true,
            priority: "minor",
          },
        }),
        entry({
          id: "history-2",
          action: "event.create",
          entityType: "event",
          after: {
            title: "Holiday",
            startsAt: "2026-10-27T05:00:00.000Z",
            timezone: "America/Chicago",
            allDay: true,
          },
        }),
      ]),
    ).toBe(
      "✨ Added to your planner:\n• Task: Submit application (Due Oct 27, 2026 · Minor)\n• Event: Holiday (Oct 27, 2026 (all day))",
    );
  });

  it("omits records without supported task/event creation history", () => {
    expect(
      announcementText([entry({ action: "unknown" }), entry({ after: { other: true } })]),
    ).toBe("");
  });

  it("bounds large batches in one message", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `history-${index}`, after: { title: `Task ${index}` } }),
    );
    expect(announcementText(entries)).toContain("• And 2 more");
    expect(announcementText(entries).split("\n")).toHaveLength(10);
  });

  it("announces to-dos, edits and completions as fresh planner updates", () => {
    const text = announcementText([
      entry({ after: { title: "Get drone fixed", taskType: "todo", priority: "minor" } }),
      entry({
        action: "task.update",
        after: { title: "Repair camera", fields: ["title", "dueAt"] },
      }),
      entry({ action: "task.complete", after: { title: "Eat" } }),
    ]);
    expect(text).toContain("Planner updates:");
    expect(text).toContain("To-do: Get drone fixed");
    expect(text).not.toContain("Minor");
    expect(text).toContain("Updated task: Repair camera (title, due at)");
    expect(text).toContain("Completed task: Eat");
  });

  it("escapes user-supplied mentions and markdown in notices", () => {
    expect(announcementText([entry({ after: { title: "@everyone **urgent**" } })])).toContain(
      "@\u200beveryone \\*\\*urgent\\*\\*",
    );
  });
});
