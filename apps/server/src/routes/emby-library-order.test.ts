import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { appSettings, auditLogs } from "@emby-task-center/database/schema";
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
const virtual = { id: "106", guid: "ffffffff-ffff-ffff-ffff-ffffffffffff", name: "虚拟库" };

type Preferences = Awaited<ReturnType<EmbyLibraryOrderSession["getUserPreferences"]>>;
type PreviewResult = {
  previewToken: string;
  libraries: string[];
  proxyChanged: boolean;
  users: {
    id: string;
    status: string;
    before: string[];
    after: string[];
    proxyBefore?: string[];
    proxyAfter?: string[];
  }[];
};

describe("Emby library order admin HTTP flow", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  let cookie: string;
  let connection: object | undefined;
  let preferences: Record<string, Preferences>;
  let views: Record<string, (typeof films)[]>;
  let mediaFolderItems: Array<{ id: string; name: string; guid: string }>;
  let failUsers: Set<string>;
  const updateOrder = vi.fn<EmbyLibraryOrderSession["updateOrder"]>();

  async function request(path: string, payload?: unknown, auth = cookie, status = 200) {
    const response = await fetch(`${base}${path}`, {
      method:
        payload === undefined
          ? "GET"
          : typeof payload === "object" && payload !== null && "order" in payload && !("previewToken" in payload)
            ? "PUT"
            : "POST",
      headers: { cookie: auth, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(status);
    return response;
  }

  async function preview(payload: object = {}): Promise<PreviewResult> {
    return (await request(`${endpoint}/preview`, payload)).json();
  }

  async function apply(previewToken: string, status = 200) {
    return (await request(`${endpoint}/apply`, { previewToken }, cookie, status)).json();
  }

  async function save(order: string[]) {
    return (await request(endpoint, { order })).json();
  }

  beforeEach(async () => {
    connection = {};
    failUsers = new Set();
    preferences = {
      admin: { isAdministrator: true, orderedViews: [tv.guid, films.guid], hiddenViews: [] },
      otherAdmin: { isAdministrator: true, orderedViews: [films.guid, tv.guid, virtual.guid], hiddenViews: [] },
      member: {
        isAdministrator: false,
        orderedViews: [films.guid, hidden.guid, extras.id, "unavailable"],
        hiddenViews: [hidden.id],
      },
      disabled: { isAdministrator: false, orderedViews: [films.guid], hiddenViews: [] },
    };
    views = {
      admin: [films, tv, anime, virtual],
      otherAdmin: [films, tv, virtual],
      member: [films, extras, tv, hidden],
      disabled: [films],
    };
    mediaFolderItems = [films, tv, anime, virtual, extras, hidden].map((view) => ({
      id: view.id,
      name: view.name,
      guid: view.guid,
    }));
    updateOrder.mockReset().mockImplementation(async (id, orderedViews) => {
      preferences[id]!.orderedViews = orderedViews;
    });
    const native = [films, tv, anime, extras, hidden].map((view) => ({
      id: view.id,
      name: view.name,
      collectionType: null,
    }));
    const openLibraryOrderSession = () =>
      connection &&
      ({
        identity: connection,
        baseUrl: "https://emby.test",
        listUsers: async () =>
          Object.keys(preferences).map((id) => ({
            Id: id,
            Name: id,
            Policy: {
              IsAdministrator: id === "admin" || id === "otherAdmin",
              IsDisabled: id === "disabled",
            },
          })),
        listServerLibraries: async () => native,
        listMediaFolders: async () => mediaFolderItems,
        getUserPreferences: async (id) => {
          if (failUsers.has(id)) throw new Error("fixture_user_read_failed");
          return structuredClone(preferences[id]!);
        },
        listUserViews: async (id) => structuredClone(views[id]!),
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

  it("requires admin auth and exposes a read-only catalog before an order is saved", async () => {
    const member = createPublicSessionManager(secret).issueCookie("member@example.com").split(";")[0]!;
    for (const auth of ["", member]) {
      await request(endpoint, undefined, auth, 401);
      await request(`${endpoint}/preview`, {}, auth, 401);
    }
    const body = await (await request(endpoint)).json();
    expect(body.saved).toBe(false);
    expect(body.savedOrder).toEqual([]);
    expect(body.order).toEqual(
      [tv.guid, films.guid, anime.guid, virtual.guid, extras.guid, hidden.guid].map((id) =>
        id.replaceAll("-", "").toLowerCase(),
      ),
    );
    expect(body.users).toEqual([
      { id: "admin", name: "admin", isAdministrator: true, isDisabled: false },
      { id: "otherAdmin", name: "otherAdmin", isAdministrator: true, isDisabled: false },
      { id: "member", name: "member", isAdministrator: false, isDisabled: false },
      { id: "disabled", name: "disabled", isAdministrator: false, isDisabled: true },
    ]);
    expect(body.libraries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "电影", kind: "native", visibleUsers: 4 }),
        expect.objectContaining({ name: "虚拟库", kind: "virtual", visibleUsers: 2 }),
        expect.objectContaining({ name: "已隐藏", kind: "native", visibleUsers: 1 }),
      ]),
    );
    expect(body.warnings.join(" ")).toContain("非原生媒体库");
    await request(`${endpoint}/preview`, {}, cookie, 409);
  });

  it("saves an order, previews every account including admins, and preserves unknown tokens", async () => {
    const saved = await save([anime.guid, films.guid, tv.guid, virtual.guid]);
    expect(saved.order).toEqual([
      "cccccccccccccccccccccccccccccccc",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "ffffffffffffffffffffffffffffffff",
      "dddddddddddddddddddddddddddddddd",
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ]);
    const previewBody = await preview();
    expect(previewBody.proxyChanged).toBe(true);
    expect(previewBody.libraries).toEqual(["动漫", "电影", "剧集", "虚拟库", "独享", "已隐藏"]);
    expect(previewBody.users).toEqual([
      {
        id: "admin",
        name: "admin",
        isAdministrator: true,
        isDisabled: false,
        status: "change",
        before: ["剧集", "电影", "动漫", "虚拟库"],
        after: ["动漫", "电影", "剧集", "虚拟库"],
        proxyBefore: ["电影", "剧集", "动漫", "虚拟库"],
        proxyAfter: ["动漫", "电影", "剧集", "虚拟库"],
      },
      {
        id: "otherAdmin",
        name: "otherAdmin",
        isAdministrator: true,
        isDisabled: false,
        status: "unchanged",
        before: ["电影", "剧集", "虚拟库"],
        after: ["电影", "剧集", "虚拟库"],
        proxyBefore: ["电影", "剧集", "虚拟库"],
        proxyAfter: ["电影", "剧集", "虚拟库"],
      },
      {
        id: "member",
        name: "member",
        isAdministrator: false,
        isDisabled: false,
        status: "change",
        before: ["电影", "已隐藏", "独享", "剧集"],
        after: ["电影", "剧集", "独享", "已隐藏"],
        proxyBefore: ["电影", "独享", "剧集", "已隐藏"],
        proxyAfter: ["电影", "剧集", "独享", "已隐藏"],
      },
      {
        id: "disabled",
        name: "disabled",
        isAdministrator: false,
        isDisabled: true,
        status: "unchanged",
        before: ["电影"],
        after: ["电影"],
        proxyBefore: ["电影"],
        proxyAfter: ["电影"],
      },
    ]);
    expect(updateOrder).not.toHaveBeenCalled();
    const applied = await apply(previewBody.previewToken);
    expect(applied.proxyActivated).toBe(true);
    expect(applied.users).toEqual([
      { id: "admin", name: "admin", isAdministrator: true, isDisabled: false, status: "updated" },
      { id: "otherAdmin", name: "otherAdmin", isAdministrator: true, isDisabled: false, status: "unchanged" },
      { id: "member", name: "member", isAdministrator: false, isDisabled: false, status: "updated" },
      { id: "disabled", name: "disabled", isAdministrator: false, isDisabled: true, status: "unchanged" },
    ]);
    expect(updateOrder).toHaveBeenCalledTimes(2);
    expect(updateOrder).toHaveBeenCalledWith("admin", [anime.guid, films.guid, tv.guid, virtual.guid]);
    expect(updateOrder).toHaveBeenCalledWith("member", [films.guid, tv.guid, extras.id, "unavailable", hidden.guid]);
    const actions = database.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .all()
      .map((row) => row.action);
    expect(actions).toContain("emby_library_order.saved");
    expect(actions).toContain("emby_library_order.applied");
    await apply(previewBody.previewToken, 409);
  });

  it("supports a single-account test preview and rejects a changed global order", async () => {
    await save([anime.guid, films.guid, tv.guid, virtual.guid]);
    const previewBody = await preview({ userIds: ["member"] });
    expect(previewBody.users.map((user) => user.id)).toEqual(["member"]);
    await save([films.guid, anime.guid, tv.guid, virtual.guid]);
    expect(await apply(previewBody.previewToken, 409)).toEqual({ error: "library_order_order_changed" });
    expect(updateOrder).not.toHaveBeenCalled();
  });

  it("rejects an older preview when the saved draft is a longer version of the same order", async () => {
    const { order } = await save([films.guid, tv.guid]);
    const older = await preview();
    mediaFolderItems.push({
      id: "107",
      name: "新增库",
      guid: "11111111-1111-4111-8111-111111111111",
    });
    const latest = await save(order);
    expect(latest.order.slice(0, -1)).toEqual(order);
    expect(await apply(older.previewToken, 409)).toEqual({ error: "library_order_order_changed" });
    expect(updateOrder).not.toHaveBeenCalled();
  });

  it("writes disabled accounts too", async () => {
    preferences.disabled = { isAdministrator: false, orderedViews: [tv.guid], hiddenViews: [] };
    views.disabled = [films, tv];
    await save([anime.guid, films.guid, tv.guid, virtual.guid]);
    const previewBody = await preview();
    expect(previewBody.users).toContainEqual(
      expect.objectContaining({
        id: "disabled",
        isDisabled: true,
        status: "change",
        before: ["剧集", "电影"],
        after: ["电影", "剧集"],
      }),
    );
    const applied = await apply(previewBody.previewToken);
    expect(applied.users).toContainEqual(
      expect.objectContaining({ id: "disabled", isDisabled: true, status: "updated" }),
    );
    expect(updateOrder).toHaveBeenCalledWith("disabled", [films.guid, tv.guid]);
  });

  it("includes a library discovered between saving and previewing", async () => {
    await save([anime.guid, films.guid, tv.guid, virtual.guid]);
    mediaFolderItems.push({
      id: "107",
      name: "新增库",
      guid: "11111111-1111-4111-8111-111111111111",
    });
    const previewBody = await preview();
    expect(previewBody.libraries).toContain("新增库");
    const applied = await apply(previewBody.previewToken);
    expect(applied.users.every((user: { status: string }) => user.status !== "failed")).toBe(true);
    const row = database.db.select().from(appSettings).where(eq(appSettings.key, "emby.libraryOrder")).get();
    expect(JSON.parse(row!.value!).order).toContain("11111111111141118111111111111111");
  });

  it("blocks order saves and new previews while an apply is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    updateOrder.mockImplementation(async (id, orderedViews) => {
      await gate;
      preferences[id]!.orderedViews = orderedViews;
    });
    await save([anime.guid, films.guid, tv.guid, virtual.guid]);
    const previewBody = await preview();
    const running = apply(previewBody.previewToken);
    await vi.waitFor(() => expect(updateOrder).toHaveBeenCalled());
    await request(endpoint, { order: [films.guid, anime.guid, tv.guid, virtual.guid] }, cookie, 409);
    await request(`${endpoint}/preview`, {}, cookie, 409);
    release();
    const done = await running;
    expect(done.users).toContainEqual(expect.objectContaining({ id: "admin", status: "updated" }));
  });

  it("marks an unreadable account as failed and never writes it", async () => {
    failUsers.add("member");
    const body = await (await request(endpoint)).json();
    expect(body.warnings.join(" ")).toContain("1 个 Emby 账号的媒体库顺序读取失败");
    await save([anime.guid, films.guid, tv.guid, virtual.guid]);
    const previewBody = await preview();
    expect(previewBody.users).toContainEqual(
      expect.objectContaining({ id: "member", status: "failed", reason: "library_order_read_failed" }),
    );
    const applied = await apply(previewBody.previewToken);
    expect(applied.users).toContainEqual(
      expect.objectContaining({ id: "member", status: "failed", reason: "library_order_read_failed" }),
    );
    expect(updateOrder).not.toHaveBeenCalledWith("member", expect.anything());
  });

  it("rejects an unknown test account", async () => {
    await save([anime.guid, films.guid, tv.guid, virtual.guid]);
    await request(`${endpoint}/preview`, { userIds: ["missing"] }, cookie, 400);
  });

  it("rejects unknown, duplicate and empty orders", async () => {
    await request(endpoint, { order: [] }, cookie, 400);
    await request(endpoint, { order: ["missing"] }, cookie, 400);
    await request(endpoint, { order: [films.guid, films.id] }, cookie, 400);
  });
});
