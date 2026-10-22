CREATE TABLE `observations` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`kind` enum('duration','snooze') NOT NULL,
	`subject_key` varchar(191) NOT NULL,
	`value` int unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `observations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `provider_usage` (
	`owner_id` char(36) NOT NULL,
	`provider` varchar(16) NOT NULL,
	`period` char(7) NOT NULL,
	`cost_micros` bigint unsigned NOT NULL DEFAULT 0,
	`calls` int unsigned NOT NULL DEFAULT 0,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `provider_usage_owner_id_provider_period_pk` PRIMARY KEY(`owner_id`,`provider`,`period`)
);
--> statement-breakpoint
ALTER TABLE `observations` ADD CONSTRAINT `observations_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `provider_usage` ADD CONSTRAINT `provider_usage_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `observations_owner_kind_idx` ON `observations` (`owner_id`,`kind`,`created_at`);