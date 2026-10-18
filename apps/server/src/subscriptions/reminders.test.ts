import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { eq } from "drizzle-orm";
import { addSubmissionUser, getSubmissionUser, updateSubmissionUser } from "./membership";
import { runMembershipReminders } from "./reminders";
import { setUserMailPref } from "./domain-utils";

describe("membership reminders", () => {
  it("reminds expiring/expired once each, persists state, and resets on renewal", async () => {
    const handle = createDatabase(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);
    const email = {
      configured: true,
      sendTest: async () => undefined,
      retryPending: async () => undefined,
      sendNotification: send,
    };

    const now = new Date();
    const expiring = new Date(now.getTime() + 1 * 86_400_000).toISOString(); // 1 天后到期 → 临期
    const user = addSubmissionUser(handle.db, { email: "member@example.com", subscriptionExpiresAt: expiring });

    // 第一次：进入临期 → 发送临期邮件并持久化状态
    expect(await runMembershipReminders(handle.db, email, now)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getSubmissionUser(handle.db, user.id)!.membershipReminderState).toBe("expiring");

    // 第二次同状态：不再发送
    expect(await runMembershipReminders(handle.db, email, new Date(now.getTime() + 60_000))).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);

    // 续费（延长到期 → 回到活跃）：清空提醒状态
    const future = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    updateSubmissionUser(handle.db, user.id, { subscriptionExpiresAt: future });
    await runMembershipReminders(handle.db, email, now);
    expect(getSubmissionUser(handle.db, user.id)!.membershipReminderState).toBeNull();

    // 再次到期（已过期）：发送到期邮件
    const expired = new Date(now.getTime() - 60_000).toISOString();
    updateSubmissionUser(handle.db, user.id, { subscriptionExpiresAt: expired });
    expect(await runMembershipReminders(handle.db, email, now)).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(getSubmissionUser(handle.db, user.id)!.membershipReminderState).toBe("expired");
    handle.close();
  });
});

describe("membership reminder delivery state", () => {
  const handles: ReturnType<typeof createDatabase>[] = [];
  const now = new Date("2026-10-03T00:00:00Z");
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.close();
  });

  function fixture() {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    const user = addSubmissionUser(handle.db, {
      email: "member@example.com",
      subscriptionExpiresAt: "2026-10-04T00:00:00Z",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const email = {
      configured: true,
      sendTest: async () => undefined,
      retryPending: async () => undefined,
      sendNotification: send,
    };
    return { db: handle.db, user, send, email };
  }

  it("keeps failed SMTP delivery unmarked and retries it on the next sweep", async () => {
    const { db, user, send, email } = fixture();
    send.mockRejectedValueOnce(new Error("smtp unavailable"));
    expect(await runMembershipReminders(db, email, now)).toBe(0);
    expect(getSubmissionUser(db, user.id)).toMatchObject({ membershipReminderState: null, membershipRemindedAt: null });
    expect(await runMembershipReminders(db, email, now)).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(getSubmissionUser(db, user.id)!.membershipReminderState).toBe("expiring");
  });

  it("does not mark a reminder when SMTP is not configured", async () => {
    const { db, user, send, email } = fixture();
    email.configured = false;
    expect(await runMembershipReminders(db, email, now)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(getSubmissionUser(db, user.id)!.membershipReminderState).toBeNull();
    email.configured = true;
    expect(await runMembershipReminders(db, email, now)).toBe(1);
  });

  it("continues reminding other members when one delivery fails", async () => {
    const { db, send, email } = fixture();
    const second = addSubmissionUser(db, {
      email: "second@example.com",
      subscriptionExpiresAt: "2026-10-04T00:00:00Z",
    });
    send.mockRejectedValueOnce(new Error("rejected recipient"));
    expect(await runMembershipReminders(db, email, now)).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(getSubmissionUser(db, second.id)!.membershipReminderState).toBe("expiring");
  });

  it("preserves the existing no-send processed semantics for opted-out members", async () => {
    const { db, user, send, email } = fixture();
    setUserMailPref(db, user.email, "membership_reminder", false);
    expect(await runMembershipReminders(db, email, now)).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(getSubmissionUser(db, user.id)!.membershipReminderState).toBe("expiring");
    expect(await runMembershipReminders(db, email, now)).toBe(0);
  });

  it("joins concurrent sweeps and marks delivery only after it resolves", async () => {
    const { db, user, send, email } = fixture();
    let complete!: () => void;
    send.mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const first = runMembershipReminders(db, email, now);
    const second = runMembershipReminders(db, email, now);
    expect(second).toBe(first);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getSubmissionUser(db, user.id)!.membershipReminderState).toBeNull();
    complete();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(getSubmissionUser(db, user.id)!.membershipReminderState).toBe("expiring");
  });

  it.each(["renewed", "disabled", "already marked"])(
    "does not write stale reminder state when the member is %s while sending",
    async (change) => {
      const { db, user, send, email } = fixture();
      let complete!: () => void;
      send.mockReturnValue(
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
      const running = runMembershipReminders(db, email, now);
      if (change === "renewed") updateSubmissionUser(db, user.id, { subscriptionExpiresAt: "2027-10-03T00:00:00Z" });
      else if (change === "disabled") updateSubmissionUser(db, user.id, { enabled: false });
      else {
        // Another writer can mark a different membership cycle while SMTP is in flight.
        db.update(submissionUsers)
          .set({ membershipReminderState: "expired" })
          .where(eq(submissionUsers.id, user.id))
          .run();
      }
      complete();
      expect(await running).toBe(0);
      expect(getSubmissionUser(db, user.id)!.membershipReminderState).toBe(
        change === "already marked" ? "expired" : null,
      );
    },
  );
});
