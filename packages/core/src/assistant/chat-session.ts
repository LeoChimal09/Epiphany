import { z } from "zod";
import { parseConversationState } from "./state";
import type { ConversationState } from "./assistant";

export const chatTopicSchema = z
  .object({
    kind: z.enum(["task", "note", "event"]),
    id: z.string().min(1).max(64),
    label: z.enum(["task", "todo", "note", "idea", "event"]),
    title: z.string().min(1).max(300),
  })
  .strict();

export const chatMessageSchema = z
  .object({
    id: z.number().int().min(1),
    role: z.enum(["user", "epi"]),
    text: z.string().max(20_000),
    outcome: z
      .enum([
        "answered",
        "clarification",
        "listed",
        "created",
        "completed",
        "confirmation_needed",
        "deleted",
        "declined",
        "not_found",
        "failed",
        "uncertain",
        "unavailable",
        "denied",
      ])
      .optional(),
    changed: z.boolean().optional(),
    links: z
      .array(
        z
          .object({
            label: z.string().max(400),
            href: z
              .string()
              .regex(/^#(?:task|event|note)-[^#\s]+$/)
              .max(300),
          })
          .strict(),
      )
      .max(60)
      .optional(),
  })
  .strict();

export const chatDataSchema = z
  .object({
    messages: z.array(chatMessageSchema).max(100),
    conversation: z.custom<ConversationState>((value) => parseConversationState(value) !== null),
    topic: chatTopicSchema.nullable(),
  })
  .strict();

export type ChatTopic = z.infer<typeof chatTopicSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatData = z.infer<typeof chatDataSchema>;
export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}
export interface ChatSession extends ChatSessionSummary {
  data: ChatData;
  busy: boolean;
}
