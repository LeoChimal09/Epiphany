import { z } from "zod";
import type { ConversationState } from "./assistant";
import { MAX_CAPTURE_ITEMS } from "./intent";

const text = (max: number) => z.string().max(max);

const conversationStateSchema = z
  .object({
    focus: z
      .object({ kind: z.enum(["task", "note", "event"]), id: text(64).min(1) })
      .strict()
      .nullable()
      .optional(),
    searchResults: z
      .object({
        ownerId: text(64),
        items: z
          .array(
            z
              .object({ kind: z.enum(["task", "note", "event"]), id: text(64), title: text(300) })
              .strict(),
          )
          .min(1)
          .max(10),
      })
      .strict()
      .nullable()
      .optional(),
    eventFocus: z
      .object({
        ownerId: text(64),
        ids: z.array(text(64)).min(1).max(15),
        expiresAt: z.iso.datetime(),
        action: z.enum(["acknowledge_event", "cancel_event"]).optional(),
        scope: z.enum(["occurrence", "series"]).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    learningQuestion: z
      .object({
        ownerId: text(64),
        question: text(400),
        expiresAt: z.iso.datetime(),
        taskId: text(64).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    activeIdea: z
      .object({ ownerId: text(64), noteId: text(64) })
      .strict()
      .nullable()
      .optional(),
    turns: z
      .array(z.object({ role: z.enum(["user", "assistant"]), text: text(8000) }).strict())
      .max(8),
    listed: z
      .array(
        z
          .object({
            id: text(64),
            title: text(300),
            due: z.string().max(10).nullable(),
            taskType: z.enum(["task", "todo"]).optional(),
            priority: z.enum(["minor", "major"]).optional(),
            estimatedMinutes: z.number().nullable().optional(),
          })
          .strict(),
      )
      .max(15),
    pendingCapture: z
      .object({
        ownerId: text(64),
        items: z
          .array(
            z
              .object({
                type: z.enum(["task", "idea", "note"]),
                title: z.string().min(1).max(300),
                details: text(10_000).optional(),
                dueDate: z.iso.date().optional(),
                dueTime: z
                  .string()
                  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
                  .optional(),
                estimatedMinutes: z.number().int().min(1).max(100_000).optional(),
                category: text(100).optional(),
                review: text(300).optional(),
              })
              .strict()
              .refine((item) => !item.dueTime || Boolean(item.dueDate)),
          )
          .min(1)
          .max(MAX_CAPTURE_ITEMS),
        omitted: z.number().int().min(0),
        sourceText: text(8000),
        sourceRef: text(255).optional(),
        expiresAt: z.iso.datetime(),
      })
      .strict()
      .nullable()
      .optional(),
    pendingSetting: z
      .object({ key: text(80), valueJson: text(4000), summary: text(200) })
      .strict()
      .nullable()
      .optional(),
    pendingPlan: z
      .object({
        items: z
          .array(
            z
              .object({ taskId: text(64), title: text(300), startsAt: text(40), endsAt: text(40) })
              .strict(),
          )
          .max(6),
      })
      .strict()
      .nullable()
      .optional(),
    pendingCategory: z
      .object({
        ownerId: text(64),
        expiresAt: z.iso.datetime(),
        groups: z
          .array(
            z
              .object({
                name: text(100).min(1),
                matchId: text(64).optional(),
                matchName: text(100).optional(),
                items: z
                  .array(
                    z
                      .object({ kind: z.enum(["task", "note"]), id: text(64), title: text(300) })
                      .strict(),
                  )
                  .min(1)
                  .max(MAX_CAPTURE_ITEMS),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_CAPTURE_ITEMS),
      })
      .strict()
      .nullable()
      .optional(),
    pendingMemory: z
      .object({ key: text(120), text: text(400) })
      .strict()
      .nullable()
      .optional(),
    lastReminder: z
      .object({
        reminderId: text(64),
        kind: text(32),
        subjectType: z.enum(["task", "event"]).nullable(),
        subjectId: text(64).nullable(),
        title: text(300),
        receivedAt: z.iso.datetime().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    lastChange: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("completed"), taskId: text(64), title: text(300) }).strict(),
        z
          .object({
            kind: z.literal("moved"),
            taskId: text(64),
            title: text(300),
            fromCategoryId: text(64),
            fromCategory: text(100),
          })
          .strict(),
      ])
      .nullable()
      .optional(),
    pending: z
      .object({
        confirmationId: text(64),
        payloadHash: text(64),
        summary: text(400),
        expiresAt: text(40),
      })
      .strict()
      .nullable(),
  })
  .strict();

export function parseConversationState(value: unknown): ConversationState | null {
  const parsed = conversationStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
