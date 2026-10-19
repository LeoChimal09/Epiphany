CREATE TABLE `action_history` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`source` enum('dashboard','discord','voice','worker','system') NOT NULL,
	`action` varchar(64) NOT NULL,
	`entity_type` varchar(32) NOT NULL,
	`entity_id` char(36) NOT NULL,
	`before` json,
	`after` json,
	`undo_of_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `action_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`system_key` varchar(32),
	`archived_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `categories_owner_name_uq` UNIQUE(`owner_id`,`name`),
	CONSTRAINT `categories_owner_system_key_uq` UNIQUE(`owner_id`,`system_key`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`title` varchar(300) NOT NULL,
	`location` varchar(300),
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3) NOT NULL,
	`all_day` boolean NOT NULL DEFAULT false,
	`timezone` varchar(64) NOT NULL,
	`status` enum('scheduled','canceled') NOT NULL DEFAULT 'scheduled',
	`canceled_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `events_id` PRIMARY KEY(`id`),
	CONSTRAINT `events_ends_not_before_starts` CHECK(`events`.`ends_at` >= `events`.`starts_at`),
	CONSTRAINT `events_canceled_at_matches_status` CHECK((`events`.`status` = 'canceled') = (`events`.`canceled_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`category_id` char(36) NOT NULL,
	`kind` enum('note','idea') NOT NULL DEFAULT 'note',
	`title` varchar(300),
	`body` text NOT NULL,
	`source_ref` varchar(255),
	`archived_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `owners` (
	`id` char(36) NOT NULL,
	`display_name` varchar(100) NOT NULL,
	`timezone` varchar(64) NOT NULL DEFAULT 'America/Chicago',
	`discord_user_id` varchar(32),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `owners_id` PRIMARY KEY(`id`),
	CONSTRAINT `owners_discord_user_id_uq` UNIQUE(`discord_user_id`)
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`pref_key` varchar(100) NOT NULL,
	`value` json NOT NULL,
	`status` enum('proposed','confirmed') NOT NULL DEFAULT 'confirmed',
	`source` enum('dashboard','discord','voice','worker','system') NOT NULL DEFAULT 'dashboard',
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `preferences_owner_key_uq` UNIQUE(`owner_id`,`pref_key`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`category_id` char(36) NOT NULL,
	`title` varchar(300) NOT NULL,
	`details` text,
	`source_text` text,
	`source_ref` varchar(255),
	`due_at` datetime(3),
	`due_date_only` boolean NOT NULL DEFAULT false,
	`estimated_minutes` int unsigned,
	`remaining_minutes` int unsigned,
	`status` enum('open','completed') NOT NULL DEFAULT 'open',
	`completed_at` datetime(3),
	`archived_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `tasks_completed_at_matches_status` CHECK((`tasks`.`status` = 'completed') = (`tasks`.`completed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `work_blocks` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`task_id` char(36),
	`title` varchar(300),
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3) NOT NULL,
	`status` enum('planned','completed','removed') NOT NULL DEFAULT 'planned',
	`completed_at` datetime(3),
	`removed_at` datetime(3),
	`removed_reason` enum('manual','task_completed','replanned'),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `work_blocks_id` PRIMARY KEY(`id`),
	CONSTRAINT `work_blocks_ends_after_starts` CHECK(`work_blocks`.`ends_at` > `work_blocks`.`starts_at`),
	CONSTRAINT `work_blocks_timestamps_match_status` CHECK((`work_blocks`.`status` = 'completed') = (`work_blocks`.`completed_at` IS NOT NULL) AND (`work_blocks`.`status` = 'removed') = (`work_blocks`.`removed_at` IS NOT NULL) AND (`work_blocks`.`status` = 'removed' OR `work_blocks`.`removed_reason` IS NULL))
);
--> statement-breakpoint
ALTER TABLE `action_history` ADD CONSTRAINT `action_history_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `categories` ADD CONSTRAINT `categories_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `events` ADD CONSTRAINT `events_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notes` ADD CONSTRAINT `notes_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notes` ADD CONSTRAINT `notes_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `preferences` ADD CONSTRAINT `preferences_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_blocks` ADD CONSTRAINT `work_blocks_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_blocks` ADD CONSTRAINT `work_blocks_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `action_history_owner_created_idx` ON `action_history` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `action_history_entity_idx` ON `action_history` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `events_owner_status_start_idx` ON `events` (`owner_id`,`status`,`starts_at`);--> statement-breakpoint
CREATE INDEX `notes_owner_category_idx` ON `notes` (`owner_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `notes_owner_created_idx` ON `notes` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_owner_status_due_idx` ON `tasks` (`owner_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_owner_category_idx` ON `tasks` (`owner_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `tasks_owner_archived_idx` ON `tasks` (`owner_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `work_blocks_owner_status_start_idx` ON `work_blocks` (`owner_id`,`status`,`starts_at`);--> statement-breakpoint
CREATE INDEX `work_blocks_task_idx` ON `work_blocks` (`task_id`);