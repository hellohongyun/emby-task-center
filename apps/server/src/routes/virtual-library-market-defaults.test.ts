import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers, virtualLibrarySubscriptions } from "@emby-task-center/database/schema";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { createVirtualLibraryMarketService } from "../virtual-libraries/market-service";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import { registerVirtualLibraryMarketRoutes } from "./virtual-library-market";

describe("partial market default settings", () => {
  let database: DatabaseHandle, server: Server, base: string, libraryId: string, cookie: string;
  let service: ReturnType<typeof createVirtualLibraryMarketService>;
  const headers = { "x-fixture-admin": "yes", "content-type": "application/json" };
  const patch = (value: unknown) =>
    fetch(`${base}/api/virtual-library-market/defaults`, { method: "PATCH", headers, body: JSON.stringify(value) });
  beforeEach(async () => {
    database = createDatabase(":memory:");
    const now = new Date().toISOString();
    database.db
      .insert(submissionUsers)
      .values({ email: "viewer@example.test", embyUserId: "viewer", createdAt: now, updatedAt: now })
      .run();
    libraryId = createVirtualLibraryStore(database.db).create({ name: "selected" }).id;
    service = createVirtualLibraryMarketService(database.db);
    service.publication({ adminId: "primary-admin" }, libraryId, true);
    service.saveDefaults({ libraryIds: [libraryId], adminEmbyUserId: "initial-admin" });
    const session = createPublicSessionManager("fixture", (email) => getSubmissionUserByEmail(database.db, email));
    cookie = session.issueCookie("viewer@example.test").split(";")[0];
    const app = express();
    app.use(express.json());
    registerVirtualLibraryMarketRoutes(app, { database: database.db, publicSession: session });
    app.use("/api/virtual-library-market", (req, res, next) =>
      req.headers["x-fixture-admin"] === "yes" ? next() : void res.status(401).end(),
    );
    registerVirtualLibraryMarketRoutes(app, { database: database.db });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });
  it("updates each form without replacing the other form's current value", async () => {
    expect(await (await patch({ adminEmbyUserId: "new-admin" })).json()).toEqual({
      libraryIds: [libraryId],
      adminEmbyUserId: "new-admin",
    });
    expect(await (await patch({ libraryIds: [] })).json()).toEqual({ libraryIds: [], adminEmbyUserId: "new-admin" });
    expect(await (await patch({ adminEmbyUserId: null })).json()).toEqual({ libraryIds: [], adminEmbyUserId: null });
  });
  it("retains stale off-shelf defaults when changing only the account binding", async () => {
    service.publication({ adminId: "primary-admin" }, libraryId, false);
    expect(await (await patch({ adminEmbyUserId: "new-admin" })).json()).toEqual({
      libraryIds: [libraryId],
      adminEmbyUserId: "new-admin",
    });
    service.initializeMember(getSubmissionUserByEmail(database.db, "viewer@example.test")!.id);
    expect(database.db.select().from(virtualLibrarySubscriptions).all()).toEqual([]);
    expect((await patch({ libraryIds: [libraryId] })).status).toBe(400);
    expect(service.readDefaults()).toEqual({ libraryIds: [libraryId], adminEmbyUserId: "new-admin" });
  });
  it.each([{}, { unknown: true }, { libraryIds: [], unknown: true }, { adminEmbyUserId: "" }])(
    "rejects empty, unknown or invalid patch %j",
    async (body) => {
      expect((await patch(body)).status).toBe(400);
      expect(service.readDefaults()).toEqual({ libraryIds: [libraryId], adminEmbyUserId: "initial-admin" });
    },
  );
  it("requires the existing administrator authentication and exposes no public PATCH", async () => {
    expect(
      (
        await fetch(`${base}/api/virtual-library-market/defaults`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ libraryIds: [] }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/public/virtual-library-market/defaults`, {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ libraryIds: [] }),
        })
      ).status,
    ).toBe(404);
  });
});
