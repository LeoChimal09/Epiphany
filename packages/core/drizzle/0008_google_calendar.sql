CREATE TABLE `calendar_accounts` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`provider` enum('google') NOT NULL,
	`provider_account_id` varchar(255) NOT NULL,
	`account_email` varchar(320),
	`status` enum('connected','needs_reauth','revoked') NOT NULL DEFAULT 'connected',
	`scopes` varchar(1000) NOT NULL,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`access_token_expires_at` datetime(3),
	`epiphany_calendar_id` varchar(255),
	`last_error` varchar(300),
	`connected_at` datetime(3) NOT NULL,
	`disconnected_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `calendar_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_accounts_owner_provider_account_uq` UNIQUE(`owner_id`,`provider`,`provider_account_id`),
	CONSTRAINT `calendar_accounts_tokens_only_when_connected` CHECK(`calendar_accounts`.`status` = 'connected' OR (`calendar_accounts`.`access_token_enc` IS NULL AND `calendar_accounts`.`refresh_token_enc` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `calendar_event_refs` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`account_id` char(36) NOT NULL,
	`calendar_id` char(36) NOT NULL,
	`external_id` varchar(255) NOT NULL,
	`ownership` enum('external','epiphany') NOT NULL,
	`event_id` char(36),
	`work_block_id` char(36),
	`sync_key` varchar(64),
	`etag` varchar(255),
	`remote_updated_at` datetime(3),
	`recurring_event_id` varchar(255),
	`original_start_at` datetime(3),
	`synced_version` int unsigned,
	`sync_state` enum('synced','pending','uncertain','conflict','remote_deleted','removed','detached') NOT NULL DEFAULT 'synced',
	`last_error` varchar(300),
	`last_synced_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `calendar_event_refs_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_event_refs_calendar_external_uq` UNIQUE(`calendar_id`,`external_id`),
	CONSTRAINT `calendar_event_refs_event_uq` UNIQUE(`event_id`),
	CONSTRAINT `calendar_event_refs_work_block_uq` UNIQUE(`work_block_id`),
	CONSTRAINT `calendar_event_refs_ownership_link` CHECK((`calendar_event_refs`.`ownership` = 'external' AND `calendar_event_refs`.`work_block_id` IS NULL) OR (`calendar_event_refs`.`ownership` = 'epiphany' AND `calendar_event_refs`.`event_id` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `synced_calendars` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`account_id` char(36) NOT NULL,
	`external_id` varchar(255) NOT NULL,
	`kind` enum('external','epiphany') NOT NULL DEFAULT 'external',
	`summary` varchar(300) NOT NULL,
	`time_zone` varchar(64),
	`access_role` varchar(24),
	`is_primary` boolean NOT NULL DEFAULT false,
	`selected` boolean NOT NULL DEFAULT false,
	`sync_token` text,
	`full_synced_at` datetime(3),
	`last_synced_at` datetime(3),
	`last_attempt_at` datetime(3),
	`sync_status` enum('pending','ok','stale','error') NOT NULL DEFAULT 'pending',
	`last_error` varchar(300),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `synced_calendars_id` PRIMARY KEY(`id`),
	CONSTRAINT `synced_calendars_account_external_uq` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `calendar_accounts` ADD CONSTRAINT `calendar_accounts_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_event_refs` ADD CONSTRAINT `calendar_event_refs_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_event_refs` ADD CONSTRAINT `calendar_event_refs_account_id_calendar_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `calendar_accounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_event_refs` ADD CONSTRAINT `calendar_event_refs_calendar_id_synced_calendars_id_fk` FOREIGN KEY (`calendar_id`) REFERENCES `synced_calendars`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_event_refs` ADD CONSTRAINT `calendar_event_refs_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_event_refs` ADD CONSTRAINT `calendar_event_refs_work_block_id_work_blocks_id_fk` FOREIGN KEY (`work_block_id`) REFERENCES `work_blocks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `synced_calendars` ADD CONSTRAINT `synced_calendars_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `synced_calendars` ADD CONSTRAINT `synced_calendars_account_id_calendar_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `calendar_accounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `calendar_event_refs_owner_state_idx` ON `calendar_event_refs` (`owner_id`,`sync_state`);--> statement-breakpoint
CREATE INDEX `calendar_event_refs_recurring_idx` ON `calendar_event_refs` (`calendar_id`,`recurring_event_id`);--> statement-breakpoint
CREATE INDEX `synced_calendars_owner_idx` ON `synced_calendars` (`owner_id`);