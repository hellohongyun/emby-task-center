CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`method` text,
	`path` text,
	`status` integer,
	`duration_ms` integer,
	`detail` text,
	`created_at` text NOT NULL,
	CONSTRAINT "logs_level_check" CHECK("logs"."level" IN ('info', 'warn', 'error')),
	CONSTRAINT "logs_source_check" CHECK("logs"."source" IN ('server', 'web', 'mcp'))
);
--> statement-breakpoint
CREATE INDEX `logs_created_at_idx` ON `logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `logs_level_id_idx` ON `logs` (`level`,`id`);--> statement-breakpoint
CREATE INDEX `logs_source_id_idx` ON `logs` (`source`,`id`);