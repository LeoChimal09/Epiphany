ALTER TABLE `events` ADD `series_id` char(36);--> statement-breakpoint
CREATE INDEX `events_owner_series_idx` ON `events` (`owner_id`,`series_id`);