CREATE TABLE `ai_usage` (
	`owner_id` char(36) NOT NULL,
	`period` char(7) NOT NULL,
	`cost_micros` bigint unsigned NOT NULL DEFAULT 0,
	`calls` int unsigned NOT NULL DEFAULT 0,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ai_usage_owner_id_period_pk` PRIMARY KEY(`owner_id`,`period`)
);
--> statement-breakpoint
ALTER TABLE `ai_usage` ADD CONSTRAINT `ai_usage_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;