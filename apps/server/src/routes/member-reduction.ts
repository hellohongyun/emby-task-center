import { and, eq } from "drizzle-orm";
import type { Express } from "express";
import { submissionUsers } from "@emby-task-center/database/schema";
import { reduceMemberDays, reductionSchema } from "../subscriptions/admin-reduction";
import { embyAccessAllowed, syncMemberEmbyAccessState } from "../subscriptions/emby-access";
import { getSubmissionUser } from "../subscriptions/membership";
import { deliverRenewalReceipt } from "../subscriptions/renewal-outbox";
import type { MemberRouteOptions } from "./members";
import { readId } from "./route-utils";

export function registerMemberReduction(app: Express, { database, emby, email }: MemberRouteOptions) {
  app.post("/api/submission-users/:id/reduce-days", async (request, response) => {
    const id = readId(request.params.id);
    const parsed = reductionSchema.safeParse(request.body);
    if (!id || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    let result: ReturnType<typeof reduceMemberDays>;
    try {
      result = reduceMemberDays(database, id, parsed.data);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "reduction_failed";
      const known = error.startsWith("reduction_") || error === "user_not_found";
      return void response
        .status(error === "user_not_found" ? 404 : known ? 409 : 500)
        .json({ error: known ? error : "reduction_failed" });
    }
    let embyStatus = "unchanged";
    const { user } = result;
    if (!result.repeated && user.embyUserId && user.driveExpirySyncPending) {
      embyStatus = "not_configured";
      if (emby?.configured) {
        const state = await syncMemberEmbyAccessState(database, emby, id);
        const current = getSubmissionUser(database, id);
        const confirmed =
          state !== "unconfirmed" &&
          (state === "enabled") === embyAccessAllowed(database, id) &&
          current?.embyUserId === user.embyUserId &&
          current?.subscriptionExpiresAt === user.subscriptionExpiresAt;
        embyStatus = confirmed ? "synced" : "sync_failed";
        if (confirmed)
          database
            .update(submissionUsers)
            .set({ driveExpirySyncPending: false })
            .where(
              and(
                eq(submissionUsers.id, id),
                eq(submissionUsers.embyUserId, user.embyUserId),
                eq(submissionUsers.subscriptionExpiresAt, user.subscriptionExpiresAt!),
              ),
            )
            .run();
        else
          // Another renewal/retry can clear the flag while this older remote write
          // is still in flight. Requeue the current binding after any uncertain
          // result so a late disable cannot leave renewed membership inaccessible.
          database
            .update(submissionUsers)
            .set({ driveExpirySyncPending: true })
            .where(and(eq(submissionUsers.id, id), eq(submissionUsers.embyUserId, user.embyUserId)))
            .run();
      }
    }
    const emailStatus = result.repeated ? "unchanged" : await deliverRenewalReceipt(database, email, result.receiptKey);
    response.json({ user: getSubmissionUser(database, id), repeated: result.repeated, embyStatus, emailStatus });
  });
}
