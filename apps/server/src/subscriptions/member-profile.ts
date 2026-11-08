import type { submissionUsers } from "@emby-task-center/database/schema";
import { z } from "zod";

export const qqNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9]+$/);
export const joinSourceSchema = z.string().trim().max(120);

export const memberProfileSchema = z.strictObject({
  qqNumber: qqNumberSchema.nullable(),
  joinSource: joinSourceSchema.nullable(),
});

export function qqAvatarUrl(qqNumber: string): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qqNumber)}&s=100`;
}

export function toMemberProfile(
  member: Pick<typeof submissionUsers.$inferSelect, "qqNumber" | "joinSource" | "qqAvatarSyncStatus">,
) {
  return {
    qqNumber: member.qqNumber,
    joinSource: member.joinSource,
    avatarUrl: member.qqNumber && member.qqAvatarSyncStatus !== "unavailable" ? qqAvatarUrl(member.qqNumber) : null,
    avatarSyncStatus: member.qqNumber ? (member.qqAvatarSyncStatus ?? "pending") : null,
  };
}
