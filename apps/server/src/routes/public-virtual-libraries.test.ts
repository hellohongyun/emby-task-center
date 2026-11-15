import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { eq } from "drizzle-orm";
import { registerPublicVirtualLibraryRoutes } from "./public-virtual-libraries";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import { createVirtualLibrarySource } from "../virtual-libraries/source";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { writeSettings } from "../settings/store";

describe("member private virtual libraries API", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  let cookie: (email: string) => string;
  const calls: string[] = [];
  beforeEach(async () => {
    database = createDatabase(":memory:");
    calls.length = 0;
    writeSettings(database.db, { "emby.baseUrl": "http://emby.test", "emby.apiKey": "secret" });
    for (const [email, embyUserId] of [
      ["alice@example.com", "alice"],
      ["bob@example.com", "bob"],
      ["unbound@example.com", null],
    ]) {
      database.db
        .insert(submissionUsers)
        .values({ email: email!, embyUserId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .run();
    }
    const session = createPublicSessionManager("secret", (email) => getSubmissionUserByEmail(database.db, email));
    cookie = (email) => session.issueCookie(email).split(";")[0]!;
    const app = express();
    app.use(express.json());
    registerPublicVirtualLibraryRoutes(app, {
      database: database.db,
      publicSession: session,
      sourceForUser: (userId) => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
          const url = new URL(String(input));
          calls.push(url.pathname);
          expect(url.pathname).toMatch(new RegExp("^/Users/" + userId + "/(Items|Views)$"));
          if (url.pathname.endsWith("Views")) return Response.json({ Items: [{ Id: "visible", Name: "允许的库" }] });
          const ids = url.searchParams.get("Ids");
          return Response.json({
            Items: !ids || ids === "allowed" ? [{ Id: "allowed", Name: "影片", Type: "Movie" }] : [],
            TotalRecordCount: !ids || ids === "allowed" ? 1 : 0,
          });
        });
        return createVirtualLibrarySource(database.db, fetcher, userId);
      },
    });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/public/virtual-libraries";
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });
  const request = (email: string, method = "GET", value?: unknown) => ({
    method,
    headers: { cookie: cookie(email), "content-type": "application/json" },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });

  it("allows owner management, separates common libraries, and rejects foreign IDs and spoofed owners", async () => {
    const common = createVirtualLibraryStore(database.db).create({ name: "公共" });
    expect((await fetch(base)).status).toBe(401);
    const unbound = await fetch(base, request("unbound@example.com"));
    expect(await unbound.json()).toMatchObject({ error: "emby_account_required" });
    const created = await fetch(base, request("alice@example.com", "POST", { name: "我的库", sortOrder: -2 }));
    expect(created.status).toBe(201);
    const { library } = (await created.json()) as { library: { id: string } };
    expect((await fetch(base, request("alice@example.com", "POST", { name: "伪造", ownerMemberId: 2 }))).status).toBe(
      400,
    );
    expect(await (await fetch(base, request("bob@example.com"))).json()).toEqual({ libraries: [] });
    for (const id of [library.id, common.id]) {
      for (const [suffix, method, payload] of [
        ["", "PATCH", { name: "越权" }],
        ["", "DELETE"],
        ["/items", "GET"],
        ["/items", "POST", { itemIds: ["allowed"] }],
        ["/poster", "GET"],
        ["/poster", "DELETE"],
        ["/items/allowed", "DELETE"],
      ] as const) {
        expect((await fetch(base + "/" + id + suffix, request("bob@example.com", method, payload))).status).toBe(404);
      }
    }
    expect(
      (await fetch(base + "/" + library.id + "/items", request("alice@example.com", "POST", { itemIds: ["allowed"] })))
        .status,
    ).toBe(200);
    expect(
      (
        await fetch(
          base + "/" + library.id + "/items",
          request("alice@example.com", "POST", { itemIds: ["restricted"] }),
        )
      ).status,
    ).toBe(400);
    expect((await fetch(base + "/source-libraries", request("alice@example.com"))).status).toBe(200);
    expect((await fetch(base + "/source-items", request("alice@example.com"))).status).toBe(200);
    expect(calls).toContain("/Users/alice/Views");
    expect(calls).toContain("/Users/alice/Items");
    const alice = getSubmissionUserByEmail(database.db, "alice@example.com")!;
    database.db.update(submissionUsers).set({ enabled: false }).where(eq(submissionUsers.id, alice.id)).run();
    expect(await (await fetch(base, request("alice@example.com"))).json()).toMatchObject({ error: "member_disabled" });
    expect(createVirtualLibraryStore(database.db).get(common.id)).toBeDefined();
  });
});
