import { describe, expect, it } from "vitest";
import { emptyConversation } from "@epiphany/core/assistant";
import type { Reminder } from "@epiphany/core/db";
import {
  createReplyContexts,
  reminderIdFromMessage,
  withDeliveredReminders,
} from "./reminder-context";

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
  it("recovers an owner-bound proactive question from its persisted reminder after restart", () => {
    const state = withDeliveredReminders(
      emptyConversation(),
      [
        {
          ...reminder("task"),
          ownerId: "owner",
          kind: "check_in",
          subjectType: null,
          subjectId: null,
          message: "Optional Epi check-in: Do you prefer short replies?",
        } as Reminder,
      ],
      now,
    );
    expect(state.listed).toEqual([]);
    expect(state.learningQuestion).toEqual({
      ownerId: "owner",
      question: "Do you prefer short replies?",
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    });
  });
  it("restores the exact event selection and pending action for a reply, not the latest channel topic", () => {
    let time = now;
    const contexts = createReplyContexts(() => time);
    const state = {
      ...emptyConversation(),
      eventFocus: {
        ownerId: "owner",
        ids: ["event-a", "event-b"],
        action: "cancel_event" as const,
        scope: "occurrence" as const,
        expiresAt: "2026-10-28T16:00:00Z",
      },
    };
    contexts.remember("selection", "private", state);
    contexts.remember("new-topic", "private", emptyConversation());
    expect(contexts.get("selection", "private")).toEqual(state);
    expect(contexts.get("selection", "other-channel")).toBeNull();
    time = new Date("2026-10-28T16:00:01Z");
    expect(contexts.get("selection", "private")).toBeNull();
  });

  it("bounds and clears temporary reply context", () => {
    const contexts = createReplyContexts(() => now);
    for (let index = 0; index < 101; index++)
      contexts.remember(String(index), "private", emptyConversation());
    expect(contexts.get("0", "private")).toBeNull();
    expect(contexts.get("100", "private")).not.toBeNull();
    contexts.clear();
    expect(contexts.get("100", "private")).toBeNull();
  });

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
