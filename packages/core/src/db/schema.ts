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
    // Discord's avatar hash (identify scope); the image URL is derived from it. Null means the
    // owner uses Discord's default avatar.
    avatarHash: varchar("avatar_hash", { length: 64 }),
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
    taskType: mysqlEnum("task_type", ["task", "todo"]).notNull().default("task"),
    title: varchar("title", { length: 300 }).notNull(),
    priority: mysqlEnum("priority", ["minor", "major"]).notNull().default("minor"),
    details: text("details"),
    sourceText: text("source_text"),
    sourceRef: varchar("source_ref", { length: 255 }),
    // What still needs the owner's eye (for example a missing or unclear due date). Null when the
    // task needs no review; setting a due date clears it.
    reviewNote: varchar("review_note", { length: 300 }),
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

export const REMINDER_KINDS = [
  "task_deadline",
  "event",
  "check_in",
  "briefing",
  "wind_down",
  "custom",
] as const;
export const REMINDER_STATUSES = [
  "scheduled",
  "sending",
  "sent",
  "skipped",
  "failed",
  "unknown",
  "canceled",
] as const;

// A persistent reminder job. dedupe_key makes scheduling idempotent (the same reminder is never
// created twice); status plus claimed_at make delivery safe across restarts: a job is claimed
// before sending, and one found still "sending" after a crash is marked unknown, not re-sent,
// because it may already have reached the owner. `detail` says why a job was skipped or failed.
export const reminders = mysqlTable(
  "reminders",
  {
    id: id(),
    ownerId: ownerId(),
    kind: mysqlEnum("kind", REMINDER_KINDS).notNull(),
    subjectType: varchar("subject_type", { length: 16 }),
    subjectId: char("subject_id", { length: 36 }),
    dedupeKey: varchar("dedupe_key", { length: 191 }).notNull(),
    message: varchar("message", { length: 1000 }).notNull(),
    urgency: mysqlEnum("urgency", ["normal", "high"]).notNull().default("normal"),
    dueAt: utc("due_at").notNull(),
    status: mysqlEnum("status", REMINDER_STATUSES).notNull().default("scheduled"),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    nextAttemptAt: utc("next_attempt_at"),
    claimedAt: utc("claimed_at"),
    sentAt: utc("sent_at"),
    detail: varchar("detail", { length: 160 }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("reminders_owner_dedupe_uq").on(t.ownerId, t.dedupeKey),
    index("reminders_due_idx").on(t.status, t.dueAt),
    index("reminders_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

// Which Discord message shows each overview (today, schedule, ...) in a server, so the message is
// edited in place instead of reposted, and recreated if someone deletes it. Deleting the message
// never touches the records it displayed. content_hash skips edits when nothing changed.
export const discordOverviews = mysqlTable(
  "discord_overviews",
  {
    ownerId: ownerId(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    viewKey: varchar("view_key", { length: 32 }).notNull(),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    messageId: varchar("message_id", { length: 32 }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.guildId, t.viewKey], name: "discord_overviews_pk" })],
);

export const CALENDAR_PROVIDERS = ["google"] as const;
export const CALENDAR_ACCOUNT_STATUSES = ["connected", "needs_reauth", "revoked"] as const;
export type CalendarAccountStatus = (typeof CALENDAR_ACCOUNT_STATUSES)[number];

// A connected calendar provider account (Goal 11). The OAuth tokens are stored only as AES-256-GCM
// ciphertext (see calendar/crypto.ts) and only while status is 'connected': a CHECK constraint
// makes it impossible to keep tokens on a revoked or re-authorization account, so disconnecting
// provably leaves nothing to use. epiphany_calendar_id is the one dedicated calendar Epiphany
// writes to; it never writes to any other calendar.
export const calendarAccounts = mysqlTable(
  "calendar_accounts",
  {
    id: id(),
    ownerId: ownerId(),
    provider: mysqlEnum("provider", CALENDAR_PROVIDERS).notNull(),
    providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
    accountEmail: varchar("account_email", { length: 320 }),
    status: mysqlEnum("status", CALENDAR_ACCOUNT_STATUSES).notNull().default("connected"),
    scopes: varchar("scopes", { length: 1000 }).notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessTokenExpiresAt: utc("access_token_expires_at"),
    epiphanyCalendarId: varchar("epiphany_calendar_id", { length: 255 }),
    lastError: varchar("last_error", { length: 300 }),
    connectedAt: utc("connected_at").notNull(),
    disconnectedAt: utc("disconnected_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("calendar_accounts_owner_provider_account_uq").on(
      t.ownerId,
      t.provider,
      t.providerAccountId,
    ),
    check(
      "calendar_accounts_tokens_only_when_connected",
      sql`${t.status} = 'connected' OR (${t.accessTokenEnc} IS NULL AND ${t.refreshTokenEnc} IS NULL)`,
    ),
  ],
);

export const CALENDAR_SYNC_STATUSES = ["pending", "ok", "stale", "error"] as const;
export type CalendarSyncStatus = (typeof CALENDAR_SYNC_STATUSES)[number];

// A calendar discovered in the provider account. Only `selected` calendars are read. The
// 'epiphany' kind is the dedicated calendar: always synced (to notice edits made to Epiphany's
// own events) and never offered for selection. sync_token is the provider's incremental cursor.
export const syncedCalendars = mysqlTable(
  "synced_calendars",
  {
    id: id(),
    ownerId: ownerId(),
    accountId: char("account_id", { length: 36 })
      .notNull()
      .references(() => calendarAccounts.id),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    kind: mysqlEnum("kind", ["external", "epiphany"]).notNull().default("external"),
    summary: varchar("summary", { length: 300 }).notNull(),
    timeZone: varchar("time_zone", { length: 64 }),
    accessRole: varchar("access_role", { length: 24 }),
    isPrimary: boolean("is_primary").notNull().default(false),
    selected: boolean("selected").notNull().default(false),
    syncToken: text("sync_token"),
    fullSyncedAt: utc("full_synced_at"),
    lastSyncedAt: utc("last_synced_at"),
    lastAttemptAt: utc("last_attempt_at"),
    syncStatus: mysqlEnum("sync_status", CALENDAR_SYNC_STATUSES).notNull().default("pending"),
    lastError: varchar("last_error", { length: 300 }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("synced_calendars_account_external_uq").on(t.accountId, t.externalId),
    index("synced_calendars_owner_idx").on(t.ownerId),
  ],
);

export const CALENDAR_REF_STATES = [
  "synced",
  "pending",
  "uncertain",
  "conflict",
  "remote_deleted",
  "removed",
  "detached",
] as const;
export type CalendarRefState = (typeof CALENDAR_REF_STATES)[number];

// Links a provider event to a local record so nothing is duplicated or looped.
//   ownership 'external': the event came from the provider (event_id is the imported local event).
//     Epiphany never edits or deletes these.
//   ownership 'epiphany': Epiphany created it from a work block (work_block_id) or task deadline
//     (identified by sync_key) in its own calendar.
// etag/remote_updated_at are the provider's version of the event as last seen; synced_version is
// the local work-block or task version last pushed. 'uncertain' means a write may or may not have happened and
// must be reconciled (looked up by sync_key) before it is retried.
export const calendarEventRefs = mysqlTable(
  "calendar_event_refs",
  {
    id: id(),
    ownerId: ownerId(),
    accountId: char("account_id", { length: 36 })
      .notNull()
      .references(() => calendarAccounts.id),
    calendarId: char("calendar_id", { length: 36 })
      .notNull()
      .references(() => syncedCalendars.id),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    ownership: mysqlEnum("ownership", ["external", "epiphany"]).notNull(),
    eventId: char("event_id", { length: 36 }).references(() => events.id),
    workBlockId: char("work_block_id", { length: 36 }).references(() => workBlocks.id),
    syncKey: varchar("sync_key", { length: 64 }),
    etag: varchar("etag", { length: 255 }),
    remoteUpdatedAt: utc("remote_updated_at"),
    recurringEventId: varchar("recurring_event_id", { length: 255 }),
    originalStartAt: utc("original_start_at"),
    syncedVersion: int("synced_version", { unsigned: true }),
    syncState: mysqlEnum("sync_state", CALENDAR_REF_STATES).notNull().default("synced"),
    lastError: varchar("last_error", { length: 300 }),
    lastSyncedAt: utc("last_synced_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("calendar_event_refs_calendar_external_uq").on(t.calendarId, t.externalId),
    uniqueIndex("calendar_event_refs_event_uq").on(t.eventId),
    uniqueIndex("calendar_event_refs_work_block_uq").on(t.workBlockId),
    index("calendar_event_refs_owner_state_idx").on(t.ownerId, t.syncState),
    index("calendar_event_refs_recurring_idx").on(t.calendarId, t.recurringEventId),
    check(
      "calendar_event_refs_ownership_link",
      sql`(${t.ownership} = 'external' AND ${t.workBlockId} IS NULL) OR (${t.ownership} = 'epiphany' AND ${t.eventId} IS NULL)`,
    ),
  ],
);

// Spending on providers other than the text model (transcription, speech), per owner, provider, and
// billing month, so each has its own limit that cannot be spent from another's.
export const providerUsage = mysqlTable(
  "provider_usage",
  {
    ownerId: ownerId(),
    provider: varchar("provider", { length: 16 }).notNull(),
    period: char("period", { length: 7 }).notNull(),
    costMicros: bigint("cost_micros", { mode: "number", unsigned: true }).notNull().default(0),
    calls: int("calls", { unsigned: true }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      columns: [t.ownerId, t.provider, t.period],
      name: "provider_usage_owner_id_provider_period_pk",
    }),
  ],
);

// Things the owner chose to report about how they work (how long something took, a snooze). Only
// voluntary updates are ever recorded; silence is not an observation.
export const observations = mysqlTable(
  "observations",
  {
    id: id(),
    ownerId: ownerId(),
    kind: mysqlEnum("kind", ["duration", "snooze"]).notNull(),
    subjectKey: varchar("subject_key", { length: 191 }).notNull(),
    value: int("value", { unsigned: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("observations_owner_kind_idx").on(t.ownerId, t.kind, t.createdAt)],
);

export type Reminder = typeof reminders.$inferSelect;
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
export type CalendarAccount = typeof calendarAccounts.$inferSelect;
export type SyncedCalendar = typeof syncedCalendars.$inferSelect;
export type CalendarEventRef = typeof calendarEventRefs.$inferSelect;
