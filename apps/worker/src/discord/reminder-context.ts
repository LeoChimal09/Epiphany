import { emptyConversation, type ConversationState } from "@epiphany/core/assistant";
import type { Reminder } from "@epiphany/core/db";

export function reminderIdFromMessage(content: string): string | null {
  return /(?:^|\n)-# epi:reminder:([0-9a-f-]{36})$/.exec(content)?.[1] ?? null;
}

export function withDeliveredReminders(
  state: ConversationState,
  reminders: Reminder[],
  now: Date,
): ConversationState {
  const reminder = reminders.length === 1 ? reminders[0] : undefined;
  const subjectType =
    reminder?.subjectType === "task" || reminder?.subjectType === "event"
      ? reminder.subjectType
      : null;
  const title = reminder ? (/"([^"]{1,200})"/.exec(reminder.message)?.[1] ?? "that reminder") : "";
  return {
    ...state,
    ...emptyConversation(),
    turns: [
      ...state.turns,
      {
        role: "assistant" as const,
        text: reminders
          .map((item) => item.message)
          .join("\n")
          .slice(0, 1000),
      },
    ].slice(-8),
    lastChange: null,
    pendingCapture: null,
    pendingMemory: null,
    pendingPlan: null,
    pendingSetting: null,
    lastReminder: reminder
      ? {
          reminderId: reminder.id,
          kind: reminder.kind,
          subjectType,
          subjectId: reminder.subjectId,
          title,
          receivedAt: now.toISOString(),
        }
      : null,
    listed:
      subjectType === "task" && reminder?.subjectId
        ? [{ id: reminder.subjectId, title, due: null }]
        : [],
  };
}
