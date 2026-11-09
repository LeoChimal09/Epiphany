CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`data` text NOT NULL,
	`turn_token` text,
	`busy_until` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_sessions_data_json" CHECK(json_valid("chat_sessions"."data"))
);
--> statement-breakpoint
CREATE INDEX `chat_sessions_owner_updated_idx` ON `chat_sessions` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `chat_sessions_expires_idx` ON `chat_sessions` (`expires_at`);