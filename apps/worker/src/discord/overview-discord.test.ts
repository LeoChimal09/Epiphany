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

  it("omits records without supported task/event creation history", () => {
    expect(
      announcementText([entry({ action: "task.update" }), entry({ after: { other: true } })]),
    ).toBe("");
  });

  it("bounds large batches in one message", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `history-${index}`, after: { title: `Task ${index}` } }),
    );
    expect(announcementText(entries)).toContain("• And 2 more");
    expect(announcementText(entries).split("\n")).toHaveLength(10);
  });
});
