CREATE TABLE `submission_settings` (
  `id` integer PRIMARY KEY NOT NULL,
  `release_block_days` integer DEFAULT 90 NOT NULL,
  `updated_at` text NOT NULL
);
