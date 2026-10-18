ALTER TABLE `movie_submissions` ADD `task_type` text;--> statement-breakpoint
ALTER TABLE `movie_submissions` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `submission_users` ADD `process_per_day` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `submission_users` ADD `process_first_batch` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `submission_users` ADD `process_used_today` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `submission_users` ADD `process_last_date` text;--> statement-breakpoint
ALTER TABLE `submission_users` ADD `process_first_batch_used` integer DEFAULT false NOT NULL;
