import type { AppDatabase } from "@emby-task-center/database/client";
import { readSetting } from "./store";

/** Read every time: toggling the mode must reach background workers immediately. */
export function isDevelopmentMode(database: AppDatabase): boolean {
  return readSetting(database, "development.enabled");
}
