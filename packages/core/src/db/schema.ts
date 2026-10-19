import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  char,
  check,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// All timestamps are UTC DATETIME(3). Connections set the session time zone to +00:00
// (see client.ts), so CURRENT_TIMESTAMP(3) defaults are also UTC. updated_at and version
// are maintained by the shared services, not by database triggers: manual SQL edits must
// set them too.
const utc = (name: string) => datetime(name, { mode: "date", fsp: 3 });
const id = () => char("id", { length: 36 }).primaryKey();
const ownerId = () =>
  char("owner_id", { length: 36 })
    .notNull()
    .references(() => owners.id);
const createdAt = () =>
  utc("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);
const updatedAt = () =>
  utc("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date());
const version = () => int("version", { unsigned: true }).notNull().default(1);

export const ACTION_SOURCES = ["dashboard", "discord", "voice", "worker", "system"] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

export const owners = mysqlTable(
  "owners",
  {
    id: id(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("America/Chicago"),
    discordUserId: varchar("discord_user_id", { length: 32 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("owners_discord_user_id_uq").on(t.discordUserId)],
);

// Every task and note belongs to a category. The per-owner Inbox is the category whose
// system_key is 'inbox'; uncategorized items are placed there.
export const categories = mysqlTable(
  "categories",
  {
    id: id(),
    ownerId: ownerId(),
    name: varchar("name", { length: 100 }).notNull(),
    systemKey: varchar("system_key", { length: 32 }),
    archivedAt: utc("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("categories_owner_name_uq").on(t.ownerId, t.name),
    uniqueIndex("categories_owner_system_key_uq").on(t.ownerId, t.systemKey),
  ],
);

// status tracks completion only. archived_at is a separate visibility flag, so age or
// archiving never changes whether work is complete.
export const tasks = mysqlTable(
  "tasks",
  {
    id: id(),
    ownerId: ownerId(),
    categoryId: char("category_id", { length: 36 })
      .notNull()
      .references(() => categories.id),
    title: varchar("title", { length: 300 }).notNull(),
    details: text("details"),
    sourceText: text("source_text"),
    sourceRef: varchar("source_ref", { length: 255 }),
    dueAt: utc("due_at"),
    dueDateOnly: boolean("due_date_only").notNull().default(false),
    estimatedMinutes: int("estimated_minutes", { unsigned: true }),
    remainingMinutes: int("remaining_minutes", { unsigned: true }),
    status: mysqlEnum("status", ["open", "completed"]).notNull().default("open"),
    completedAt: utc("completed_at"),
    archivedAt: utc("archived_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_owner_status_due_idx").on(t.ownerId, t.status, t.dueAt),
    index("tasks_owner_category_idx").on(t.ownerId, t.categoryId),
    index("tasks_owner_archived_idx").on(t.ownerId, t.archivedAt),
    check(
      "tasks_completed_at_matches_status",
      sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
  ],
);

// A fixed event. Canceling an event keeps the row; it never completes or deletes a task.
export const events = mysqlTable(
  "events",
  {
    id: id(),
    ownerId: ownerId(),
    title: varchar("title", { length: 300 }).notNull(),
    location: varchar("location", { length: 300 }),
    startsAt: utc("starts_at").notNull(),
    endsAt: utc("ends_at").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["scheduled", "canceled"]).notNull().default("scheduled"),
    canceledAt: utc("canceled_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("events_owner_status_start_idx").on(t.ownerId, t.status, t.startsAt),
    check("events_ends_not_before_starts", sql`${t.endsAt} >= ${t.startsAt}`),
    check(
      "events_canceled_at_matches_status",
      sql`(${t.status} = 'canceled') = (${t.canceledAt} IS NOT NULL)`,
    ),
  ],
);

// A movable block of planned time, optionally tied to a task. Removing a block keeps the
// row for history; it never completes the task.
export const workBlocks = mysqlTable(
  "work_blocks",
  {
    id: id(),
    ownerId: ownerId(),
    taskId: char("task_id", { length: 36 }).references(() => tasks.id),
    title: varchar("title", { length: 300 }),
    startsAt: utc("starts_at").notNull(),
    endsAt: utc("ends_at").notNull(),
    status: mysqlEnum("status", ["planned", "completed", "removed"]).notNull().default("planned"),
    completedAt: utc("completed_at"),
    removedAt: utc("removed_at"),
    removedReason: mysqlEnum("removed_reason", ["manual", "task_completed", "replanned"]),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("work_blocks_owner_status_start_idx").on(t.ownerId, t.status, t.startsAt),
    index("work_blocks_task_idx").on(t.taskId),
    check("work_blocks_ends_after_starts", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "work_blocks_timestamps_match_status",
      sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL) AND (${t.status} = 'removed') = (${t.removedAt} IS NOT NULL) AND (${t.status} = 'removed' OR ${t.removedReason} IS NULL)`,
    ),
  ],
);

export const notes = mysqlTable(
  "notes",
  {
    id: id(),
    ownerId: ownerId(),
    categoryId: char("category_id", { length: 36 })
      .notNull()
      .references(() => categories.id),
    kind: mysqlEnum("kind", ["note", "idea"]).notNull().default("note"),
    title: varchar("title", { length: 300 }),
    body: text("body").notNull(),
    sourceRef: varchar("source_ref", { length: 255 }),
    archivedAt: utc("archived_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("notes_owner_category_idx").on(t.ownerId, t.categoryId),
    index("notes_owner_created_idx").on(t.ownerId, t.createdAt),
  ],
);

// Explicit preferences. 'proposed' values are suggestions and are not applied until the
// owner confirms them; richer memory records arrive with the memory goal.
export const preferences = mysqlTable(
  "preferences",
  {
    id: id(),
    ownerId: ownerId(),
    key: varchar("pref_key", { length: 100 }).notNull(),
    value: json("value").notNull(),
    status: mysqlEnum("status", ["proposed", "confirmed"]).notNull().default("confirmed"),
    source: mysqlEnum("source", ACTION_SOURCES).notNull().default("dashboard"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("preferences_owner_key_uq").on(t.ownerId, t.key)],
);

// Append-only record of changes with provenance, written in the same transaction as the
// change. entity_id is intentionally not a foreign key so history outlives its subject.
export const actionHistory = mysqlTable(
  "action_history",
  {
    id: id(),
    ownerId: ownerId(),
    source: mysqlEnum("source", ACTION_SOURCES).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: char("entity_id", { length: 36 }).notNull(),
    before: json("before"),
    after: json("after"),
    undoOfId: char("undo_of_id", { length: 36 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("action_history_owner_created_idx").on(t.ownerId, t.createdAt),
    index("action_history_entity_idx").on(t.entityType, t.entityId),
  ],
);

// A proposed consequential action awaiting the owner's explicit confirmation. It is bound to
// the exact action, payload (payload_hash), and the versions of the records it targets, and it
// is single-use and time-limited. status stays 'pending' until it is resolved one way or another.
export const CONFIRMATION_STATUSES = [
  "pending",
  "executed",
  "expired",
  "canceled",
  "superseded",
] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export type ConfirmationTarget = { entityType: string; entityId: string; version: number };

export const confirmations = mysqlTable(
  "confirmations",
  {
    id: id(),
    ownerId: ownerId(),
    action: varchar("action", { length: 64 }).notNull(),
    status: mysqlEnum("status", CONFIRMATION_STATUSES).notNull().default("pending"),
    targets: json("targets").$type<ConfirmationTarget[]>().notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: char("payload_hash", { length: 64 }).notNull(),
    preview: json("preview").$type<Record<string, unknown>>().notNull(),
    source: mysqlEnum("source", ACTION_SOURCES).notNull(),
    expiresAt: utc("expires_at").notNull(),
    resolvedAt: utc("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("confirmations_owner_status_idx").on(t.ownerId, t.status, t.expiresAt),
    check(
      "confirmations_resolved_at_matches_status",
      sql`(${t.status} = 'pending') = (${t.resolvedAt} IS NULL)`,
    ),
  ],
);

// Dashboard login sessions. id is the SHA-256 hash of the random token held in the browser's
// cookie, so a copy of this table cannot be replayed as a login.
export const sessions = mysqlTable(
  "sessions",
  {
    id: char("id", { length: 64 }).primaryKey(),
    ownerId: ownerId(),
    expiresAt: utc("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_owner_idx").on(t.ownerId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const aiUsage = mysqlTable(
  "ai_usage",
  {
    ownerId: ownerId(),
    period: char("period", { length: 7 }).notNull(),
    costMicros: bigint("cost_micros", { mode: "number", unsigned: true }).notNull().default(0),
    calls: int("calls", { unsigned: true }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.period], name: "ai_usage_owner_id_period_pk" })],
);

export type Owner = typeof owners.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type CalendarEvent = typeof events.$inferSelect;
export type WorkBlock = typeof workBlocks.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Preference = typeof preferences.$inferSelect;
export type ActionHistoryEntry = typeof actionHistory.$inferSelect;
export type Confirmation = typeof confirmations.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
