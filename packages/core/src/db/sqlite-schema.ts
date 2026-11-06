import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const utc = (name: string) => integer(name, { mode: "timestamp_ms" });
const id = () => text("id").primaryKey();
const ownerId = () =>
  text("owner_id")
    .notNull()
    .references(() => owners.id);
const createdAt = () =>
  utc("created_at")
    .notNull()
    .default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`);
const updatedAt = () =>
  utc("updated_at")
    .notNull()
    .default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
    .$onUpdate(() => new Date());
const version = () => integer("version").notNull().default(1);

function enumCheck(column: string, values: readonly string[]) {
  const literals = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return sql`${sql.identifier(column)} IN (${sql.raw(literals)})`;
}

function nonnegative(column: string) {
  return sql`${sql.identifier(column)} >= 0`;
}

export const ACTION_SOURCES = ["dashboard", "discord", "voice", "worker", "system"] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

export const owners = sqliteTable(
  "owners",
  {
    id: id(),
    displayName: text("display_name").notNull(),
    timezone: text("timezone").notNull().default("America/Chicago"),
    discordUserId: text("discord_user_id"),
    avatarHash: text("avatar_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("owners_discord_user_id_uq").on(t.discordUserId)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: id(),
    ownerId: ownerId(),
    name: text("name").notNull(),
    systemKey: text("system_key"),
    archivedAt: utc("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("categories_owner_name_uq").on(t.ownerId, sql`${t.name} COLLATE NOCASE`),
    uniqueIndex("categories_owner_system_key_uq").on(t.ownerId, t.systemKey),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    ownerId: ownerId(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    taskType: text("task_type", { enum: ["task", "todo"] })
      .notNull()
      .default("task"),
    title: text("title").notNull(),
    priority: text("priority", { enum: ["minor", "major"] })
      .notNull()
      .default("minor"),
    details: text("details"),
    sourceText: text("source_text"),
    sourceRef: text("source_ref"),
    reviewNote: text("review_note"),
    dueAt: utc("due_at"),
    dueDateOnly: integer("due_date_only", { mode: "boolean" }).notNull().default(false),
    splitReminderCount: integer("split_reminder_count"),
    estimatedMinutes: integer("estimated_minutes"),
    remainingMinutes: integer("remaining_minutes"),
    status: text("status", { enum: ["open", "completed", "canceled"] })
      .notNull()
      .default("open"),
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
    check("tasks_task_type_valid", enumCheck("task_type", ["task", "todo"])),
    check("tasks_priority_valid", enumCheck("priority", ["minor", "major"])),
    check("tasks_status_valid", enumCheck("status", ["open", "completed", "canceled"])),
    check("tasks_due_date_only_boolean", sql`${t.dueDateOnly} IN (0, 1)`),
    check("tasks_split_reminder_count_nonnegative", nonnegative("split_reminder_count")),
    check("tasks_estimated_minutes_nonnegative", nonnegative("estimated_minutes")),
    check("tasks_remaining_minutes_nonnegative", nonnegative("remaining_minutes")),
    check("tasks_version_positive", sql`${t.version} >= 1`),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: id(),
    ownerId: ownerId(),
    seriesId: text("series_id"),
    title: text("title").notNull(),
    location: text("location"),
    startsAt: utc("starts_at").notNull(),
    endsAt: utc("ends_at").notNull(),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    splitReminderCount: integer("split_reminder_count"),
    timezone: text("timezone").notNull(),
    status: text("status", { enum: ["scheduled", "canceled"] })
      .notNull()
      .default("scheduled"),
    canceledAt: utc("canceled_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("events_owner_status_start_idx").on(t.ownerId, t.status, t.startsAt),
    index("events_owner_series_idx").on(t.ownerId, t.seriesId),
    check("events_ends_not_before_starts", sql`${t.endsAt} >= ${t.startsAt}`),
    check(
      "events_canceled_at_matches_status",
      sql`(${t.status} = 'canceled') = (${t.canceledAt} IS NOT NULL)`,
    ),
    check("events_status_valid", enumCheck("status", ["scheduled", "canceled"])),
    check("events_all_day_boolean", sql`${t.allDay} IN (0, 1)`),
    check("events_split_reminder_count_nonnegative", nonnegative("split_reminder_count")),
    check("events_version_positive", sql`${t.version} >= 1`),
  ],
);

export const workBlocks = sqliteTable(
  "work_blocks",
  {
    id: id(),
    ownerId: ownerId(),
    taskId: text("task_id").references(() => tasks.id),
    title: text("title"),
    startsAt: utc("starts_at").notNull(),
    endsAt: utc("ends_at").notNull(),
    status: text("status", { enum: ["planned", "completed", "removed"] })
      .notNull()
      .default("planned"),
    completedAt: utc("completed_at"),
    removedAt: utc("removed_at"),
    removedReason: text("removed_reason", { enum: ["manual", "task_completed", "replanned"] }),
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
    check("work_blocks_status_valid", enumCheck("status", ["planned", "completed", "removed"])),
    check(
      "work_blocks_removed_reason_valid",
      sql`${t.removedReason} IS NULL OR (${enumCheck("removed_reason", ["manual", "task_completed", "replanned"])})`,
    ),
    check("work_blocks_version_positive", sql`${t.version} >= 1`),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    id: id(),
    ownerId: ownerId(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    kind: text("kind", { enum: ["note", "idea"] })
      .notNull()
      .default("note"),
    title: text("title"),
    body: text("body").notNull(),
    sourceRef: text("source_ref"),
    archivedAt: utc("archived_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("notes_owner_category_idx").on(t.ownerId, t.categoryId),
    index("notes_owner_created_idx").on(t.ownerId, t.createdAt),
    check("notes_kind_valid", enumCheck("kind", ["note", "idea"])),
    check("notes_version_positive", sql`${t.version} >= 1`),
  ],
);

export const preferences = sqliteTable(
  "preferences",
  {
    id: id(),
    ownerId: ownerId(),
    key: text("pref_key").notNull(),
    value: text("value", { mode: "json" }).notNull().$type<unknown>(),
    status: text("status", { enum: ["proposed", "confirmed"] })
      .notNull()
      .default("confirmed"),
    source: text("source", { enum: ACTION_SOURCES }).notNull().default("dashboard"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("preferences_owner_key_uq").on(t.ownerId, t.key),
    check("preferences_status_valid", enumCheck("status", ["proposed", "confirmed"])),
    check("preferences_source_valid", enumCheck("source", ACTION_SOURCES)),
    check("preferences_version_positive", sql`${t.version} >= 1`),
  ],
);

export const actionHistory = sqliteTable(
  "action_history",
  {
    id: id(),
    ownerId: ownerId(),
    source: text("source", { enum: ACTION_SOURCES }).notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: text("before", { mode: "json" }).$type<unknown>(),
    after: text("after", { mode: "json" }).$type<unknown>(),
    undoOfId: text("undo_of_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("action_history_owner_created_idx").on(t.ownerId, t.createdAt),
    index("action_history_entity_idx").on(t.entityType, t.entityId),
    check("action_history_source_valid", enumCheck("source", ACTION_SOURCES)),
  ],
);

export const CONFIRMATION_STATUSES = [
  "pending",
  "executed",
  "expired",
  "canceled",
  "superseded",
] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];
export type ConfirmationTarget = { entityType: string; entityId: string; version: number };

export const confirmations = sqliteTable(
  "confirmations",
  {
    id: id(),
    ownerId: ownerId(),
    action: text("action").notNull(),
    status: text("status", { enum: CONFIRMATION_STATUSES }).notNull().default("pending"),
    targets: text("targets", { mode: "json" }).notNull().$type<ConfirmationTarget[]>(),
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    payloadHash: text("payload_hash").notNull(),
    preview: text("preview", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    source: text("source", { enum: ACTION_SOURCES }).notNull(),
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
    check("confirmations_status_valid", enumCheck("status", CONFIRMATION_STATUSES)),
    check("confirmations_source_valid", enumCheck("source", ACTION_SOURCES)),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    expiresAt: utc("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_owner_idx").on(t.ownerId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const aiUsage = sqliteTable(
  "ai_usage",
  {
    ownerId: ownerId(),
    period: text("period").notNull(),
    costMicros: integer("cost_micros").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.period], name: "ai_usage_owner_id_period_pk" }),
    check("ai_usage_cost_micros_nonnegative", nonnegative("cost_micros")),
    check("ai_usage_calls_nonnegative", nonnegative("calls")),
  ],
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

export const reminders = sqliteTable(
  "reminders",
  {
    id: id(),
    ownerId: ownerId(),
    kind: text("kind", { enum: REMINDER_KINDS }).notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    dedupeKey: text("dedupe_key").notNull(),
    message: text("message").notNull(),
    urgency: text("urgency", { enum: ["normal", "high"] })
      .notNull()
      .default("normal"),
    dueAt: utc("due_at").notNull(),
    status: text("status", { enum: REMINDER_STATUSES }).notNull().default("scheduled"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: utc("next_attempt_at"),
    claimedAt: utc("claimed_at"),
    sentAt: utc("sent_at"),
    detail: text("detail"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("reminders_owner_dedupe_uq").on(t.ownerId, t.dedupeKey),
    index("reminders_due_idx").on(t.status, t.dueAt),
    index("reminders_subject_idx").on(t.subjectType, t.subjectId),
    check("reminders_kind_valid", enumCheck("kind", REMINDER_KINDS)),
    check("reminders_urgency_valid", enumCheck("urgency", ["normal", "high"])),
    check("reminders_status_valid", enumCheck("status", REMINDER_STATUSES)),
    check("reminders_attempts_nonnegative", nonnegative("attempts")),
    check("reminders_version_positive", sql`${t.version} >= 1`),
  ],
);

export const discordOverviews = sqliteTable(
  "discord_overviews",
  {
    ownerId: ownerId(),
    guildId: text("guild_id").notNull(),
    viewKey: text("view_key").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    contentHash: text("content_hash").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.guildId, t.viewKey], name: "discord_overviews_pk" })],
);

export const CALENDAR_PROVIDERS = ["google"] as const;
export const CALENDAR_ACCOUNT_STATUSES = ["connected", "needs_reauth", "revoked"] as const;
export type CalendarAccountStatus = (typeof CALENDAR_ACCOUNT_STATUSES)[number];

export const calendarAccounts = sqliteTable(
  "calendar_accounts",
  {
    id: id(),
    ownerId: ownerId(),
    provider: text("provider", { enum: CALENDAR_PROVIDERS }).notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    accountEmail: text("account_email"),
    status: text("status", { enum: CALENDAR_ACCOUNT_STATUSES }).notNull().default("connected"),
    scopes: text("scopes").notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessTokenExpiresAt: utc("access_token_expires_at"),
    epiphanyCalendarId: text("epiphany_calendar_id"),
    lastError: text("last_error"),
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
    check("calendar_accounts_provider_valid", enumCheck("provider", CALENDAR_PROVIDERS)),
    check("calendar_accounts_status_valid", enumCheck("status", CALENDAR_ACCOUNT_STATUSES)),
    check("calendar_accounts_version_positive", sql`${t.version} >= 1`),
  ],
);

export const CALENDAR_SYNC_STATUSES = ["pending", "ok", "stale", "error"] as const;
export type CalendarSyncStatus = (typeof CALENDAR_SYNC_STATUSES)[number];

export const syncedCalendars = sqliteTable(
  "synced_calendars",
  {
    id: id(),
    ownerId: ownerId(),
    accountId: text("account_id")
      .notNull()
      .references(() => calendarAccounts.id),
    externalId: text("external_id").notNull(),
    kind: text("kind", { enum: ["external", "epiphany"] })
      .notNull()
      .default("external"),
    summary: text("summary").notNull(),
    timeZone: text("time_zone"),
    accessRole: text("access_role"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    selected: integer("selected", { mode: "boolean" }).notNull().default(false),
    syncToken: text("sync_token"),
    fullSyncedAt: utc("full_synced_at"),
    lastSyncedAt: utc("last_synced_at"),
    lastAttemptAt: utc("last_attempt_at"),
    syncStatus: text("sync_status", { enum: CALENDAR_SYNC_STATUSES }).notNull().default("pending"),
    lastError: text("last_error"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("synced_calendars_account_external_uq").on(t.accountId, t.externalId),
    index("synced_calendars_owner_idx").on(t.ownerId),
    check("synced_calendars_kind_valid", enumCheck("kind", ["external", "epiphany"])),
    check("synced_calendars_sync_status_valid", enumCheck("sync_status", CALENDAR_SYNC_STATUSES)),
    check("synced_calendars_is_primary_boolean", sql`${t.isPrimary} IN (0, 1)`),
    check("synced_calendars_selected_boolean", sql`${t.selected} IN (0, 1)`),
    check("synced_calendars_version_positive", sql`${t.version} >= 1`),
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

export const calendarEventRefs = sqliteTable(
  "calendar_event_refs",
  {
    id: id(),
    ownerId: ownerId(),
    accountId: text("account_id")
      .notNull()
      .references(() => calendarAccounts.id),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => syncedCalendars.id),
    externalId: text("external_id").notNull(),
    ownership: text("ownership", { enum: ["external", "epiphany"] }).notNull(),
    eventId: text("event_id").references(() => events.id),
    workBlockId: text("work_block_id").references(() => workBlocks.id),
    syncKey: text("sync_key"),
    etag: text("etag"),
    remoteUpdatedAt: utc("remote_updated_at"),
    recurringEventId: text("recurring_event_id"),
    originalStartAt: utc("original_start_at"),
    syncedVersion: integer("synced_version"),
    syncState: text("sync_state", { enum: CALENDAR_REF_STATES }).notNull().default("synced"),
    lastError: text("last_error"),
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
    check("calendar_event_refs_ownership_valid", enumCheck("ownership", ["external", "epiphany"])),
    check("calendar_event_refs_sync_state_valid", enumCheck("sync_state", CALENDAR_REF_STATES)),
    check("calendar_event_refs_synced_version_nonnegative", nonnegative("synced_version")),
  ],
);

export const providerUsage = sqliteTable(
  "provider_usage",
  {
    ownerId: ownerId(),
    provider: text("provider").notNull(),
    period: text("period").notNull(),
    costMicros: integer("cost_micros").notNull(),
    calls: integer("calls").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      columns: [t.ownerId, t.provider, t.period],
      name: "provider_usage_owner_id_provider_period_pk",
    }),
    check("provider_usage_cost_micros_nonnegative", nonnegative("cost_micros")),
    check("provider_usage_calls_nonnegative", nonnegative("calls")),
  ],
);

export const observations = sqliteTable(
  "observations",
  {
    id: id(),
    ownerId: ownerId(),
    kind: text("kind", { enum: ["duration", "snooze"] }).notNull(),
    subjectKey: text("subject_key").notNull(),
    value: integer("value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("observations_owner_kind_idx").on(t.ownerId, t.kind, t.createdAt),
    check("observations_kind_valid", enumCheck("kind", ["duration", "snooze"])),
    check("observations_value_nonnegative", nonnegative("value")),
  ],
);

export const sqliteSchema = {
  owners,
  categories,
  tasks,
  events,
  workBlocks,
  notes,
  preferences,
  actionHistory,
  confirmations,
  sessions,
  aiUsage,
  reminders,
  discordOverviews,
  calendarAccounts,
  syncedCalendars,
  calendarEventRefs,
  providerUsage,
  observations,
};

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
