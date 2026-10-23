CREATE TABLE `discord_overviews` (
	`owner_id` char(36) NOT NULL,
	`guild_id` varchar(32) NOT NULL,
	`view_key` varchar(32) NOT NULL,
	`channel_id` varchar(32) NOT NULL,
	`message_id` varchar(32) NOT NULL,
	`content_hash` char(64) NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `discord_overviews_pk` PRIMARY KEY(`owner_id`,`guild_id`,`view_key`)
);
--> statement-breakpoint
ALTER TABLE `discord_overviews` ADD CONSTRAINT `discord_overviews_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;