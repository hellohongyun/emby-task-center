import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPortalSession, usePortalSession } from "./usePortalSession";
import { renewalEmailNotice } from "./renewal-email-notice";

const profile = {
  email: "member@example.test",
  member: {
    status: "active",
    contentAccess: true,
    subscriptionExpiresAt: "2030-05-01T15:59:59.999Z",
    membershipExpiryLabel: "劳动节假期结束到期",
    embyUsername: null,
    embyUserId: null,
  },
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
beforeEach(resetPortalSession);
afterEach(() => vi.unstubAllGlobals());

describe("card renewal notification receipt", () => {
  it.each(["sent", "pending", "unchanged"])(
    "retains the %s email receipt through member refresh and clears it on logout",
    async (emailStatus) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url) =>
          String(url).endsWith("/activate") ? json({ ...profile, status: "activated", emailStatus }) : json(profile),
        ),
      );
      const session = usePortalSession();
      expect(await session.activate(profile.email, "123456", "TEST-CARD")).toBe(true);
      expect(session.renewalEmailStatus.value).toBe(emailStatus);
      expect(session.memberExpiryText.value).toBe("劳动节假期结束到期");
      const notice = renewalEmailNotice(session.renewalEmailStatus.value);
      if (emailStatus === "pending") {
        expect(notice).toContain("自动补发");
        expect(notice).not.toContain("邮件已发送");
      }
      if (emailStatus === "unchanged") expect(notice).toContain("未重复发送");
      await session.logout();
      expect(session.renewalEmailStatus.value).toBeNull();
    },
  );
});
