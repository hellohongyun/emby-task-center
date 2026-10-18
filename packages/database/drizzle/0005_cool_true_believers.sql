PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_automation_settings` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`agent_webhook_id` integer,
	`litepan_webhook_id` integer,
	`target_path` text,
	`auto_notify_agent` integer DEFAULT true NOT NULL,
	`last_agent_notification_key` text,
	`last_agent_notified_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `media_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_webhook_id`) REFERENCES `webhook_configs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`litepan_webhook_id`) REFERENCES `webhook_configs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_task_automation_settings`("task_id", "agent_webhook_id", "litepan_webhook_id", "target_path", "auto_notify_agent", "last_agent_notification_key", "last_agent_notified_at", "updated_at") SELECT "task_id", "agent_webhook_id", "litepan_webhook_id", "target_path", "auto_notify_agent", "last_agent_notification_key", "last_agent_notified_at", "updated_at" FROM `task_automation_settings`;--> statement-breakpoint
DROP TABLE `task_automation_settings`;--> statement-breakpoint
ALTER TABLE `__new_task_automation_settings` RENAME TO `task_automation_settings`;--> statement-breakpoint
INSERT INTO `task_automation_settings` (`task_id`, `agent_webhook_id`, `litepan_webhook_id`, `target_path`, `auto_notify_agent`, `updated_at`)
SELECT `id`, NULL, NULL, NULL, true, CURRENT_TIMESTAMP FROM `media_tasks`
WHERE NOT EXISTS (SELECT 1 FROM `task_automation_settings` WHERE `task_id` = `media_tasks`.`id`);--> statement-breakpoint
UPDATE `task_automation_settings` SET `auto_notify_agent` = true;--> statement-breakpoint
UPDATE `task_automation_settings`
SET `agent_webhook_id` = (SELECT `id` FROM `webhook_configs` WHERE `kind` = 'agent' AND `enabled` = true LIMIT 1)
WHERE `agent_webhook_id` IS NULL
AND (SELECT COUNT(*) FROM `webhook_configs` WHERE `kind` = 'agent' AND `enabled` = true) = 1;--> statement-breakpoint
PRAGMA foreign_keys=ON;
