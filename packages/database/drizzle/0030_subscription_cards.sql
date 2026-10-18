ALTER TABLE `submission_users` ADD `emby_user_id` text;--> statement-breakpoint
ALTER TABLE `submission_users` ADD `emby_max_streams` integer;--> statement-breakpoint
CREATE TABLE `card_keys` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `code` text NOT NULL, `kind` text NOT NULL, `days` integer NOT NULL, `status` text DEFAULT 'unused' NOT NULL, `used_by_email` text, `used_at` text, `created_at` text NOT NULL, `updated_at` text NOT NULL, CHECK (`kind` IN ('trial', 'month', 'year', 'custom')), CHECK (`status` IN ('unused', 'used', 'copied')));--> statement-breakpoint
CREATE UNIQUE INDEX `card_keys_code_unique` ON `card_keys` (`code`);--> statement-breakpoint
CREATE TABLE `verification_codes` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `email` text NOT NULL, `code` text NOT NULL, `expires_at` text NOT NULL, `consumed` integer DEFAULT false NOT NULL, `created_at` text NOT NULL);
