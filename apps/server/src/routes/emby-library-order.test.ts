import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmbyLibraryOrderSession } from "../integrations/emby-library-order-client";
import { createLibraryService } from "../library/service";
import { createPublicSessionManager } from "../subscriptions/public-session";
import type { TmdbClient } from "../tmdb/client";

const endpoint = "/api/emby/library-order";
const secret = "library-order-fixture-secret";
const films = { id: "101", guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "电影" };
const tv = { id: "102", guid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", name: "剧集" };
const anime = { id: "103", guid: "cccccccccccccccccccccccccccccccc", name: "动漫" };
const extras = { id: "104", guid: "dddddddddddddddddddddddddddddddd", name: "独享" };
const hidden = { id: "105", guid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", name: "已隐藏" };

type Preferences = Awaited<ReturnType<EmbyLibraryOrderSession["getUserPreferences"]>>;
type PreviewResult = {
  previewToken: string;
  libraries: string[];
  users: { id: string; status: string; before: string[]; after: string[] }[];
};

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("Emby library order admin HTTP flow", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  let cookie: string;
  let connection: object | undefined;
  let preferences: Record<string, Preferences>;
  let views: Record<string, (typeof films)[]>;
  let accountsIgnoringOrder: Set<string>;
  const updateOrder = vi.fn<EmbyLibraryOrderSession["updateOrder"]>();

  async function request(path: string, payload?: unknown, auth = cookie, status = 200) {
    const response = await fetch(`${base}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { cookie: auth, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(status);
    return response;
  }

  async function preview(): Promise<PreviewResult> {
    return (await request(`${endpoint}/preview`, { sourceUserId: "admin" })).json();
  }

  async function apply(previewToken: string, status = 200) {
    return (await request(`${endpoint}/apply`, { previewToken }, cookie, status)).json();
  }

  beforeEach(async () => {
    connection = {};
    accountsIgnoringOrder = new Set();
    preferences = {
      admin: { isAdministrator: true, orderedViews: [tv.guid, films.id, anime.guid], hiddenViews: [] },
      otherAdmin: { isAdministrator: true, orderedViews: [], hiddenViews: [] },
      member: {
        isAdministrator: false,
        orderedViews: [films.guid, hidden.guid, extras.id, tv.id, "unavailable"],
        hiddenViews: [hidden.id],
      },
      another: { isAdministrator: false, orderedViews: [films.guid, tv.id], hiddenViews: [] },
      same: { isAdministrator: false, orderedViews: [], hiddenViews: [] },
      changedRole: { isAdministrator: true, orderedViews: [], hiddenViews: [] },
    };
    views = {
      admin: [films, tv, anime],
      member: [films, extras, { ...tv, guid: tv.guid.replaceAll("-", "").toLowerCase() }, hidden],
      another: [films, tv],
      same: [tv, films],
    };
    updateOrder.mockReset().mockImplementation(async (id, orderedViews) => {
      preferences[id]!.orderedViews = orderedViews;
    });
    const openLibraryOrderSession = () =>
      connection &&
      ({
        identity: connection,
        listUsers: async () =>
          Object.keys(preferences).map((id) => ({
            Id: id,
            Name: id,
            Policy: { IsAdministrator: id === "admin" || id === "otherAdmin" },
          })),
        getUserPreferences: async (id) => structuredClone(preferences[id]!),
        listUserViews: async (id) => {
          const listed = views[id]!;
          if (accountsIgnoringOrder.has(id)) return structuredClone(listed);
          const preferred = preferences[id]!.orderedViews.flatMap((key) =>
            listed.filter((view) => view.id === key || view.guid === key),
          );
          return structuredClone([...new Set([...preferred, ...listed])]);
        },
        updateOrder,
      } satisfies EmbyLibraryOrderSession);

    database = createDatabase(":memory:");
    const app = createApp({
      database: database.db,
      auth: { sessionSecret: secret, verifyCredentials: staticCredentialVerifier("order-test-password") },
      library: createLibraryService([]),
      tmdb: {} as TmdbClient,
      integrationServices: {
        emby: { configured: true, openLibraryOrderSession } as EmbyClient,
        email: {
          configured: false,
          sendNotification: async () => {},
          retryPending: async () => {},
          sendTest: async () => {},
        },
      },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await request("/api/auth/login", { password: "order-test-password" }, "");
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });

  it("requires admin auth and a preview token, and accepts only an Emby administrator template", async () => {
    const member = createPublicSessionManager(secret).issueCookie("member@example.com").split(";")[0]!;
    for (const auth of ["", member]) {
      await request(endpoint, undefined, auth, 401);
      await request(`${endpoint}/preview`, { sourceUserId: "admin" }, auth, 401);
      await request(`${endpoint}/apply`, {}, auth, 401);
    }
    expect(await (await request(endpoint)).json()).toEqual({
      admins: [
        { id: "admin", name: "admin" },
        { id: "otherAdmin", name: "otherAdmin" },
      ],
    });
    await request(`${endpoint}/preview`, { sourceUserId: "member" }, cookie, 400);
    await request(`${endpoint}/apply`, { sourceUserId: "admin" }, cookie, 400);
    expect(updateOrder).not.toHaveBeenCalled();
  });

  it("previews without writes, preserves hidden and opaque tokens, and updates only changed ordinary accounts", async () => {
    const result = await preview();
    expect(result.libraries).toEqual(["剧集", "电影", "动漫"]);
    expect(result.users).toContainEqual({
      id: "member",
      name: "member",
      status: "change",
      before: ["电影", "独享", "剧集"],
      after: ["剧集", "电影", "独享"],
    });
    expect(result.users).not.toContainEqual(expect.objectContaining({ id: "otherAdmin" }));
    expect(updateOrder).not.toHaveBeenCalled();
    const applied = await apply(result.previewToken);
    expect(applied.users).toEqual([
      { id: "member", name: "member", status: "updated" },
      { id: "another", name: "another", status: "updated" },
      { id: "same", name: "same", status: "unchanged" },
      { id: "changedRole", name: "changedRole", status: "skipped", reason: "library_order_role_unknown" },
    ]);
    expect(updateOrder).toHaveBeenCalledTimes(2);
    expect(updateOrder).toHaveBeenCalledWith("member", [tv.id, hidden.guid, films.guid, extras.id, "unavailable"]);
    expect(await apply(result.previewToken, 409)).toEqual({ error: "library_order_preview_expired" });
    expect((await preview()).users.every((user) => user.status !== "change")).toBe(true);
  });

  it("rejects a changed template or integration and an expired token", async () => {
    const staleSource = await preview();
    preferences.admin!.orderedViews.reverse();
    expect(await apply(staleSource.previewToken, 409)).toEqual({ error: "library_order_source_changed" });
    const staleConnection = await preview();
    connection = {};
    expect(await apply(staleConnection.previewToken, 409)).toEqual({ error: "library_order_connection_changed" });
    vi.useFakeTimers({ toFake: ["Date"] });
    const expired = await preview();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    expect(await apply(expired.previewToken, 409)).toEqual({ error: "library_order_preview_expired" });
    connection = undefined;
    await request(endpoint, undefined, cookie, 503);
    expect(updateOrder).not.toHaveBeenCalled();
  });

  it("skips changes since preview and does not include new accounts in the approved batch", async () => {
    const result = await preview();
    preferences.member!.hiddenViews = [extras.id];
    preferences.joined = { isAdministrator: false, orderedViews: [films.id, tv.id], hiddenViews: [] };
    views.joined = [films, tv];
    const applied = await apply(result.previewToken);
    expect(applied.users).toContainEqual({
      id: "member",
      name: "member",
      status: "skipped",
      reason: "library_order_user_changed",
    });
    expect(updateOrder).toHaveBeenCalledExactlyOnceWith("another", [tv.id, films.guid]);
    expect((await preview()).users).toContainEqual(expect.objectContaining({ id: "joined", status: "change" }));
  });

  it("reports refused and unverified writes without retrying either", async () => {
    updateOrder.mockImplementation(async (id) => {
      if (id === "member") throw new Error("sensitive upstream failure");
    });
    const result = await preview();
    expect((await apply(result.previewToken)).users).toEqual(
      expect.arrayContaining([
        { id: "member", name: "member", status: "failed", reason: "library_order_write_failed" },
        { id: "another", name: "another", status: "failed", reason: "library_order_verify_failed" },
      ]),
    );
    expect(updateOrder).toHaveBeenCalledTimes(2);
  });

  it("reports an unverified update when the saved preferences do not change the visible list", async () => {
    accountsIgnoringOrder.add("member");
    const result = await preview();
    const applied = await apply(result.previewToken);
    expect(preferences.member!.orderedViews[0]).toBe(tv.id);
    expect(applied.users).toContainEqual({
      id: "member",
      name: "member",
      status: "failed",
      reason: "library_order_verify_failed",
    });
    expect(updateOrder.mock.calls.filter(([id]) => id === "member")).toHaveLength(1);
    expect((await preview()).users).toContainEqual(
      expect.objectContaining({ id: "member", status: "change", before: ["电影", "独享", "剧集"] }),
    );
  });

  it("allows only one batch to write at a time and rechecks the other batch afterward", async () => {
    const first = await preview();
    const second = await preview();
    const entered = latch();
    const pendingWrite = latch();
    updateOrder.mockImplementation(async (id, order) => {
      entered.release();
      await pendingWrite.promise;
      preferences[id]!.orderedViews = order;
    });
    const active = apply(first.previewToken);
    try {
      await entered.promise;
      expect(await apply(second.previewToken, 409)).toEqual({ error: "library_order_busy" });
    } finally {
      pendingWrite.release();
      await active;
    }
    const applied = await apply(second.previewToken);
    expect(applied.users).toContainEqual(
      expect.objectContaining({ id: "member", status: "skipped", reason: "library_order_user_changed" }),
    );
    expect(updateOrder).toHaveBeenCalledTimes(2);
  });
});
