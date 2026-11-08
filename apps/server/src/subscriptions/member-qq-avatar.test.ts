import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { createEmbyClient } from "../integrations/emby-client";
import { addSubmissionUser, getSubmissionUser } from "./membership";
import { syncMemberQqAvatar, updateMemberProfile } from "./member-qq-avatar";
import { startQqAvatarRefresh } from "./qq-avatar-refresh";

const newAvatar = Buffer.from("ffd8ff0affd9", "hex");
const secondAvatar = Buffer.from("ffd8ff0bffd9", "hex");
const existingAvatar = Buffer.from("ffd8ff0cffd9", "hex");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("member QQ avatar sync", () => {
  let database: DatabaseHandle;
  let memberId: number;

  beforeEach(() => {
    database = createDatabase(":memory:");
    memberId = addSubmissionUser(database.db, { email: "legacy@example.com" }).id;
    database.db.update(submissionUsers).set({ embyUserId: "member-id" }).where(eq(submissionUsers.id, memberId)).run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
  });

  function upstream(
    initialImage: Buffer | null,
    options: { rejectUpload?: boolean; afterUpload?: () => Promise<void> } = {},
  ) {
    let image = initialImage;
    let tag = image ? "custom" : null;
    let qqOverride: Buffer | undefined;
    const uploads: Buffer[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        const url = new URL(input);
        if (url.hostname === "q1.qlogo.cn") {
          const qq = url.searchParams.get("nk");
          const body = qqOverride ?? (qq === "00123456" ? newAvatar : secondAvatar);
          return new Response(new Uint8Array(body), { headers: { "content-type": "image/jpeg" } });
        }
        expect(new Headers(init?.headers).get("X-Emby-Token")).toBe("local-key");
        if (url.pathname === "/emby/Users/member-id") return Response.json({ Id: "member-id", PrimaryImageTag: tag });
        expect(url.pathname).toBe("/emby/Users/member-id/Images/Primary");
        if (init?.method === "POST") {
          expect(new Headers(init.headers).get("Content-Type")).toBe("image/jpeg");
          uploads.push(Buffer.from(String(init.body), "base64"));
          if (options.rejectUpload) return new Response(null, { status: 403 });
          image = uploads.at(-1) ?? null;
          tag = `uploaded-${uploads.length}`;
          await options.afterUpload?.();
          return new Response(null, { status: 200 });
        }
        expect(url.searchParams.get("tag")).toBe(tag);
        return new Response(image && new Uint8Array(image), { headers: { "content-type": "image/jpeg" } });
      }),
    );
    return {
      emby: createEmbyClient({ baseUrl: "http://emby.local", apiKey: "local-key" }),
      uploads,
      setQqAvatar(value: Buffer) {
        qqOverride = value;
      },
      setCustomAvatar() {
        image = existingAvatar;
        tag = "custom";
      },
    };
  }

  it("preserves a custom Emby avatar until explicitly replaced, then tracks the uploaded image", async () => {
    const { emby, uploads } = upstream(existingAvatar);
    const profile = await updateMemberProfile(database.db, emby, memberId, {
      qqNumber: "00123456",
      joinSource: "群公告",
    });
    expect(profile).toMatchObject({ qqNumber: "00123456", joinSource: "群公告", avatarSyncStatus: "preserved" });
    expect(uploads).toEqual([]);

    await syncMemberQqAvatar(database.db, emby, memberId, { replace: true });
    expect(getSubmissionUser(database.db, memberId)).toMatchObject({
      qqAvatarSyncStatus: "synced",
      qqAvatarSyncedTag: "uploaded-1",
      qqAvatarSyncedEmbyUserId: "member-id",
    });

    expect(
      await updateMemberProfile(database.db, emby, memberId, { qqNumber: "987654321", joinSource: null }),
    ).toMatchObject({
      avatarSyncStatus: "synced",
    });
    expect(uploads).toEqual([newAvatar, secondAvatar]);
  });

  it("saves member details even when Emby refuses the avatar upload", async () => {
    const { emby } = upstream(null, { rejectUpload: true });
    expect(
      await updateMemberProfile(database.db, emby, memberId, { qqNumber: "00123456", joinSource: "" }),
    ).toMatchObject({
      avatarSyncStatus: "failed",
      qqNumber: "00123456",
      joinSource: null,
    });
    expect(getSubmissionUser(database.db, memberId)?.email).toBe("legacy@example.com");
  });

  it("applies concurrent profile writes and avatar uploads in the same order", async () => {
    const { emby, uploads } = upstream(null);
    await Promise.all([
      updateMemberProfile(database.db, emby, memberId, { qqNumber: "00123456", joinSource: null }),
      updateMemberProfile(database.db, emby, memberId, { qqNumber: "987654321", joinSource: null }),
    ]);
    expect(uploads).toEqual([newAvatar, secondAvatar]);
    expect(getSubmissionUser(database.db, memberId)).toMatchObject({
      qqNumber: "987654321",
      qqAvatarSyncedTag: "uploaded-2",
    });
  });

  it("checks hourly for a new image under the same QQ, uploads only changes and preserves later custom avatars", async () => {
    const { emby, uploads, setQqAvatar, setCustomAvatar } = upstream(null);
    await updateMemberProfile(database.db, emby, memberId, { qqNumber: "00123456", joinSource: null });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.useFakeTimers();
    const refresh = startQqAvatarRefresh({ database: database.db, emby, logger });
    try {
      await vi.advanceTimersByTimeAsync(3_599_999);
      expect(logger.info).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(uploads).toEqual([newAvatar]);
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ event: "avatar_refresh_finished", detail: expect.stringContaining('"unchanged":1') }),
      );

      setQqAvatar(secondAvatar);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(uploads).toEqual([newAvatar, secondAvatar]);
      const update = logger.info.mock.calls.map(([event]) => event).find((event) => event.event === "avatar_updated");
      expect(update).toMatchObject({
        module: "qq-avatar",
        runId: expect.any(String),
        detail: JSON.stringify({ memberId }),
      });

      setCustomAvatar();
      await refresh.run();
      expect(uploads).toEqual([newAvatar, secondAvatar]);
      expect(getSubmissionUser(database.db, memberId)?.qqAvatarSyncStatus).toBe("preserved");
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain("00123456");
    } finally {
      await refresh.close();
      vi.useRealTimers();
    }
  });

  it("finishes Emby readback when shutdown follows a scheduled upload already accepted by Emby", async () => {
    const options: { afterUpload?: () => Promise<void> } = {};
    const { emby, uploads, setQqAvatar } = upstream(null, options);
    await updateMemberProfile(database.db, emby, memberId, { qqNumber: "00123456", joinSource: null });
    setQqAvatar(secondAvatar);
    const accepted = deferred();
    const release = deferred();
    options.afterUpload = () => {
      accepted.resolve();
      return release.promise;
    };
    const refresh = startQqAvatarRefresh({
      database: database.db,
      emby,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    try {
      void refresh.run();
      await accepted.promise;
      const closing = refresh.close();
      release.resolve();
      await closing;
      expect(uploads).toEqual([newAvatar, secondAvatar]);
      expect(getSubmissionUser(database.db, memberId)).toMatchObject({
        qqAvatarSyncStatus: "synced",
        qqAvatarSyncedTag: "uploaded-2",
      });
    } finally {
      release.resolve();
      await refresh.close();
    }
  });
});
