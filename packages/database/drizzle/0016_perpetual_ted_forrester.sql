ALTER TABLE `task_automation_settings` ADD `release_weekday` integer;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `release_time` text;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `notification_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `next_notify_at` text;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `notify_status` text DEFAULT 'idle' NOT NULL;