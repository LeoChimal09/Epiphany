ALTER TABLE `tasks` ADD `task_type` enum('task','todo') DEFAULT 'task' NOT NULL;
--> statement-breakpoint
UPDATE `tasks` SET `task_type` = 'todo', `priority` = 'minor', `due_date_only` = 0, `remaining_minutes` = NULL WHERE `due_at` IS NULL AND `estimated_minutes` IS NULL;