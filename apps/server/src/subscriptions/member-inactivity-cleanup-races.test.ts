import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { auditLogs, memberExpiryCleanupJobs, submissionUsers } from "@emby-task-center/database/schema";
import { createEmbyClient, type EmbyClient } from "../integrations/emby-client";
import { writeSettings } from "../settings/store";
import { saveCleanupPolicy } from "./member-expiry-cleanup-plan";
import { sweepMemberExpiryCleanup } from "./member-expiry-cleanup";
import { sweepMemberInactivityCleanup } from "./member-inactivity-cleanup";

const accountId = "shared-user";
const serverId = "primary";
const now = new Date("2028-05-01T00:00:00.000Z");
const old = "2028-03-01T00:00:00.000Z";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("inactivity cleanup across Emby HTTP and shared SQLite leases", () => {
  let database: DatabaseHandle;
  let upstream: Server;
  let emby: EmbyClient;
  let baseUrl: string;
  let configuredUrl: string;
  let upstreamId: string;
  let administrator: boolean;
  let accountExists: boolean;
  let deleteRequests: string[];
  let deleteStatus: number;
  let onReadSessions: () => void;
  let onReadRole: () => void;
  let onDelete: () => Promise<void>;

  beforeEach(async () => {
    database = createDatabase(":memory:");
    writeSettings(database.db, { "emby.enabled": true });
    database.db
      .insert(submissionUsers)
      .values({
        email: "member@example.test",
        embyUserId: accountId,
        createdAt: old,
        updatedAt: old,
        subscriptionExpiresAt: old,
      })
      .run();
    saveCleanupPolicy(database.db, 15, serverId, "inactivity");
    upstreamId = serverId;
    administrator = false;
    accountExists = true;
    deleteRequests = [];
    deleteStatus = 204;
    onReadSessions = () => {};
    onReadRole = () => {};
    onDelete = async () => {};

    upstream = createServer(async (request, response) => {
      if (request.headers["x-emby-token"] !== "loopback-race-key") return void response.writeHead(401).end();
      const requestedPath = new URL(request.url!, "http://127.0.0.1").pathname;
      const replacement = requestedPath.startsWith("/replacement/");
      const pathname = replacement ? requestedPath.slice("/replacement".length) : requestedPath;
      const id = replacement ? "replacement" : upstreamId;
      const exists = replacement || accountExists;
      const user = { Id: accountId, Name: "member", Policy: { IsAdministrator: administrator } };
      const json = (value: unknown) => response.end(JSON.stringify(value));
      if (pathname === "/emby/System/Info") return void json({ Id: id });
      if (pathname === "/emby/Users/Query") {
        return void json({ Items: exists ? [user] : [], TotalRecordCount: exists ? 1 : 0 });
      }
      if (pathname === "/emby/Sessions") {
        onReadSessions();
        return void json([]);
      }
      const userPath = `/emby/Users/${accountId}`;
      if (pathname === `${userPath}/Items` && exists) {
        return void json({ Items: [{ Id: "1", UserData: { LastPlayedDate: old } }], TotalRecordCount: 1 });
      }
      if (pathname !== userPath) return void response.writeHead(404).end();
      if (request.method === "GET") onReadRole();
      if (!exists) return void response.writeHead(404).end();
      if (request.method === "DELETE") {
        deleteRequests.push(id);
        await onDelete();
        accountExists = false;
        return void response.writeHead(deleteStatus).end();
      }
      json(user);
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => upstream.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    configuredUrl = baseUrl;
    emby = createEmbyClient({
      resolve: () => ({ baseUrl: configuredUrl, apiKey: "loopback-race-key" }),
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    database.close();
  });

  const member = () => database.db.select().from(submissionUsers).get();
  const job = () => database.db.select().from(memberExpiryCleanupJobs).get();

  it("shares the pending DELETE claim between inactivity and expiry sweeps", async () => {
    saveCleanupPolicy(database.db, 7, serverId, "expiry");
    const entered = deferred();
    const release = deferred();
    onDelete = async () => {
      entered.resolve();
      await release.promise;
    };

    const inactive = sweepMemberInactivityCleanup(database.db, emby, now);
    try {
      await Promise.race([entered.promise, inactive]);
      expect(job()?.kind).toBe("inactivity");
      expect(member()?.embyUserId).toBe(accountId);
      expect(await sweepMemberExpiryCleanup(database.db, emby, now)).toEqual({ deleted: 0, pending: 0, skipped: 0 });
      expect(deleteRequests).toEqual([serverId]);
    } finally {
      release.resolve();
      await inactive;
    }
    expect((await inactive).deleted).toBe(1);
    expect(member()).toBeUndefined();
    expect(job()).toBeUndefined();
    const deletions = database.db
      .select()
      .from(auditLogs)
      .all()
      .filter(({ action }) => action.endsWith("_cleanup_deleted"));
    expect(deletions.map(({ action }) => action)).toEqual(["member.inactivity_cleanup_deleted"]);
  });

  it("blocks deletion if Emby promotes the account while playback is being checked", async () => {
    onReadSessions = () => {
      if (job()) administrator = true;
    };

    expect((await sweepMemberInactivityCleanup(database.db, emby, now)).deleted).toBe(0);
    expect(administrator).toBe(true);
    expect(accountExists).toBe(true);
    expect(deleteRequests).toEqual([]);
    expect(member()?.embyUserId).toBe(accountId);
    expect(job()).toBeUndefined();
  });

  it.each(["playback", "role"])(
    "blocks deletion if the same Emby URL switches servers during the final %s check",
    async (check) => {
      if (check === "playback") {
        onReadSessions = () => {
          if (job()) upstreamId = "replacement";
        };
      } else {
        let roleChecks = 0;
        onReadRole = () => {
          if (job() && ++roleChecks === 2) upstreamId = "replacement";
        };
      }

      expect((await sweepMemberInactivityCleanup(database.db, emby, now)).deleted).toBe(0);
      expect(upstreamId).toBe("replacement");
      expect(deleteRequests).toEqual([]);
      expect(accountExists).toBe(true);
      expect(member()?.embyUserId).toBe(accountId);
      expect(job()).toBeUndefined();
    },
  );

  it.each(["fresh", "resumed"])(
    "retains the local member if the configured connection changes during %s absence confirmation",
    async (attempt) => {
      const expireLease = () =>
        database.db
          .update(memberExpiryCleanupJobs)
          .set({ leaseUntil: Date.now() - 1 })
          .run();
      if (attempt === "resumed") {
        deleteStatus = 503;
        expect((await sweepMemberInactivityCleanup(database.db, emby, now)).pending).toBe(1);
        expireLease();
      }
      onReadRole = () => {
        if (!accountExists) configuredUrl = `${baseUrl}/replacement`;
      };

      expect((await sweepMemberInactivityCleanup(database.db, emby, now)).pending).toBe(1);
      expect(await emby.openMemberCleanupSession?.()?.readRole(accountId)).toBe("ordinary");
      expect(member()?.embyUserId).toBe(accountId);
      expect(job()?.serverId).toBe(serverId);
      expect(deleteRequests).toEqual([serverId]);

      onReadRole = () => {};
      configuredUrl = baseUrl;
      expireLease();
      expect((await sweepMemberInactivityCleanup(database.db, emby, now)).deleted).toBe(1);
      expect(member()).toBeUndefined();
      expect(job()).toBeUndefined();
      expect(deleteRequests).toEqual([serverId]);
    },
  );

  it("preserves a pending claim if the connection changes while the old account is still present", async () => {
    const memberId = member()!.id;
    database.db
      .insert(memberExpiryCleanupJobs)
      .values({
        memberId,
        serverId,
        embyUserId: accountId,
        kind: "inactivity",
        leaseToken: "previous-attempt",
        leaseUntil: Date.now() - 1,
      })
      .run();
    onReadRole = () => {
      configuredUrl = `${baseUrl}/replacement`;
    };

    expect((await sweepMemberInactivityCleanup(database.db, emby, now)).pending).toBe(1);
    expect(member()?.id).toBe(memberId);
    expect(job()?.serverId).toBe(serverId);
    expect(deleteRequests).toEqual([]);
  });

  it("leaves the claim for the next startup when stopping during absence confirmation", async () => {
    let running = true;
    onReadRole = () => {
      if (!accountExists) running = false;
    };
    expect((await sweepMemberInactivityCleanup(database.db, emby, now, () => running)).pending).toBe(1);
    expect(running).toBe(false);
    expect(member()?.embyUserId).toBe(accountId);
    expect(job()?.serverId).toBe(serverId);

    database.db
      .update(memberExpiryCleanupJobs)
      .set({ leaseUntil: Date.now() - 1 })
      .run();
    expect((await sweepMemberInactivityCleanup(database.db, emby, now)).deleted).toBe(1);
    expect(member()).toBeUndefined();
    expect(deleteRequests).toEqual([serverId]);
  });
});
