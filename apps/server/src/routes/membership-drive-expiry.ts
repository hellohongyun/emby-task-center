import type { Express } from "express";
import { z } from "zod";
import { getDriveExpiry, setDriveExpiry } from "../subscriptions/drive-expiry";
import { countPendingDriveExpirySync, syncDriveExpiryEmbyAccess } from "../subscriptions/drive-expiry-emby-sync";
import type { MemberRouteOptions } from "./members";

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const schema = z.strictObject({ date: dateField, expectedDate: dateField.nullable() });

export function registerMembershipDriveExpiry(app: Express, { database, emby }: MemberRouteOptions): void {
  app.get("/api/membership-drive-expiry", (_request, response) => {
    response.json({ limit: getDriveExpiry(database) });
  });

  app.put("/api/membership-drive-expiry", (request, response) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const { date, expectedDate } = parsed.data;
    let result: ReturnType<typeof setDriveExpiry>;
    try {
      result = database.transaction(
        (tx) => {
          const current = getDriveExpiry(tx)?.date ?? null;
          if (date !== current && expectedDate !== current) throw new Error("drive_expiry_changed");
          return setDriveExpiry(tx, date);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason === "drive_expiry_changed" || reason === "member_cleanup_pending")
        return void response.status(409).json({ error: reason });
      if (reason === "invalid_drive_expiry_date")
        return void response.status(400).json({ error: "invalid_drive_expiry" });
      throw error;
    }
    const syncPending = countPendingDriveExpirySync(database);
    if (syncPending) void syncDriveExpiryEmbyAccess(database, emby).catch(() => undefined);
    response.json({
      limit: result.limit,
      changedMembers: result.changedMemberIds.length,
      releasedMembers: result.releasedMembers,
      syncPending,
    });
  });
}
