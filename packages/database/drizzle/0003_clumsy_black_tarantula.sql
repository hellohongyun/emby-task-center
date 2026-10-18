CREATE TABLE `automation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`webhook_id` integer NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`requested_episodes_json` text DEFAULT '[]' NOT NULL,
	`summary` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`response_code` integer,
	`error` text,
	`triggered_at` text,
	`verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `media_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhook_configs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "automation_runs_status_check" CHECK("automation_runs"."status" IN ('waiting', 'dispatching', 'verifying', 'succeeded', 'blocked', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `automation_runs_status_idx` ON `automation_runs` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automation_run_id` integer NOT NULL,
	`recipient_id` integer,
	`email` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`automation_run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `task_notification_recipients`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notification_delivery_status_check" CHECK("notification_deliveries"."status" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_identity_idx` ON `notification_deliveries` (`automation_run_id`,`email`);--> statement-breakpoint
CREATE TABLE `task_automation_settings` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`agent_webhook_id` integer,
	`litepan_webhook_id` integer,
	`target_path` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `media_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_webhook_id`) REFERENCES `webhook_configs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`litepan_webhook_id`) REFERENCES `webhook_configs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `task_notification_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`email` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `media_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_recipient_identity_idx` ON `task_notification_recipients` (`task_id`,`email`);--> statement-breakpoint
CREATE TABLE `webhook_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`event` text NOT NULL,
	`message` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "webhook_configs_kind_check" CHECK("webhook_configs"."kind" IN ('agent', 'litepan'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_configs_name_unique` ON `webhook_configs` (`name`);