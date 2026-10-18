ALTER TABLE `library_items` ADD `source_title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `library_items` ADD `source_year` integer;--> statement-breakpoint
CREATE INDEX `library_items_media_item_idx` ON `library_items` (`media_item_id`);