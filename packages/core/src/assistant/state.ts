import { z } from "zod";
import type { ConversationState } from "./assistant";

const text = (max: number) => z.string().max(max);

const conversationStateSchema = z
  .object({
    turns: z
      .array(z.object({ role: z.enum(["user", "assistant"]), text: text(1000) }).strict())
      .max(8),
    listed: z
      .array(
        z.object({ id: text(64), title: text(300), due: z.string().max(10).nullable() }).strict(),
      )
      .max(15),
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
