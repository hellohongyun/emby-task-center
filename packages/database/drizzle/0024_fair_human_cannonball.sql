-- 把旧的单值 release_weekday 折叠进多选 release_days，随后删除冗余列。
UPDATE `task_automation_settings`
  SET `release_days` = json_array(`release_weekday`)
  WHERE json_array_length(`release_days`) = 0
    AND `release_weekday` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `task_automation_settings` DROP COLUMN `release_weekday`;
