DROP INDEX `categories_owner_name_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_owner_name_uq` ON `categories` (`owner_id`,"name" COLLATE NOCASE);