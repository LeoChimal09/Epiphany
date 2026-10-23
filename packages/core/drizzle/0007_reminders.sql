CREATE TABLE `reminders` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`kind` enum('task_deadline','event','check_in','briefing','wind_down','custom') NOT NULL,
	`subject_type` varchar(16),
	`subject_id` char(36),
	`dedupe_key` varchar(191) NOT NULL,
	`message` varchar(1000) NOT NULL,
	`urgency` enum('normal','high') NOT NULL DEFAULT 'normal',
	`due_at` datetime(3) NOT NULL,
	`status` enum('scheduled','sending','sent','skipped','failed','unknown','canceled') NOT NULL DEFAULT 'scheduled',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`next_attempt_at` datetime(3),
	`claimed_at` datetime(3),
	`sent_at` datetime(3),
	`detail` varchar(160),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reminders_id` PRIMARY KEY(`id`),
	CONSTRAINT `reminders_owner_dedupe_uq` UNIQUE(`owner_id`,`dedupe_key`)
);
--> statement-breakpoint
ALTER TABLE `reminders` ADD CONSTRAINT `reminders_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `reminders_due_idx` ON `reminders` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `reminders_subject_idx` ON `reminders` (`subject_type`,`subject_id`);