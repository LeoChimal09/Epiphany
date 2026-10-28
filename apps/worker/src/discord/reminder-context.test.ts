import { describe, expect, it } from "vitest";
import { emptyConversation } from "@epiphany/core/assistant";
import type { Reminder } from "@epiphany/core/db";
import { reminderIdFromMessage, withDeliveredReminders } from "./reminder-context";

const now = new Date("2026-10-28T15:00:00Z");
const reminder = (subjectType: "task" | "event") =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    kind: subjectType === "task" ? "task_deadline" : "event",
    subjectType,
    subjectId: "subject-1",
    message: '"Gym time" starts in 30 minutes.',
  }) as Reminder;

describe("Discord reminder conversation context", () => {
  it("replaces a stale task list with the event, never the old task", () => {
    const state = withDeliveredReminders(
      {
        ...emptyConversation(),
        listed: [{ id: "drone", title: "Get drone fixed", due: null }],
      },
      [reminder("event")],
      now,
    );
    expect(state.listed).toEqual([]);
    expect(state.lastReminder).toMatchObject({
      subjectType: "event",
      title: "Gym time",
      receivedAt: now.toISOString(),
    });
    expect(state.turns.at(-1)?.text).toContain('"Gym time"');
  });

  it("binds task replies only to that task and clears ambiguity for a summary", () => {
    const state = withDeliveredReminders(emptyConversation(), [reminder("task")], now);
    expect(state.listed).toEqual([{ id: "subject-1", title: "Gym time", due: null }]);
    const summary = withDeliveredReminders(state, [reminder("task"), reminder("event")], now);
    expect(summary.listed).toEqual([]);
    expect(summary.lastReminder).toBeNull();
  });

  it("recognizes only a complete reminder marker", () => {
    const id = reminder("event").id;
    expect(reminderIdFromMessage(`Reminder\n-# epi:reminder:${id}`)).toBe(id);
    expect(reminderIdFromMessage(`-# epi:reminder:${id}\nother text`)).toBeNull();
    expect(reminderIdFromMessage("-# epi:reminder:bad-id")).toBeNull();
  });
});
