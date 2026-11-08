import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  auditLogs,
  concurrencyEscalationState,
  mediaRequests,
  submissionUsers,
} from "@emby-task-center/database/schema";
import { createPublicSessionManager } from "../subscriptions/public-session";
import type { TmdbClient, TmdbMedia } from "../tmdb/client";
import { registerAdminMediaRequestRoutes, registerPublicMediaRequestRoutes } from "./media-requests";

describe("member media requests over real HTTP", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  let first: number;
  const session = createPublicSessionManager("media-request-test-only-secret");
  const details = vi.fn<TmdbClient["details"]>();
  const input = { kind: "request", mediaType: "tv", tmdbId: 10, seasonNumber: 2, description: "第二季" };
  const metadata: TmdbMedia = {
    id: 10,
    mediaType: "tv",
    title: "正确剧名",
    originalTitle: "Original",
    releaseYear: 2020,
    overview: "",
    posterUrl: null,
    backdropUrl: null,
    seasons: [
      { seasonNumber: 0, name: "特别篇", episodeCount: 1, airDate: null },
      { seasonNumber: 2, name: "第二季", episodeCount: 13, airDate: null },
    ],
  };
  function user(email: string) {
    return database.db
      .insert(submissionUsers)
      .values({ email, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .returning()
      .get();
  }
  function request(path = "", method = "GET", value?: unknown, email = "one@example.com", admin = false) {
    return fetch(`${base}${admin ? "/api/media-requests" : "/api/public/media-requests"}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(email ? { cookie: session.issueCookie(email).split(";")[0]! } : {}),
        ...(admin ? { "x-test-admin": "yes" } : {}),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  }
  async function create(value: unknown = input, email?: string) {
    const response = await request("", "POST", value, email);
    return { response, body: await response.json() };
  }
  beforeEach(async () => {
    database = createDatabase(":memory:");
    first = user("one@example.com").id;
    user("two@example.com");
    details.mockReset().mockResolvedValue(metadata);
    const app = express();
    app.use(express.json());
    registerPublicMediaRequestRoutes(app, {
      database: database.db,
      publicSession: session,
      tmdb: { details } as unknown as TmdbClient,
    });
    app.use("/api", (req, res, next) => (req.headers["x-test-admin"] === "yes" ? next() : void res.sendStatus(401)));
    registerAdminMediaRequestRoutes(app, { database: database.db });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });

  it("stores authoritative identity and seasons, returns original active request on retry, and isolates members", async () => {
    const created = await create();
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      duplicate: false,
      request: { title: "正确剧名", tmdbId: 10, seasonNumber: 2, status: "pending" },
    });
    expect(created.body.request).not.toHaveProperty("memberEmail");
    expect(created.body.request).not.toHaveProperty("memberId");
    const duplicate = await create({ ...input, kind: "supplement", description: "缺第4集" });
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body).toMatchObject({
      duplicate: true,
      request: { id: created.body.request.id, description: "第二季" },
    });
    expect(details).toHaveBeenCalledTimes(1);
    const second = await create(input, "two@example.com");
    expect(second.response.status).toBe(201);
    const own = await (await request("?memberId=2&email=two@example.com")).json();
    expect(own.total).toBe(1);
    expect(own.items[0].id).toBe(created.body.request.id);
    expect((await (await request("?q=Original")).json()).total).toBe(1);
    expect((await (await request("?q=不存在的片名")).json()).total).toBe(0);
    const forbidden = await request(`/${second.body.request.id}`, "PATCH", {
      description: "attack",
      updatedAt: second.body.request.updatedAt,
    });
    expect(forbidden.status).toBe(404);
    const all = await (await request("", "GET", undefined, undefined, true)).json();
    expect(all.items.map((row: { memberEmail: string }) => row.memberEmail).sort()).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
  });

  it("requires actual season, validates supplement description and rejects forged metadata", async () => {
    for (const value of [
      { ...input, seasonNumber: null },
      { ...input, seasonNumber: 1 },
      { ...input, kind: "supplement", description: " " },
      { ...input, title: "伪造片名" },
      { ...input, mediaType: "movie" },
      { ...input, tmdbId: -1 },
    ])
      expect((await create(value)).response.status).toBe(400);
    expect((await create({ ...input, seasonNumber: 0 })).response.status).toBe(201);
    details.mockResolvedValue({ ...metadata, mediaType: "movie" });
    const movie = await create({ kind: "request", mediaType: "movie", tmdbId: 10 });
    expect(movie.response.status).toBe(201);
    expect(movie.body.request.seasonNumber).toBeNull();
    expect((await request("?pageSize=101")).status).toBe(400);
  });

  it("guards public access and rechecks member status after the TMDB wait", async () => {
    expect((await request("", "GET", undefined, "")).status).toBe(401);
    expect(
      (await fetch(`${base}/api/media-requests`, { headers: { cookie: session.issueCookie("one@example.com") } }))
        .status,
    ).toBe(401);
    database.db.update(submissionUsers).set({ enabled: false }).where(eq(submissionUsers.id, first)).run();
    expect((await create()).response.status).toBe(403);
    database.db
      .update(submissionUsers)
      .set({ enabled: true, subscriptionExpiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(submissionUsers.id, first))
      .run();
    expect((await request()).status).toBe(403);
    database.db.update(submissionUsers).set({ subscriptionExpiresAt: null }).where(eq(submissionUsers.id, first)).run();
    database.db
      .insert(concurrencyEscalationState)
      .values({ memberId: first, disabledUntil: "2099-01-01", updatedAt: new Date().toISOString() })
      .run();
    expect((await create()).response.status).toBe(403);
    database.db.delete(concurrencyEscalationState).run();
    details.mockImplementation(async () => {
      database.db.update(submissionUsers).set({ enabled: false }).where(eq(submissionUsers.id, first)).run();
      return metadata;
    });
    expect((await create()).response.status).toBe(403);
    expect((await request("", "GET", undefined, undefined, true)).status).toBe(200);
  });

  it("allows own open description edits, rejects stale writes and audits manual admin status changes", async () => {
    const { body } = await create();
    const row = body.request;
    const edit = await request(`/${row.id}`, "PATCH", { description: "缺E04、E05", updatedAt: row.updatedAt });
    const changed = (await edit.json()).request;
    expect(edit.status).toBe(200);
    expect((await request(`/${row.id}`, "PATCH", { description: "old", updatedAt: row.updatedAt })).status).toBe(409);
    const done = await request(
      `/${row.id}`,
      "PATCH",
      { status: "available", adminNote: "已补齐", updatedAt: changed.updatedAt },
      undefined,
      true,
    );
    expect(done.status).toBe(200);
    const closed = (await done.json()).request;
    expect((await request(`/${row.id}`, "PATCH", { description: "later", updatedAt: closed.updatedAt })).status).toBe(
      409,
    );
    const again = await create();
    expect(again.response.status).toBe(201);
    expect(
      (
        await request(
          `/${row.id}`,
          "PATCH",
          { status: "pending", adminNote: "重新处理", updatedAt: closed.updatedAt },
          undefined,
          true,
        )
      ).status,
    ).toBe(409);
    const logs = database.db.select().from(auditLogs).all();
    expect(logs.map((log) => log.action)).toEqual([
      "media_request.created",
      "media_request.description",
      "media_request.updated",
      "media_request.created",
    ]);
    expect((await (await request("?q=正确&status=available", "GET", undefined, undefined, true)).json()).total).toBe(1);
  });

  it("does not save on failed metadata reads, and a recreated member cannot see previous member history", async () => {
    details.mockRejectedValueOnce(new Error("offline"));
    expect((await create()).response.status).toBe(502);
    expect((await (await request()).json()).total).toBe(0);
    await create();
    database.db.delete(submissionUsers).where(eq(submissionUsers.id, first)).run();
    user("one@example.com");
    expect((await (await request()).json()).total).toBe(0);
    expect((await (await request("", "GET", undefined, undefined, true)).json()).total).toBe(1);
  });

  it.each([
    ["2026-10-01T08:00:00+08:00", "2026-10-01T00:00:00.000Z"],
    ["invalid", null],
  ])("updates a historical version %s and preserves its retention start", async (updatedAt, availableAt) => {
    const { body } = await create();
    const { id } = body.request;
    database.db
      .update(mediaRequests)
      .set({ status: "available", updatedAt, availableAt })
      .where(eq(mediaRequests.id, id))
      .run();
    const save = () =>
      request(`/${id}`, "PATCH", { status: "available", adminNote: "补充历史反馈", updatedAt }, undefined, true);
    const beforeSave = Date.now();
    const saved = await save();
    expect(saved.status).toBe(200);
    const { request: updated } = await saved.json();
    expect(updated).toMatchObject({ status: "available", adminNote: "补充历史反馈", availableAt });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(beforeSave);
    expect((await save()).status).toBe(409);
    const reopened = await request(
      `/${id}`,
      "PATCH",
      { status: "processing", adminNote: "重新处理", updatedAt: updated.updatedAt },
      undefined,
      true,
    );
    expect(reopened.status).toBe(200);
    const { request: processing } = await reopened.json();
    expect(processing.availableAt).toBeNull();
    const completed = await request(
      `/${id}`,
      "PATCH",
      { status: "available", adminNote: "已入库", updatedAt: processing.updatedAt },
      undefined,
      true,
    );
    expect(completed.status).toBe(200);
    const { request: available } = await completed.json();
    expect(available.availableAt).toBe(available.updatedAt);
  });
});
