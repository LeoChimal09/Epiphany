import { z } from "zod";
import { parseDateKey, parseTimeOfDay, type DateKey } from "../planning/time";

// What a model may ask for. It never produces instants, ids it was not shown, or SQL: only
// these shapes, which the assistant validates and maps onto the permissioned services.
export type Intent =
  | { kind: "respond"; text: string }
  | { kind: "clarify"; question: string }
  | {
      kind: "list_tasks";
      status: "open" | "completed" | "all";
      dueFrom?: DateKey;
      dueThrough?: DateKey;
      search?: string;
    }
  | {
      kind: "create_task";
      title: string;
      details?: string;
      dueDate?: DateKey;
      dueTime?: string;
      estimatedMinutes?: number;
    }
  | { kind: "create_note"; title?: string; body: string; noteKind: "note" | "idea" }
  | { kind: "complete_task"; reference: string; targetId?: string }
  | { kind: "delete_note"; reference: string; targetId?: string }
  | { kind: "confirm" }
  | { kind: "decline" };

export const INTENT_KINDS = [
  "respond",
  "clarify",
  "list_tasks",
  "create_task",
  "create_note",
  "complete_task",
  "delete_note",
  "confirm",
  "decline",
] as const;

// Flat, every-field-present shape: the form structured-output APIs accept. Unused fields are null.
export const intentWireSchema = z
  .object({
    kind: z.enum(INTENT_KINDS),
    text: z.string().max(4000).nullable(),
    title: z.string().max(300).nullable(),
    details: z.string().max(10_000).nullable(),
    due_date: z.string().nullable(),
    due_time: z.string().nullable(),
    estimated_minutes: z.number().int().min(1).max(100_000).nullable(),
    note_kind: z.enum(["note", "idea"]).nullable().default(null),
    status: z.enum(["open", "completed", "all"]).nullable(),
    from_date: z.string().nullable(),
    through_date: z.string().nullable(),
    search: z.string().max(200).nullable(),
    reference: z.string().max(300).nullable(),
    target_id: z.string().max(64).nullable(),
  })
  .strict();

export type IntentWire = z.infer<typeof intentWireSchema>;

export class IntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentError";
  }
}

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function date(value: string | null, label: string): DateKey | undefined {
  const text = present(value);
  if (text === undefined) return undefined;
  try {
    parseDateKey(text);
  } catch {
    throw new IntentError(`${label} is not a valid date`);
  }
  return text;
}

function need(value: string | null, label: string): string {
  const text = present(value);
  if (text === undefined) throw new IntentError(`${label} is required`);
  return text;
}

// Parses untrusted model output into a typed intent, or throws IntentError.
export function toIntent(raw: unknown): Intent {
  const parsed = intentWireSchema.safeParse(raw);
  if (!parsed.success) throw new IntentError("model output did not match the intent schema");
  const wire = parsed.data;
  switch (wire.kind) {
    case "respond":
      return { kind: "respond", text: need(wire.text, "text") };
    case "clarify":
      return { kind: "clarify", question: need(wire.text, "text") };
    case "list_tasks": {
      const dueFrom = date(wire.from_date, "from_date");
      const dueThrough = date(wire.through_date, "through_date");
      if (dueFrom && dueThrough && dueFrom > dueThrough) {
        throw new IntentError("from_date is after through_date");
      }
      const search = present(wire.search);
      return {
        kind: "list_tasks",
        status: wire.status ?? "open",
        ...(dueFrom ? { dueFrom } : {}),
        ...(dueThrough ? { dueThrough } : {}),
        ...(search ? { search } : {}),
      };
    }
    case "create_task": {
      const dueDate = date(wire.due_date, "due_date");
      const dueTime = present(wire.due_time);
      if (dueTime !== undefined) {
        if (!dueDate) throw new IntentError("due_time needs a due_date");
        try {
          parseTimeOfDay(dueTime);
        } catch {
          throw new IntentError("due_time is not a valid time");
        }
      }
      const details = present(wire.details);
      return {
        kind: "create_task",
        title: need(wire.title, "title"),
        ...(details ? { details } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(dueTime ? { dueTime } : {}),
        ...(wire.estimated_minutes ? { estimatedMinutes: wire.estimated_minutes } : {}),
      };
    }
    case "create_note":
      return {
        kind: "create_note",
        ...(present(wire.title) ? { title: present(wire.title) } : {}),
        body: need(wire.details, "details"),
        noteKind: wire.note_kind ?? "note",
      };
    case "complete_task":
    case "delete_note": {
      const targetId = present(wire.target_id);
      return {
        kind: wire.kind,
        reference: present(wire.reference) ?? "",
        ...(targetId ? { targetId } : {}),
      };
    }
    case "confirm":
      return { kind: "confirm" };
    case "decline":
      return { kind: "decline" };
  }
}

// JSON Schema for strict structured outputs (every property required, no extras).
export function intentJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(intentWireSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
