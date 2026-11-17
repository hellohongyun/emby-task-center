import type { AppDatabase } from "@emby-task-center/database/client";

import { readSettings } from "./store";

export function readGroupRegistrationSettings(database: AppDatabase) {
  const { values } = readSettings(database);
  return {
    enabled: values["member.groupInviteEnabled"],
    groupNumber: values["member.groupNumber"],
    inviteCode: values["member.groupInviteCode"],
    noticeEnabled: values["member.groupInviteNoticeEnabled"],
    notice: values["member.groupInviteNotice"],
  };
}

export function publicGroupRegistrationInvitation(invitation: ReturnType<typeof readGroupRegistrationSettings>) {
  if (!invitation.enabled) return null;
  return {
    groupNumber: invitation.groupNumber,
    notice: invitation.noticeEnabled ? invitation.notice.replaceAll("{groupNumber}", invitation.groupNumber) : null,
  };
}
