import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import { writeSettings } from "../settings/store";
import { startShare115Worker } from "../share-115/worker";
import { addSubmissionUser, getSubmissionUserByEmail } from "../subscriptions/membership";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { createTmdbClient } from "../tmdb/client";

const shareUrl = "https://115.com/s/example115?password=A013";
const sessionSecret = "share-115-test-secret";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("member 115 submissions through HTTP and the background queue", () => {
  let database: DatabaseHandle;
  let app: Server;
  let upstream: Server;
  let worker: ReturnType<typeof startShare115Worker>;
  let base: string;
  let first: string;
  let second: string;
  let expired: string;
  let admin: string;
  let enabled: boolean;
  let upstreamStatus: number;
  let release: () => void;
  const upstreamRequest = vi.fn();

  beforeEach(async () => {
    database = createDatabase(":memory:");
    const memberSession = createPublicSessionManager(sessionSecret, (email) =>
      getSubmissionUserByEmail(database.db, email),
    );
    function member(email: string, expiry = "2099-01-01T00:00:00.000Z") {
      addSubmissionUser(database.db, { email, subscriptionExpiresAt: expiry });
      return memberSession.issueCookie(email).split(";")[0]!;
    }
    first = member("first@example.test");
    second = member("second@example.test");
    expired = member("expired@example.test", "2020-01-01T00:00:00.000Z");
    enabled = true;
    upstreamStatus = 200;
    upstreamRequest.mockClear();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      upstreamRequest(request.url, request.headers.authorization, JSON.parse(body));
      await gate;
      response.writeHead(upstreamStatus, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          data: {
            success: true,
            mode: "share",
            provider: "115",
            already_owned: false,
            target: { folder_id: "98765" },
            transfer: { selected_count: 1 },
            share_title: "测试分享",
          },
        }),
      );
    });
    const upstreamBase = await listen(upstream);
    worker = startShare115Worker({
      database: database.db,
      readConfig: () => ({ enabled, baseUrl: upstreamBase, token: "test-openapi-token" }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const service = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier("test-password") },
      tmdb: createTmdbClient({ token: "" }),
      library: createLibraryService([]),
      share115: worker,
    });
    app = createServer(service);
    base = await listen(app);
    const login = await send("/api/auth/login", "", { password: "test-password" });
    expect(login.status).toBe(200);
    admin = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    release?.();
    worker?.stop();
    await worker?.close();
    if (app) await close(app);
    if (upstream) await close(upstream);
    database?.close();
  });

  function send(path: string, cookie: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return fetch(`${base}${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  }

  const memberPath = "/api/public/115-shares";
  const adminPath = "/api/115-shares";
  const shareText = "分享链接：https://115.com/s/example115\n访问码：A013";

  it("queues immediately, isolates member histories and shares one transfer result", async () => {
    expect((await send(memberPath, "", { shareText })).status).toBe(401);
    expect((await send(memberPath, expired, { shareText })).status).toBe(403);
    expect((await send(adminPath, first)).status).toBe(401);
    const invalid = await send(memberPath, first, { shareText: "https://115.com.example.test/s/example115" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_share_link" });
    const conflict = await send(memberPath, first, { shareText, accessCode: "B001" });
    expect(await conflict.json()).toEqual({ error: "conflicting_access_code" });
    expect(upstreamRequest).not.toHaveBeenCalled();

    const response = await send(memberPath, first, { shareText, note: "第 2 季" });
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const { item } = await response.json();
    expect(item).toMatchObject({ note: "第 2 季", shareUrl, accessCode: "A013", status: "queued" });
    expect(item).not.toHaveProperty("memberEmail");
    const secondResponse = await send(memberPath, second, {
      shareText: shareUrl.replace("115.com", "115cdn.com"),
      note: "另一条说明",
    });
    expect(secondResponse.status).toBe(202);
    const secondItem = (await secondResponse.json()).item;
    expect(secondItem).toMatchObject({ jobId: item.jobId, note: "另一条说明" });
    expect(secondItem.id).not.toBe(item.id);
    const own = await (await send(memberPath, first)).json();
    expect(own.items.map((row: { id: number }) => row.id)).toEqual([item.id]);

    await vi.waitFor(() =>
      expect(upstreamRequest).toHaveBeenCalledExactlyOnceWith(
        "/api/media/resources/transfer",
        "Bearer test-openapi-token",
        { provider: "115", source: "guanying", share_url: shareUrl, enforce_points_limit: true, max_points: 0 },
      ),
    );
    release();
    await vi.waitFor(async () => {
      const result = await (await send(`${adminPath}?status=saved`, admin)).json();
      expect(result.items).toEqual([
        expect.objectContaining({ id: secondItem.id, memberEmail: "second@example.test", shareTitle: "测试分享" }),
        expect.objectContaining({ id: item.id, memberEmail: "first@example.test", targetFolderId: "98765" }),
      ]);
    });
    expect(upstreamRequest).toHaveBeenCalledTimes(1);
  });

  it("stops admitting jobs while paused and lets only administrators resolve an ambiguous outcome", async () => {
    enabled = false;
    expect((await (await send(memberPath, first)).json()).accepting).toBe(false);
    expect((await send(memberPath, first, { shareText })).status).toBe(503);

    enabled = true;
    upstreamStatus = 202;
    const { item } = await (await send(memberPath, first, { shareText })).json();
    release();
    await vi.waitFor(async () => {
      const result = await (await send(memberPath, first)).json();
      expect(result.items[0]?.status).toBe("unconfirmed");
    });
    const resolve = `${adminPath}/jobs/${item.jobId}/resolve`;
    expect((await send(resolve, first, { status: "saved" }, "PATCH")).status).toBe(401);
    expect((await send(resolve, admin, { status: "saved" }, "PATCH")).status).toBe(200);
    expect((await send(resolve, admin, { status: "failed" }, "PATCH")).status).toBe(409);
    const result = await (await send(memberPath, first)).json();
    expect(result.items[0]).toMatchObject({ status: "saved", resultCode: "confirmed_saved" });
    expect(upstreamRequest).toHaveBeenCalledTimes(1);
  });

  it("queues an administrator submission with its own identity and the shared transfer worker", async () => {
    writeSettings(database.db, { "admin.username": "library-admin" });
    expect((await send(adminPath, first, { shareText })).status).toBe(401);
    expect((await send(memberPath, admin, { shareText })).status).toBe(401);
    const response = await send(adminPath, admin, { shareText, note: "管理员补充" });
    expect(response.status).toBe(202);
    const { item } = await response.json();
    expect(item).toMatchObject({
      adminUsername: "library-admin",
      memberId: null,
      memberEmail: null,
      shareUrl,
      status: "queued",
    });
    expect((await (await send(memberPath, first)).json()).items).toEqual([]);

    const memberSubmission = await send(memberPath, first, { shareText, note: "会员补充" });
    expect(memberSubmission.status).toBe(202);
    const own = (await memberSubmission.json()).item;
    expect(own.jobId).toBe(item.jobId);
    expect(own.id).not.toBe(item.id);
    expect(own).not.toHaveProperty("adminUsername");
    release();

    await vi.waitFor(async () => {
      const filtered = await (await send(`${adminPath}?q=library-admin&status=saved`, admin)).json();
      expect(filtered.items).toEqual([expect.objectContaining({ id: item.id, adminUsername: "library-admin" })]);
      const memberRecords = await (await send(memberPath, first)).json();
      expect(memberRecords.items).toEqual([expect.objectContaining({ id: own.id, status: "saved" })]);
    });
    expect(upstreamRequest).toHaveBeenCalledTimes(1);
  });

  it("queues valid links in a pasted batch and identifies only the link that needs correction", async () => {
    const body = {
      shareText: [
        "影片一 " + shareUrl,
        "其他参考 https://example.test/s/other",
        "影片二 https://115cdn.com/s/second115",
        "访问码：B024",
        "影片三 https://115.com/s/third115?password=invalid",
      ].join("\n"),
      note: "本批补充",
    };
    const response = await send(memberPath, first, body);
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result.items).toEqual([
      expect.objectContaining({ shareUrl, accessCode: "A013", note: "本批补充" }),
      expect.objectContaining({ shareUrl: "https://115.com/s/second115?password=B024", accessCode: "B024" }),
    ]);
    expect(result.item).toEqual(result.items[0]);
    expect(result.rejected).toEqual([
      { index: 3, error: "invalid_access_code", retryText: "https://115.com/s/third115?password=invalid" },
    ]);
    expect((await (await send(memberPath, first)).json()).total).toBe(2);
    expect((await (await send(memberPath, second)).json()).total).toBe(0);
    release();
    await vi.waitFor(async () => {
      worker.wake();
      expect((await (await send(memberPath + "?status=saved", first)).json()).total).toBe(2);
    });
    expect(upstreamRequest.mock.calls.map((call) => call[2].share_url)).toEqual([
      shareUrl,
      "https://115.com/s/second115?password=B024",
    ]);
  });

  it("enforces the member quota across simultaneous batches and reuses the shared job", async () => {
    const batches = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const response = await send(memberPath, first, {
          shareText: shareUrl + "\nhttps://115.com/s/unique" + index,
        });
        expect(response.status).toBe(202);
        return (await response.json()) as {
          items: Array<{ id: number; shareUrl: string }>;
          rejected: Array<{ index: number; error: string }>;
        };
      }),
    );
    const commonIds = batches.flatMap(({ items }) =>
      items.filter((item) => item.shareUrl === shareUrl).map(({ id }) => id),
    );
    expect(commonIds).toHaveLength(12);
    expect(new Set(commonIds).size).toBe(1);
    expect(batches.flatMap(({ rejected }) => rejected)).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ index: 2, error: "rate_limited" })),
    );
    expect((await (await send(memberPath, first)).json()).total).toBe(10);

    const rejected = await send(memberPath, first, {
      shareText: "https://115.com/s/afterQuota1\nhttps://115.com/s/afterQuota2",
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({
      items: [],
      rejected: [1, 2].map((index) => ({
        index,
        error: "rate_limited",
        retryText: "https://115.com/s/afterQuota" + index,
      })),
    });
  });
});
