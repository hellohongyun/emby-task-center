ALTER TABLE `webhook_configs` ADD `last_delivery_at` text;--> statement-breakpoint
ALTER TABLE `webhook_configs` ADD `last_success_at` text;--> statement-breakpoint
ALTER TABLE `webhook_configs` ADD `last_delivery_error` text;--> statement-breakpoint
ALTER TABLE `webhook_configs` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_configs` ADD `circuit_state` text DEFAULT 'closed' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_configs` ADD `circuit_next_probe_at` text;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `last_notify_attempt_at` text;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `last_notify_error` text;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `consecutive_notify_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `notify_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `task_automation_settings` ADD `notify_paused_reason` text;--> statement-breakpoint
CREATE TABLE `notify_queue_settings` (`id` integer PRIMARY KEY NOT NULL, `paused` integer DEFAULT false NOT NULL, `paused_reason` text, `updated_at` text NOT NULL);