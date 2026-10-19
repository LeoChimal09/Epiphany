CREATE TABLE `confirmations` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`action` varchar(64) NOT NULL,
	`status` enum('pending','executed','expired','canceled','superseded') NOT NULL DEFAULT 'pending',
	`targets` json NOT NULL,
	`payload` json NOT NULL,
	`payload_hash` char(64) NOT NULL,
	`preview` json NOT NULL,
	`source` enum('dashboard','discord','voice','worker','system') NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `confirmations_id` PRIMARY KEY(`id`),
	CONSTRAINT `confirmations_resolved_at_matches_status` CHECK((`confirmations`.`status` = 'pending') = (`confirmations`.`resolved_at` IS NULL))
);
--> statement-breakpoint
ALTER TABLE `confirmations` ADD CONSTRAINT `confirmations_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `confirmations_owner_status_idx` ON `confirmations` (`owner_id`,`status`,`expires_at`);