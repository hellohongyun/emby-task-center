import type { AppDatabase } from "@emby-task-center/database/client";

import { readSettings } from "./store";

export function readGroupRegistrationSettings(database: AppDatabase) {
  const { values } = readSettings(database);
  return {
    enabled: values["member.groupInviteEnabled"],
    groupNumber: values["member.groupNumber"],
    inviteCode: values["member.groupInviteCode"],
  };
}
