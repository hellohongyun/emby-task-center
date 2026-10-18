PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tmdb_id` integer,
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
	CONSTRAINT "media_items_type_check" CHECK("__new_media_items"."media_type" IN ('movie', 'tv'))
);
--> statement-breakpoint
INSERT INTO `__new_media_items`("id", "tmdb_id", "media_type", "title", "original_title", "aliases_json", "release_year", "overview", "poster_url", "backdrop_url", "genres_json", "languages_json", "regions_json", "platforms_json", "season_count", "episode_count", "external_ids_json", "tmdb_payload_json", "synced_at", "created_at", "updated_at") SELECT "id", "tmdb_id", "media_type", "title", "original_title", "aliases_json", "release_year", "overview", "poster_url", "backdrop_url", "genres_json", "languages_json", "regions_json", "platforms_json", "season_count", "episode_count", "external_ids_json", "tmdb_payload_json", "synced_at", "created_at", "updated_at" FROM `media_items`;--> statement-breakpoint
DROP TABLE `media_items`;--> statement-breakpoint
ALTER TABLE `__new_media_items` RENAME TO `media_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `media_items_identity_idx` ON `media_items` (`media_type`,`tmdb_id`);--> statement-breakpoint
ALTER TABLE `media_tasks` ADD `schedule_day` integer;--> statement-breakpoint
ALTER TABLE `media_tasks` ADD `schedule_time` text;--> statement-breakpoint
ALTER TABLE `media_tasks` ADD `schedule_applied_key` text;