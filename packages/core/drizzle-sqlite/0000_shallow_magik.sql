CREATE TABLE `action_history` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`undo_of_id` text,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "action_history_source_valid" CHECK("source" IN ('dashboard', 'discord', 'voice', 'worker', 'system'))
);
--> statement-breakpoint
CREATE INDEX `action_history_owner_created_idx` ON `action_history` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `action_history_entity_idx` ON `action_history` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`owner_id` text NOT NULL,
	`period` text NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`owner_id`, `period`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_usage_cost_micros_nonnegative" CHECK("cost_micros" >= 0),
	CONSTRAINT "ai_usage_calls_nonnegative" CHECK("calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE `calendar_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`account_email` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`scopes` text NOT NULL,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`access_token_expires_at` integer,
	`epiphany_calendar_id` text,
	`last_error` text,
	`connected_at` integer NOT NULL,
	`disconnected_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "calendar_accounts_tokens_only_when_connected" CHECK("calendar_accounts"."status" = 'connected' OR ("calendar_accounts"."access_token_enc" IS NULL AND "calendar_accounts"."refresh_token_enc" IS NULL)),
	CONSTRAINT "calendar_accounts_provider_valid" CHECK("provider" IN ('google')),
	CONSTRAINT "calendar_accounts_status_valid" CHECK("status" IN ('connected', 'needs_reauth', 'revoked')),
	CONSTRAINT "calendar_accounts_version_positive" CHECK("calendar_accounts"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_accounts_owner_provider_account_uq` ON `calendar_accounts` (`owner_id`,`provider`,`provider_account_id`);--> statement-breakpoint
CREATE TABLE `calendar_event_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`external_id` text NOT NULL,
	`ownership` text NOT NULL,
	`event_id` text,
	`work_block_id` text,
	`sync_key` text,
	`etag` text,
	`remote_updated_at` integer,
	`recurring_event_id` text,
	`original_start_at` integer,
	`synced_version` integer,
	`sync_state` text DEFAULT 'synced' NOT NULL,
	`last_error` text,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `calendar_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`calendar_id`) REFERENCES `synced_calendars`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_block_id`) REFERENCES `work_blocks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "calendar_event_refs_ownership_link" CHECK(("calendar_event_refs"."ownership" = 'external' AND "calendar_event_refs"."work_block_id" IS NULL) OR ("calendar_event_refs"."ownership" = 'epiphany' AND "calendar_event_refs"."event_id" IS NULL)),
	CONSTRAINT "calendar_event_refs_ownership_valid" CHECK("ownership" IN ('external', 'epiphany')),
	CONSTRAINT "calendar_event_refs_sync_state_valid" CHECK("sync_state" IN ('synced', 'pending', 'uncertain', 'conflict', 'remote_deleted', 'removed', 'detached')),
	CONSTRAINT "calendar_event_refs_synced_version_nonnegative" CHECK("synced_version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_refs_calendar_external_uq` ON `calendar_event_refs` (`calendar_id`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_refs_event_uq` ON `calendar_event_refs` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_refs_work_block_uq` ON `calendar_event_refs` (`work_block_id`);--> statement-breakpoint
CREATE INDEX `calendar_event_refs_owner_state_idx` ON `calendar_event_refs` (`owner_id`,`sync_state`);--> statement-breakpoint
CREATE INDEX `calendar_event_refs_recurring_idx` ON `calendar_event_refs` (`calendar_id`,`recurring_event_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`system_key` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_owner_name_uq` ON `categories` (`owner_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_owner_system_key_uq` ON `categories` (`owner_id`,`system_key`);--> statement-breakpoint
CREATE TABLE `confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`targets` text NOT NULL,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`preview` text NOT NULL,
	`source` text NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "confirmations_resolved_at_matches_status" CHECK(("confirmations"."status" = 'pending') = ("confirmations"."resolved_at" IS NULL)),
	CONSTRAINT "confirmations_status_valid" CHECK("status" IN ('pending', 'executed', 'expired', 'canceled', 'superseded')),
	CONSTRAINT "confirmations_source_valid" CHECK("source" IN ('dashboard', 'discord', 'voice', 'worker', 'system'))
);
--> statement-breakpoint
CREATE INDEX `confirmations_owner_status_idx` ON `confirmations` (`owner_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `discord_overviews` (
	`owner_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`view_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`owner_id`, `guild_id`, `view_key`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`series_id` text,
	`title` text NOT NULL,
	`location` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`split_reminder_count` integer,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`canceled_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_ends_not_before_starts" CHECK("events"."ends_at" >= "events"."starts_at"),
	CONSTRAINT "events_canceled_at_matches_status" CHECK(("events"."status" = 'canceled') = ("events"."canceled_at" IS NOT NULL)),
	CONSTRAINT "events_status_valid" CHECK("status" IN ('scheduled', 'canceled')),
	CONSTRAINT "events_all_day_boolean" CHECK("events"."all_day" IN (0, 1)),
	CONSTRAINT "events_split_reminder_count_nonnegative" CHECK("split_reminder_count" >= 0),
	CONSTRAINT "events_version_positive" CHECK("events"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `events_owner_status_start_idx` ON `events` (`owner_id`,`status`,`starts_at`);--> statement-breakpoint
CREATE INDEX `events_owner_series_idx` ON `events` (`owner_id`,`series_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`category_id` text NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`source_ref` text,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notes_kind_valid" CHECK("kind" IN ('note', 'idea')),
	CONSTRAINT "notes_version_positive" CHECK("notes"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `notes_owner_category_idx` ON `notes` (`owner_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `notes_owner_created_idx` ON `notes` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `observations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_key` text NOT NULL,
	`value` integer NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "observations_kind_valid" CHECK("kind" IN ('duration', 'snooze')),
	CONSTRAINT "observations_value_nonnegative" CHECK("value" >= 0)
);
--> statement-breakpoint
CREATE INDEX `observations_owner_kind_idx` ON `observations` (`owner_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `owners` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`timezone` text DEFAULT 'America/Chicago' NOT NULL,
	`discord_user_id` text,
	`avatar_hash` text,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owners_discord_user_id_uq` ON `owners` (`discord_user_id`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`pref_key` text NOT NULL,
	`value` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`source` text DEFAULT 'dashboard' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "preferences_status_valid" CHECK("status" IN ('proposed', 'confirmed')),
	CONSTRAINT "preferences_source_valid" CHECK("source" IN ('dashboard', 'discord', 'voice', 'worker', 'system')),
	CONSTRAINT "preferences_version_positive" CHECK("preferences"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preferences_owner_key_uq` ON `preferences` (`owner_id`,`pref_key`);--> statement-breakpoint
CREATE TABLE `provider_usage` (
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`period` text NOT NULL,
	`cost_micros` integer NOT NULL,
	`calls` integer NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`owner_id`, `provider`, `period`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "provider_usage_cost_micros_nonnegative" CHECK("cost_micros" >= 0),
	CONSTRAINT "provider_usage_calls_nonnegative" CHECK("calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`dedupe_key` text NOT NULL,
	`message` text NOT NULL,
	`urgency` text DEFAULT 'normal' NOT NULL,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`claimed_at` integer,
	`sent_at` integer,
	`detail` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reminders_kind_valid" CHECK("kind" IN ('task_deadline', 'event', 'check_in', 'briefing', 'wind_down', 'custom')),
	CONSTRAINT "reminders_urgency_valid" CHECK("urgency" IN ('normal', 'high')),
	CONSTRAINT "reminders_status_valid" CHECK("status" IN ('scheduled', 'sending', 'sent', 'skipped', 'failed', 'unknown', 'canceled')),
	CONSTRAINT "reminders_attempts_nonnegative" CHECK("attempts" >= 0),
	CONSTRAINT "reminders_version_positive" CHECK("reminders"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_owner_dedupe_uq` ON `reminders` (`owner_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `reminders_due_idx` ON `reminders` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `reminders_subject_idx` ON `reminders` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_owner_idx` ON `sessions` (`owner_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `synced_calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text DEFAULT 'external' NOT NULL,
	`summary` text NOT NULL,
	`time_zone` text,
	`access_role` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`sync_token` text,
	`full_synced_at` integer,
	`last_synced_at` integer,
	`last_attempt_at` integer,
	`sync_status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `calendar_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "synced_calendars_kind_valid" CHECK("kind" IN ('external', 'epiphany')),
	CONSTRAINT "synced_calendars_sync_status_valid" CHECK("sync_status" IN ('pending', 'ok', 'stale', 'error')),
	CONSTRAINT "synced_calendars_is_primary_boolean" CHECK("synced_calendars"."is_primary" IN (0, 1)),
	CONSTRAINT "synced_calendars_selected_boolean" CHECK("synced_calendars"."selected" IN (0, 1)),
	CONSTRAINT "synced_calendars_version_positive" CHECK("synced_calendars"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `synced_calendars_account_external_uq` ON `synced_calendars` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `synced_calendars_owner_idx` ON `synced_calendars` (`owner_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`category_id` text NOT NULL,
	`task_type` text DEFAULT 'task' NOT NULL,
	`title` text NOT NULL,
	`priority` text DEFAULT 'minor' NOT NULL,
	`details` text,
	`source_text` text,
	`source_ref` text,
	`review_note` text,
	`due_at` integer,
	`due_date_only` integer DEFAULT false NOT NULL,
	`split_reminder_count` integer,
	`estimated_minutes` integer,
	`remaining_minutes` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`completed_at` integer,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_completed_at_matches_status" CHECK(("tasks"."status" = 'completed') = ("tasks"."completed_at" IS NOT NULL)),
	CONSTRAINT "tasks_task_type_valid" CHECK("task_type" IN ('task', 'todo')),
	CONSTRAINT "tasks_priority_valid" CHECK("priority" IN ('minor', 'major')),
	CONSTRAINT "tasks_status_valid" CHECK("status" IN ('open', 'completed', 'canceled')),
	CONSTRAINT "tasks_due_date_only_boolean" CHECK("tasks"."due_date_only" IN (0, 1)),
	CONSTRAINT "tasks_split_reminder_count_nonnegative" CHECK("split_reminder_count" >= 0),
	CONSTRAINT "tasks_estimated_minutes_nonnegative" CHECK("estimated_minutes" >= 0),
	CONSTRAINT "tasks_remaining_minutes_nonnegative" CHECK("remaining_minutes" >= 0),
	CONSTRAINT "tasks_version_positive" CHECK("tasks"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `tasks_owner_status_due_idx` ON `tasks` (`owner_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_owner_category_idx` ON `tasks` (`owner_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `tasks_owner_archived_idx` ON `tasks` (`owner_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `work_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`task_id` text,
	`title` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`completed_at` integer,
	`removed_at` integer,
	`removed_reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_blocks_ends_after_starts" CHECK("work_blocks"."ends_at" > "work_blocks"."starts_at"),
	CONSTRAINT "work_blocks_timestamps_match_status" CHECK(("work_blocks"."status" = 'completed') = ("work_blocks"."completed_at" IS NOT NULL) AND ("work_blocks"."status" = 'removed') = ("work_blocks"."removed_at" IS NOT NULL) AND ("work_blocks"."status" = 'removed' OR "work_blocks"."removed_reason" IS NULL)),
	CONSTRAINT "work_blocks_status_valid" CHECK("status" IN ('planned', 'completed', 'removed')),
	CONSTRAINT "work_blocks_removed_reason_valid" CHECK("work_blocks"."removed_reason" IS NULL OR ("removed_reason" IN ('manual', 'task_completed', 'replanned'))),
	CONSTRAINT "work_blocks_version_positive" CHECK("work_blocks"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `work_blocks_owner_status_start_idx` ON `work_blocks` (`owner_id`,`status`,`starts_at`);--> statement-breakpoint
CREATE INDEX `work_blocks_task_idx` ON `work_blocks` (`task_id`);