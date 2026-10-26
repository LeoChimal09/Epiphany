import { z } from "zod";
import { parseDateKey, parseTimeOfDay, type DateKey } from "../planning/time";
import { VOICE_ACTIONS, type VoiceAction } from "./workspace";
import { isSettableKey, parseSettingValue, type SettableKey } from "./settings";

// What a model may ask for. It never produces instants, ids it was not shown, or SQL: only
// these shapes, which the assistant validates and maps onto the permissioned services.
// One independent thing found in a message: an assignment or to-do, an idea, or a note.
export interface CaptureItem {
  type: "task" | "idea" | "note";
  title: string;
  details?: string;
  dueDate?: DateKey;
  dueTime?: string;
  estimatedMinutes?: number;
  priority?: "minor" | "major";
  // The name of one of the owner's existing categories; anything unknown lands in the Inbox.
  category?: string;
  // What is missing or unclear (for example "no due date given"). Flags the record for review.
  review?: string;
}

export const MAX_CAPTURE_ITEMS = 30;

export type Intent =
  | { kind: "website_link" }
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
      priority?: "minor" | "major";
    }
  | {
      kind: "create_note";
      title?: string;
      body: string;
      noteKind: "note" | "idea";
      feedback?: string;
    }
  | {
      kind: "resume_idea";
      reference: string;
      targetId?: string;
    }
  | {
      kind: "develop_idea";
      reference: string;
      targetId?: string;
      points: string[];
      feedback?: string;
    }
  // Several independent items from one message, or a pasted list of homework.
  // `omitted` counts items beyond MAX_CAPTURE_ITEMS that were left out, so the owner can be told.
  | { kind: "capture"; items: CaptureItem[]; omitted?: number }
  // Move an existing task or note to another category ("that's a chem thing", "put it in Work").
  | { kind: "recategorize"; reference: string; targetId?: string; category: string }
  | { kind: "complete_task"; reference: string; targetId?: string }
  | { kind: "delete_note"; reference: string; targetId?: string }
  // Set up (or repair) the owner's private Epiphany channels in a Discord server. `server` is a
  // server name the owner mentioned, if any.
  | { kind: "setup_workspace"; server?: string }
  // Reply to a reminder: put it off for a while ("snooze"), or say the event it was about is off
  // ("not going"). Both refer to the reminder Epi just sent.
  | { kind: "snooze"; minutes: number }
  | { kind: "skip_event" }
  // Stop reminders for a while (or until the owner resumes them), and start them again.
  | { kind: "pause_reminders"; minutes?: number }
  | { kind: "resume_reminders" }
  // The owner starts something and wants a check-in afterwards ("gaming for an hour").
  | { kind: "start_activity"; activity: string; minutes: number }
  | { kind: "create_reminder"; title: string; date: DateKey; time: string }
  // Change one of the owner's settings (quiet hours, briefing time, routines, planning hours).
  | { kind: "set_preference"; key: SettableKey; value: unknown; summary: string }
  // Show the schedule for a range of dates with free time and what could be tackled, and schedule
  // a block of work for a task at a chosen time.
  | { kind: "show_schedule"; from?: DateKey; through?: DateKey }
  | {
      kind: "plan_work";
      reference: string;
      targetId?: string;
      date: DateKey;
      time: string;
      minutes?: number;
    }
  // Live voice in a server voice channel: join, leave, stop or resume listening, mute replies.
  | { kind: "voice_control"; action: VoiceAction }
  // Learning from what the owner reports (only when they have turned it on).
  | { kind: "report_duration"; reference: string; targetId?: string; minutes: number }
  | { kind: "show_insights" }
  | { kind: "correct_estimate"; subject: string; minutes: number }
  | { kind: "forget_insights" }
  // Memory: remember something about the owner (explicit when they asked Epi to remember it, not
  // when Epi inferred it), show what is remembered, and forget one item.
  | { kind: "remember"; text: string; explicit: boolean }
  | { kind: "list_memory" }
  | { kind: "forget"; reference: string }
  // Take back the owner's most recent change in this conversation (a completion or a move).
  | { kind: "undo" }
  | { kind: "confirm" }
  | { kind: "decline" };

export const INTENT_KINDS = [
  "website_link",
  "respond",
  "clarify",
  "list_tasks",
  "create_task",
  "create_note",
  "develop_idea",
  "resume_idea",
  "capture",
  "recategorize",
  "complete_task",
  "delete_note",
  "setup_workspace",
  "snooze",
  "skip_event",
  "pause_reminders",
  "resume_reminders",
  "start_activity",
  "create_reminder",
  "voice_control",
  "report_duration",
  "show_insights",
  "correct_estimate",
  "forget_insights",
  "set_preference",
  "show_schedule",
  "plan_work",
  "remember",
  "list_memory",
  "forget",
  "undo",
  "confirm",
  "decline",
] as const;

const captureItemWireSchema = z
  .object({
    type: z.enum(["task", "idea", "note"]),
    title: z.string().max(300),
    details: z.string().max(10_000).nullable(),
    due_date: z.string().nullable(),
    due_time: z.string().nullable(),
    estimated_minutes: z.number().int().min(1).max(100_000).nullable(),
    priority: z.enum(["minor", "major"]).nullable().optional(),
    category: z.string().max(100).nullable(),
    review: z.string().max(300).nullable(),
  })
  .strict();

// Legacy flat envelope used by scripted fixtures and shared semantic validation. The OpenAI
// adapter expands sparse action arguments into this shape internally; chat is ordinary text.
export const intentWireSchema = z
  .object({
    kind: z.enum(INTENT_KINDS),
    text: z.string().max(4000).nullable(),
    title: z.string().max(300).nullable(),
    details: z.string().max(10_000).nullable(),
    due_date: z.string().nullable(),
    due_time: z.string().nullable(),
    estimated_minutes: z.number().int().min(1).max(100_000).nullable(),
    priority: z.enum(["minor", "major"]).nullable(),
    note_kind: z.enum(["note", "idea"]).nullable().default(null),
    status: z.enum(["open", "completed", "all"]).nullable(),
    from_date: z.string().nullable(),
    through_date: z.string().nullable(),
    search: z.string().max(200).nullable(),
    reference: z.string().max(300).nullable(),
    target_id: z.string().max(64).nullable(),
    category: z.string().max(100).nullable(),
    explicit: z.boolean().nullable(),
    items: z.array(captureItemWireSchema).max(200).nullable(),
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

function toCaptureItem(item: z.infer<typeof captureItemWireSchema>): CaptureItem {
  const dueDate = date(item.due_date, "due_date");
  const dueTime = present(item.due_time);
  if (dueTime !== undefined) {
    if (!dueDate) throw new IntentError("due_time needs a due_date");
    try {
      parseTimeOfDay(dueTime);
    } catch {
      throw new IntentError("due_time is not a valid time");
    }
  }
  const details = present(item.details);
  const category = present(item.category);
  const review = present(item.review);
  return {
    type: item.type,
    title: need(item.title, "title"),
    ...(details ? { details } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(dueTime ? { dueTime } : {}),
    ...(item.estimated_minutes ? { estimatedMinutes: item.estimated_minutes } : {}),
    ...(item.priority ? { priority: item.priority } : {}),
    ...(category ? { category } : {}),
    ...(review ? { review } : {}),
  };
}

// Parses untrusted model output into a typed intent, or throws IntentError.
export function toIntent(raw: unknown): Intent {
  const parsed = intentWireSchema.safeParse(raw);
  if (!parsed.success) throw new IntentError("model output did not match the intent schema");
  const wire = parsed.data;
  switch (wire.kind) {
    case "website_link":
      return { kind: "website_link" };
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
        ...(wire.priority ? { priority: wire.priority } : {}),
      };
    }
    case "create_note":
      return {
        kind: "create_note",
        ...(present(wire.title) ? { title: present(wire.title) } : {}),
        body: need(wire.details, "details"),
        noteKind: wire.note_kind ?? "note",
        ...(wire.note_kind === "idea" && present(wire.text)
          ? { feedback: present(wire.text) }
          : {}),
      };
    case "resume_idea":
      return {
        kind: "resume_idea",
        reference: present(wire.reference) ?? "",
        ...(present(wire.target_id) ? { targetId: present(wire.target_id) } : {}),
      };
    case "develop_idea": {
      const points = need(wire.details, "details")
        .split("\n")
        .map((line) =>
          line
            .trim()
            .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
            .trim(),
        )
        .filter(Boolean);
      if (points.length === 0 || points.length > 12 || points.some((point) => point.length > 500)) {
        throw new IntentError("idea additions must be at most 12 points of 500 characters each");
      }
      return {
        kind: "develop_idea",
        reference: present(wire.reference) ?? "",
        ...(present(wire.target_id) ? { targetId: present(wire.target_id) } : {}),
        points,
        ...(present(wire.text) ? { feedback: present(wire.text) } : {}),
      };
    }
    case "capture": {
      const wireItems = wire.items ?? [];
      if (wireItems.length === 0) throw new IntentError("capture needs at least one item");
      const omitted = Math.max(0, wireItems.length - MAX_CAPTURE_ITEMS);
      return {
        kind: "capture",
        items: wireItems.slice(0, MAX_CAPTURE_ITEMS).map(toCaptureItem),
        ...(omitted > 0 ? { omitted } : {}),
      };
    }
    case "recategorize": {
      const targetId = present(wire.target_id);
      return {
        kind: "recategorize",
        reference: present(wire.reference) ?? "",
        ...(targetId ? { targetId } : {}),
        category: need(wire.category, "category"),
      };
    }
    case "complete_task":
    case "delete_note": {
      const targetId = present(wire.target_id);
      return {
        kind: wire.kind,
        reference: present(wire.reference) ?? "",
        ...(targetId ? { targetId } : {}),
      };
    }
    case "setup_workspace": {
      const server = present(wire.reference);
      return { kind: "setup_workspace", ...(server ? { server } : {}) };
    }
    case "snooze":
      return { kind: "snooze", minutes: wire.estimated_minutes ?? 30 };
    case "skip_event":
      return { kind: "skip_event" };
    case "pause_reminders":
      return {
        kind: "pause_reminders",
        ...(wire.estimated_minutes ? { minutes: wire.estimated_minutes } : {}),
      };
    case "resume_reminders":
      return { kind: "resume_reminders" };
    case "start_activity": {
      if (!wire.estimated_minutes) throw new IntentError("estimated_minutes is required");
      return {
        kind: "start_activity",
        activity: need(wire.title, "title"),
        minutes: wire.estimated_minutes,
      };
    }
    case "create_reminder": {
      const dueDate = date(wire.due_date, "due_date");
      if (!dueDate) throw new IntentError("due_date is required");
      const dueTime = need(wire.due_time, "due_time");
      try {
        parseTimeOfDay(dueTime);
      } catch {
        throw new IntentError("due_time is not a valid time");
      }
      return {
        kind: "create_reminder",
        title: need(wire.title, "title"),
        date: dueDate,
        time: dueTime,
      };
    }
    case "voice_control": {
      const action = present(wire.search);
      if (!action || !VOICE_ACTIONS.includes(action as VoiceAction)) {
        throw new IntentError("unknown voice action");
      }
      return { kind: "voice_control", action: action as VoiceAction };
    }
    case "report_duration": {
      if (!wire.estimated_minutes) throw new IntentError("estimated_minutes is required");
      const targetId = present(wire.target_id);
      return {
        kind: "report_duration",
        reference: present(wire.reference) ?? "",
        ...(targetId ? { targetId } : {}),
        minutes: wire.estimated_minutes,
      };
    }
    case "show_insights":
      return { kind: "show_insights" };
    case "correct_estimate": {
      if (!wire.estimated_minutes) throw new IntentError("estimated_minutes is required");
      return {
        kind: "correct_estimate",
        subject: need(wire.title, "title"),
        minutes: wire.estimated_minutes,
      };
    }
    case "forget_insights":
      return { kind: "forget_insights" };
    case "set_preference": {
      const key = present(wire.search);
      if (!key || !isSettableKey(key)) throw new IntentError("unknown setting");
      const parsed = parseSettingValue(key, need(wire.details, "details"));
      if (!parsed) throw new IntentError("setting value is not valid");
      return {
        kind: "set_preference",
        key,
        value: parsed.value,
        summary: present(wire.title) ?? key,
      };
    }
    case "show_schedule": {
      const from = date(wire.from_date, "from_date");
      const through = date(wire.through_date, "through_date");
      if (from && through && from > through)
        throw new IntentError("from_date is after through_date");
      return { kind: "show_schedule", ...(from ? { from } : {}), ...(through ? { through } : {}) };
    }
    case "plan_work": {
      const day = date(wire.due_date, "due_date");
      if (!day) throw new IntentError("due_date is required");
      const start = need(wire.due_time, "due_time");
      try {
        parseTimeOfDay(start);
      } catch {
        throw new IntentError("due_time is not a valid time");
      }
      const targetId = present(wire.target_id);
      return {
        kind: "plan_work",
        reference: present(wire.reference) ?? "",
        ...(targetId ? { targetId } : {}),
        date: day,
        time: start,
        ...(wire.estimated_minutes ? { minutes: wire.estimated_minutes } : {}),
      };
    }
    case "remember":
      return {
        kind: "remember",
        text: need(wire.details, "details").slice(0, 400),
        explicit: wire.explicit === true,
      };
    case "list_memory":
      return { kind: "list_memory" };
    case "forget":
      return { kind: "forget", reference: need(wire.reference, "reference") };
    case "undo":
      return { kind: "undo" };
    case "confirm":
      return { kind: "confirm" };
    case "decline":
      return { kind: "decline" };
  }
}

// Keywords that strict structured outputs may reject. Nothing is lost by dropping them: the reply
// is validated again against intentWireSchema (lengths included) before it is used.
const UNSUPPORTED_KEYWORDS = new Set(["default", "minLength", "maxLength", "maxItems", "minItems"]);

function withoutUnsupported(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUnsupported);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
        .map(([key, inner]) => [key, withoutUnsupported(inner)]),
    );
  }
  return value;
}

// JSON Schema for strict structured outputs (every property required, no extras).
export function intentJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(intentWireSchema) as Record<string, unknown>;
  delete schema.$schema;
  return withoutUnsupported(schema) as Record<string, unknown>;
}
