import { z } from "zod";
import { ValidationError } from "./errors";

const id = z.uuid();
const title = z.string().trim().min(1, "must not be empty").max(300);
const optionalText = (max: number) => z.string().max(max).optional();

const instant = z
  .union([z.date(), z.iso.datetime({ offset: true }).transform((value) => new Date(value))])
  .refine((value) => !Number.isNaN(value.getTime()), "must be a valid date and time");

const timezone = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "must be an IANA timezone such as America/Chicago");

export const createTaskInput = z
  .object({
    title,
    priority: z.enum(["minor", "major"]).optional(),
    categoryId: id.optional(),
    details: optionalText(10_000),
    sourceText: optionalText(20_000),
    sourceRef: optionalText(255),
    reviewNote: z.string().trim().min(1).max(300).optional(),
    dueAt: instant.optional(),
    dueDateOnly: z.boolean().optional(),
    estimatedMinutes: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

export const createNoteInput = z
  .object({
    body: z.string().trim().min(1, "must not be empty").max(50_000),
    title: z.string().trim().max(300).optional(),
    kind: z.enum(["note", "idea"]).optional(),
    categoryId: id.optional(),
    sourceRef: optionalText(255),
  })
  .strict();

export const createEventInput = z
  .object({
    title,
    startsAt: instant,
    endsAt: instant,
    timezone,
    allDay: z.boolean().optional(),
    location: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((value) => value.endsAt.getTime() >= value.startsAt.getTime(), {
    path: ["endsAt"],
    message: "must not be before startsAt",
  });

export const createWorkBlockInput = z
  .object({
    taskId: id.optional(),
    title: z.string().trim().max(300).optional(),
    startsAt: instant,
    endsAt: instant,
  })
  .strict()
  .refine((value) => value.endsAt.getTime() > value.startsAt.getTime(), {
    path: ["endsAt"],
    message: "must be after startsAt",
  });

const version = z.number().int().min(1);

// Fields may be omitted (unchanged). null clears a nullable field; "" clears text fields.
const clearableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value.trim() === "" ? null : value));

export const updateTaskInput = z
  .object({
    expectedVersion: version.optional(),
    title: title.optional(),
    priority: z.enum(["minor", "major"]).optional(),
    details: clearableText(10_000).optional(),
    dueAt: instant.nullable().optional(),
    dueDateOnly: z.boolean().optional(),
    estimatedMinutes: z.number().int().min(1).max(100_000).nullable().optional(),
    categoryId: id.optional(),
    reviewNote: clearableText(300).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
    message: "must change at least one field",
  });

export const updateNoteInput = z
  .object({
    expectedVersion: version.optional(),
    title: clearableText(300).optional(),
    body: z.string().trim().min(1, "must not be empty").max(50_000).optional(),
    kind: z.enum(["note", "idea"]).optional(),
    categoryId: id.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
    message: "must change at least one field",
  });

export const listNotesInput = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(100_000).default(0),
    categoryId: id.optional(),
    kind: z.enum(["note", "idea"]).optional(),
  })
  .strict();

export const listTasksInput = z
  .object({
    status: z.enum(["open", "completed", "all"]).default("open"),
    categoryId: id.optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export const idInput = id;
export const reasonInput = z.enum(["manual", "task_completed", "replanned"]);

const MAX_RANGE_DAYS = 62;

// Records overlapping [from, to). Bounded so one request cannot scan the whole calendar.
export const listRangeInput = z
  .object({
    from: instant,
    to: instant,
    includeInactive: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict()
  .superRefine((value, context) => {
    const span = value.to.getTime() - value.from.getTime();
    if (span <= 0) {
      context.addIssue({ code: "custom", path: ["to"], message: "must be after from" });
    } else if (span > MAX_RANGE_DAYS * 86_400_000) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: `must be within ${MAX_RANGE_DAYS} days of from`,
      });
    }
  });

export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`),
    );
  }
  return result.data;
}

const snowflake = z.string().regex(/^\d{15,25}$/, "must be a Discord ID");
const viewKey = z.string().regex(/^[a-z][a-z-]{0,31}$/, "must be a view name");

export const overviewKeyInput = z.object({ guildId: snowflake, viewKey }).strict();

export const overviewBindingInput = z
  .object({
    guildId: snowflake,
    viewKey,
    channelId: snowflake,
    messageId: snowflake,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 hex digest"),
  })
  .strict();

export type OverviewBinding = z.infer<typeof overviewBindingInput>;

export const oneOffReminderInput = z
  .object({
    message: z.string().trim().min(1).max(500),
    at: instant,
    kind: z.enum(["check_in", "custom"]).default("check_in"),
  })
  .strict();
