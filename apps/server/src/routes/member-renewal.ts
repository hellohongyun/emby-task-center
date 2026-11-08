import type { Express } from "express";
import type { MemberRouteOptions } from "./members";
import { readId } from "./route-utils";
import { renewMember, renewalSchema } from "../subscriptions/admin-renewal";
import { embyAccessAllowed, syncMemberEmbyAccess } from "../subscriptions/emby-access";
import { getSubmissionUser } from "../subscriptions/membership";
import { deliverRenewalReceipt } from "../subscriptions/renewal-outbox";

export function registerMemberRenewal(app: Express, { database, emby, email }: MemberRouteOptions) {
  app.post("/api/submission-users/:id/renew", async (request, response) => {
    const id = readId(request.params.id);
    const parsed = renewalSchema.safeParse(request.body);
    if (!id || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    let result: ReturnType<typeof renewMember>;
    try {
      result = renewMember(database, id, parsed.data);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "renewal_failed";
      const known = error.startsWith("renewal_") || error === "user_not_found";
      return void response
        .status(error === "user_not_found" ? 404 : known ? 409 : 500)
        .json({ error: known ? error : "renewal_failed" });
    }
    // Replaying an already committed operation never repeats external side effects.
    let embyStatus = result.repeated ? "unchanged" : "not_configured";
    if (!result.repeated && result.user.embyUserId && emby?.configured) {
      if (!embyAccessAllowed(database, id)) embyStatus = "restricted";
      else embyStatus = (await syncMemberEmbyAccess(database, emby, id)) ? "restored" : "restore_failed";
    }
    const emailStatus = result.repeated
      ? "unchanged"
      : await deliverRenewalReceipt(database, email, `admin:${id}:${parsed.data.requestId}`);
    response.json({ user: getSubmissionUser(database, id), repeated: result.repeated, embyStatus, emailStatus });
  });
}
