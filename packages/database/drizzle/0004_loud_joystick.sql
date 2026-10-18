ALTER TABLE `task_automation_settings` ADD `auto_notify_agent` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `last_agent_notification_key` text;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `last_agent_notified_at` text;