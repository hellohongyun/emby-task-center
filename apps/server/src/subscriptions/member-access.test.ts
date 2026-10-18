import { registerMemberRoutes } from "../routes/members";
import { registerEmbyUserRoutes } from "../routes/emby-users";
import { enforceConcurrencyEscalation } from "./concurrency-escalation";
import { saveConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers, cardKeys } from "@emby-task-center/database/schema";
import { requirePublicMember } from "./member-access";
import { createPublicSessionManager } from "./public-session";
import { createCardKeys } from "./cards";
import { issueVerificationCode } from "./verification";
import { registerPublicSubscriptionRoutes } from "../routes/public-subscriptions";
import { releaseFrozenMember, restoreConcurrencyUser } from "./concurrency-escalation";
import { syncMemberEmbyAccess } from "./emby-access";
import type { EmbyClient } from "../integrations/emby-client";

let db: DatabaseHandle;
let server: Server;
let base: string;
let embyWrites: boolean[];
let emby: EmbyClient;
const email = "policy@example.invalid";
const session = createPublicSessionManager("policy-secret");
const cookie = session.issueCookie(email);
const timestamp = new Date().toISOString();
beforeEach(async () => {
  db = createDatabase(":memory:");
  db.db
    .insert(submissionUsers)
    .values({ email, enabled: true, embyUserId: "u1", createdAt: timestamp, updatedAt: timestamp })
    .run();
  embyWrites = [];
  let disabled = true;
  emby = {
    configured: true,
    createUser: async () => ({ Id: "u2", Name: email }),
    setUserPassword: async () => undefined,
    deleteUser: async () => undefined,
    listUsers: async () => [{ Id: "u1", Name: email, Policy: { IsDisabled: disabled } }],
    listSessions: async () => [],
    updateUserPolicy: async (_id: string, policy: { IsDisabled?: boolean }) => {
      if (policy.IsDisabled !== undefined) {
        disabled = policy.IsDisabled;
        embyWrites.push(disabled);
      }
    },
  } as unknown as EmbyClient;
  const app = express();
  app.use(express.json());
  app.use(requirePublicMember(db.db, session));
  registerPublicSubscriptionRoutes(app, { database: db.db, publicSession: session, emby });
  registerEmbyUserRoutes(app, emby, db.db);
  registerMemberRoutes(app, { database: db.db, emby });
  app.use((req, res) => res.json({ path: req.path }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});
async function get(path: string) {
  return fetch(base + "/api/public/" + path, { headers: { cookie } });
}
function freeze() {
  db.db
    .insert(concurrencyEscalationState)
    .values({ memberId: 1, disabledUntil: "2099-01-01T00:00:00.000Z", updatedAt: timestamp })
    .run();
}

it("revalidates the same cookie after admin disable and deletion", async () => {
  expect((await get("library/list")).status).toBe(200);
  db.db.update(submissionUsers).set({ enabled: false }).run();
  for (const path of ["subscriptions/member", "tmdb/search", "pansou/search", "tgto/resources/search", "image"]) {
    const res = await get(path);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "member_disabled" });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  }
  db.db.delete(submissionUsers).run();
  expect(await (await get("subscriptions/member")).json()).toEqual({ error: "not_member" });
});
it("allows expired profile and renewal but blocks all content and password/unfreeze", async () => {
  db.db.update(submissionUsers).set({ subscriptionExpiresAt: "2020-01-01T00:00:00.000Z" }).run();
  freeze();
  expect((await get("subscriptions/member")).status).toBe(200);
  for (const path of [
    "trending",
    "library/recent",
    "tmdb/details",
    "image",
    "pansou/search",
    "tgto/resources/search",
    "subscriptions/member/emby/password",
    "subscriptions/member/unfreeze",
  ]) {
    const res = await get(path);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "membership_expired" });
  }
});
it("keeps frozen members' profile available including zero-countdown state", async () => {
  freeze();
  db.db.update(concurrencyEscalationState).set({ disabledUntil: "2020-01-01T00:00:00.000Z" }).run();
  expect((await get("subscriptions/member")).status).toBe(200);
  expect(await (await get("library/list")).json()).toEqual({ error: "member_frozen" });
});
it("rejects disabled login and new-card activation before consuming a card", async () => {
  db.db.update(submissionUsers).set({ enabled: false }).run();
  const cardCode = createCardKeys(db.db, { kind: "month", count: 1 })[0]!;
  const code = issueVerificationCode(db.db, email);
  for (const path of ["login", "activate"]) {
    const res = await fetch(base + "/api/public/subscriptions/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code, ...(path === "activate" ? { cardCode } : {}) }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  }
  expect(db.db.select().from(cardKeys).get()!.usedByEmail).toBeNull();
});
it("renewal extends expiry while retaining concurrency freeze", async () => {
  freeze();
  db.db.update(submissionUsers).set({ subscriptionExpiresAt: "2020-01-01T00:00:00.000Z" }).run();
  const cardCode = createCardKeys(db.db, { kind: "month", count: 1 })[0]!;
  const code = issueVerificationCode(db.db, email);
  const res = await fetch(base + "/api/public/subscriptions/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code, cardCode }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).member.contentAccess).toBe(false);
  expect(Date.parse(db.db.select().from(submissionUsers).get()!.subscriptionExpiresAt!)).toBeGreaterThan(Date.now());
  expect(db.db.select().from(concurrencyEscalationState).get()!.disabledUntil).toBeTruthy();
  expect(embyWrites).not.toContain(false);
});
it("self/admin release cannot enable expired or disabled members", async () => {
  freeze();
  const member = db.db.select().from(submissionUsers).get()!;
  for (const values of [{ enabled: false }, { enabled: true, subscriptionExpiresAt: "2020-01-01T00:00:00.000Z" }]) {
    db.db.update(submissionUsers).set(values).run();
    expect(await releaseFrozenMember(db.db, undefined, member)).toBe(false);
    await expect(restoreConcurrencyUser(db.db, undefined, member)).rejects.toThrow("member_restore_blocked");
    expect(db.db.select().from(concurrencyEscalationState).get()!.disabledUntil).toBeTruthy();
  }
});
it.each(["disable", "rebind"])("corrects remote enable if admin changes %s while awaiting Emby", async (action) => {
  let disabled = true;
  let changed = false;
  const emby = {
    configured: true,
    createUser: async () => ({ Id: "u2", Name: email }),
    setUserPassword: async () => undefined,
    deleteUser: async () => undefined,
    listUsers: async () => [{ Id: "u1", Name: email, Policy: { IsDisabled: disabled } }],
    updateUserPolicy: async (_id: string, policy: { IsDisabled?: boolean }) => {
      if (policy.IsDisabled !== undefined) {
        disabled = policy.IsDisabled;
        if (!disabled && !changed) {
          changed = true;
          db.db
            .update(submissionUsers)
            .set(action === "disable" ? { enabled: false } : { embyUserId: "u2" })
            .run();
        }
      }
    },
  } as unknown as EmbyClient;
  expect(await syncMemberEmbyAccess(db.db, emby, 1)).toBe(false);
  expect(disabled).toBe(true);
  expect(changed).toBe(true);
});

it("raw Emby enable and policy cannot bypass member state", async () => {
  freeze();
  for (const suffix of ["enable", "policy"]) {
    const res = await fetch(base + "/api/emby/users/u1/" + suffix, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IsDisabled: false }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "member_restore_blocked" });
  }
  expect(embyWrites).not.toContain(false);
});
it("automatic freeze expiry does not restore an expired member", async () => {
  freeze();
  db.db.update(concurrencyEscalationState).set({ disabledUntil: "2020-01-01T00:00:00.000Z" }).run();
  db.db.update(submissionUsers).set({ subscriptionExpiresAt: "2020-01-01T00:00:00.000Z", embyMaxStreams: 1 }).run();
  saveConcurrencyPolicy(db.db, {
    enabled: true,
    defaultStreamLimit: 1,
    remindAfterMinutes: 1,
    disableAfterMinutes: 2,
    disableForHours: 1,
  });
  const outcome = await enforceConcurrencyEscalation(db.db, emby, undefined);
  expect(outcome.released).toEqual([]);
  expect(embyWrites).not.toContain(false);
  expect(db.db.select().from(concurrencyEscalationState).get()!.disabledUntil).toBeTruthy();
});

it("admin expiry extension alone preserves disabled Emby until explicit restore", async () => {
  db.db.update(submissionUsers).set({ subscriptionExpiresAt: "2020-01-01T00:00:00.000Z" }).run();
  const res = await fetch(base + "/api/submission-users/1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscriptionExpiresAt: "2099-01-01T00:00:00.000Z" }),
  });
  expect(res.status).toBe(200);
  expect(embyWrites).not.toContain(false);
});
it("admin expiry change keeps a frozen account disabled", async () => {
  freeze();
  const res = await fetch(base + "/api/submission-users/1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscriptionExpiresAt: "2099-01-01T00:00:00.000Z" }),
  });
  expect(res.status).toBe(200);
  expect(embyWrites).toContain(true);
  expect(embyWrites).not.toContain(false);
});

it.each([
  { IsDisabled: 0 },
  { IsDisabled: null },
  { IsDisabled: "false" },
  { isDisabled: false },
  { ISDISABLED: false },
])("rejects ambiguous disabled policy %j before touching Emby", async (body) => {
  freeze();
  const res = await fetch(base + "/api/emby/users/u1/policy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid_request" });
  expect(embyWrites).toEqual([]);
});
