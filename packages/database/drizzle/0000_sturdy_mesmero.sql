CREATE TABLE `library_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_item_id` integer NOT NULL,
	`physical_season` integer,
	`parsed_season` integer,
	`episode_number` integer,
	`absolute_episode_number` integer,
	`numbering_mode` text DEFAULT 'unresolved' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`library_item_id`) REFERENCES `library_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `library_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_root_id` integer NOT NULL,
	`media_item_id` integer,
	`relative_path` text NOT NULL,
	`confidence` real,
	`recognition_status` text DEFAULT 'unresolved' NOT NULL,
	`file_modified_at` text,
	`scan_warning` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`media_root_id`) REFERENCES `media_roots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_items_path_idx` ON `library_items` (`media_root_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `library_scan_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_root_id` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`discovered_count` integer DEFAULT 0 NOT NULL,
	`unresolved_count` integer DEFAULT 0 NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	FOREIGN KEY (`media_root_id`) REFERENCES `media_roots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `media_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tmdb_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`title` text NOT NULL,
	`original_title` text,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`release_year` integer,
	`overview` text,
	`poster_url` text,
	`backdrop_url` text,
	`genres_json` text DEFAULT '[]' NOT NULL,
	`languages_json` text DEFAULT '[]' NOT NULL,
	`regions_json` text DEFAULT '[]' NOT NULL,
	`platforms_json` text DEFAULT '[]' NOT NULL,
	`season_count` integer,
	`episode_count` integer,
	`external_ids_json` text DEFAULT '{}' NOT NULL,
	`tmdb_payload_json` text DEFAULT '{}' NOT NULL,
	`synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "media_items_type_check" CHECK("media_items"."media_type" IN ('movie', 'tv'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_items_identity_idx` ON `media_items` (`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `media_roots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`container_path` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_scan_status` text,
	`last_scanned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_roots_name_unique` ON `media_roots` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_roots_container_path_unique` ON `media_roots` (`container_path`);--> statement-breakpoint
CREATE TABLE `media_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_item_id` integer NOT NULL,
	`task_type` text NOT NULL,
	`target_season` integer,
	`air_progress` integer,
	`stored_progress` integer,
	`status` text NOT NULL,
	`status_message` text,
	`target_path` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_source` text DEFAULT 'unknown' NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`last_checked_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`media_item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "media_tasks_type_check" CHECK("media_tasks"."task_type" IN ('ingest', 'follow')),
	CONSTRAINT "media_tasks_status_check" CHECK("media_tasks"."status" IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_tasks_idempotency_key_unique` ON `media_tasks` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`worker_id` text,
	`phase` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`summary` text,
	`error` text,
	`before_status` text,
	`after_status` text,
	FOREIGN KEY (`task_id`) REFERENCES `media_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
