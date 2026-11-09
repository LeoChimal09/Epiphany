import {
  emptyConversation,
  LEARNING_CHECK_IN_PREFIX,
  type ConversationState,
} from "@epiphany/core/assistant";
import type { Reminder } from "@epiphany/core/db";

export function createReplyContexts(clock: () => Date) {
  const replies = new Map<
    string,
    { channelId: string; state: ConversationState; expiresAt: number }
  >();
  return {
    remember(id: string, channelId: string, state: ConversationState) {
      replies.set(id, { channelId, state, expiresAt: clock().getTime() + 60 * 60_000 });
      while (replies.size > 100) replies.delete(replies.keys().next().value!);
    },
    get(id: string, channelId: string): ConversationState | null {
      const reply = replies.get(id);
      if (!reply || reply.channelId !== channelId) return null;
      if (reply.expiresAt <= clock().getTime()) {
        replies.delete(id);
        return null;
      }
      return reply.state;
    },
    clear() {
      replies.clear();
    },
  };
}

export function reminderIdFromMessage(content: string): string | null {
  return /(?:^|\n)-# epi:reminder:([0-9a-f-]{36})$/.exec(content)?.[1] ?? null;
}

export function withDeliveredReminders(
  state: ConversationState,
  reminders: Reminder[],
  now: Date,
  // A question delivered with the reminder (the morning greeting) that the reply may answer.
  greetingQuestion?: string,
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
        text: [greetingQuestion, ...reminders.map((item) => item.message)]
          .filter(Boolean)
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
    eventFocus: null,
    learningQuestion: reminder?.message.startsWith(LEARNING_CHECK_IN_PREFIX)
      ? {
          ownerId: reminder.ownerId,
          question: reminder.message.slice(LEARNING_CHECK_IN_PREFIX.length),
          expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
        }
      : reminder && greetingQuestion
        ? {
            ownerId: reminder.ownerId,
            question: greetingQuestion,
            expiresAt: new Date(now.getTime() + 12 * 60 * 60_000).toISOString(),
          }
        : null,
    listed:
      subjectType === "task" && reminder?.subjectId
        ? [{ id: reminder.subjectId, title, due: null }]
        : [],
  };
}
