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
import { writeSettings } from "../settings/store";
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
const proxyOnly = { id: "107", guid: "11111111-1111-1111-1111-111111111111", name: "反代榜单库" };

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
    proxyReason?: string;
  }[];
};

describe("Emby library order admin HTTP flow", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  let cookie: string;
  let connection: object | undefined;
  let proxyConnection: object | undefined;
  let preferences: Record<string, Preferences>;
  let views: Record<string, (typeof films)[]>;
  let extraAdminSettings: (typeof films)[];
  let proxyViews: Record<string, (typeof films)[]>;
  let mediaFolderItems: Array<{ id: string; name: string; guid: string }>;
  let failUsers: Set<string>;
  let failProxyViews: Set<string>;
  let failProxyFolders: boolean;
  const updateOrder = vi.fn<EmbyLibraryOrderSession["updateOrder"]>();
  const proxyUpdateOrder = vi.fn<EmbyLibraryOrderSession["updateOrder"]>();

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
    proxyConnection = {};
    proxyUpdateOrder.mockReset();
    failUsers = new Set();
    failProxyViews = new Set();
    failProxyFolders = false;
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
    extraAdminSettings = [];
    proxyViews = {
      admin: [films, tv, anime, virtual, proxyOnly],
      otherAdmin: [films, tv, virtual, proxyOnly],
      member: [films, extras, tv, hidden, proxyOnly],
      disabled: [films, proxyOnly],
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
    const openLibraryOrderSession = (baseUrl?: string) => {
      if (!connection || (baseUrl && baseUrl !== "https://proxy.test")) return undefined;
      const proxy = baseUrl === "https://proxy.test";
      const sessionIdentity = proxy ? proxyConnection : connection;
      if (!sessionIdentity) return undefined;
      return {
        identity: sessionIdentity,
        baseUrl: proxy ? baseUrl : "https://emby.test",
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
        listMediaFolders: async () => {
          if (proxy && failProxyFolders) throw new Error("fixture_proxy_folders_failed");
          return proxy
            ? [...mediaFolderItems, { id: proxyOnly.id, name: proxyOnly.name, guid: proxyOnly.guid }]
            : mediaFolderItems;
        },
        getUserPreferences: async (id) => {
          if (failUsers.has(id)) throw new Error("fixture_user_read_failed");
          return structuredClone(preferences[id]!);
        },
        listUserViews: async (id, options) => {
          if (proxy && failProxyViews.has(id)) throw new Error("fixture_proxy_views_failed");
          const libraries = (proxy && options?.includeHidden ? proxyViews : views)[id]!;
          return structuredClone(
            !proxy && options?.includeHidden && id === "admin" ? [...libraries, ...extraAdminSettings] : libraries,
          );
        },
        updateOrder: proxy ? proxyUpdateOrder : updateOrder,
      } satisfies EmbyLibraryOrderSession;
    };

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
        expect.objectContaining({ name: "虚拟库", kind: "virtual", direct: false, visibleUsers: 2 }),
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
        before: ["剧集", "电影", "动漫"],
        after: ["动漫", "电影", "剧集"],
        proxyBefore: ["电影", "剧集", "动漫", "虚拟库"],
        proxyAfter: ["动漫", "电影", "剧集", "虚拟库"],
      },
      {
        id: "otherAdmin",
        name: "otherAdmin",
        isAdministrator: true,
        isDisabled: false,
        status: "unchanged",
        before: ["电影", "剧集"],
        after: ["电影", "剧集"],
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
    expect(updateOrder).toHaveBeenCalledWith("admin", [anime.guid, films.guid, tv.guid]);
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

  it("verifies repeated sync without injected libraries and guards actual account changes", async () => {
    await save([anime.guid, films.guid, tv.guid, virtual.guid]);
    const first = await apply((await preview()).previewToken);
    expect(first.proxyActivated).toBe(true);
    expect(first.users.map(({ status }: { status: string }) => status)).toEqual([
      "updated",
      "unchanged",
      "updated",
      "unchanged",
    ]);
    updateOrder.mockClear();
    updateOrder.mockImplementation(async (id, orderedViews) => {
      preferences[id]!.orderedViews = orderedViews.filter((token) => token !== virtual.guid);
    });

    await save([virtual.guid, tv.guid, anime.guid, films.guid]);
    const second = await preview();
    views.admin!.reverse();
    preferences.member!.orderedViews.reverse();
    views.disabled!.push({ id: "108", guid: "22222222222222222222222222222222", name: "新增原生库" });

    const result = await apply(second.previewToken);
    expect(result.proxyActivated).toBe(true);
    expect(result.users).toEqual([
      expect.objectContaining({ id: "admin", status: "updated" }),
      expect.objectContaining({ id: "otherAdmin", status: "updated" }),
      expect.objectContaining({ id: "member", status: "skipped", reason: "library_order_user_changed" }),
      expect.objectContaining({ id: "disabled", status: "skipped", reason: "library_order_user_changed" }),
    ]);
    expect(second.users.find(({ id }) => id === "admin")).toMatchObject({
      after: [tv.name, anime.name, films.name],
      proxyAfter: [virtual.name, tv.name, anime.name, films.name],
    });
    expect(updateOrder).toHaveBeenCalledTimes(2);
    expect(updateOrder).toHaveBeenCalledWith("admin", [tv.guid, anime.guid, films.guid]);
    expect(updateOrder).toHaveBeenCalledWith("otherAdmin", [tv.guid, films.guid, virtual.guid]);
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

  it("orders proxy-injected libraries through the proxy without writing them to Emby", async () => {
    writeSettings(database.db, {
      "virtualLibraryProxy.enabled": true,
      "virtualLibraryProxy.upstream": "https://proxy.test",
    });
    const body = await (await request(endpoint)).json();
    expect(body.proxy).toEqual({
      configured: true,
      enabled: true,
      running: false,
      port: null,
      upstream: "https://proxy.test",
    });
    expect(body.libraries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "反代榜单库", kind: "proxy", direct: false, proxy: true }),
      ]),
    );
    await save([proxyOnly.guid, films.guid, tv.guid, anime.guid, virtual.guid, extras.guid, hidden.guid]);
    const previewBody = await preview();
    const admin = previewBody.users.find((row) => row.id === "admin")!;
    expect(admin.proxyAfter?.[0]).toBe("反代榜单库");
    expect(admin.before).not.toContain("反代榜单库");
    const applied = await apply(previewBody.previewToken);
    expect(applied.proxyActivated).toBe(true);
    expect(applied.proxyEnabled).toBe(true);
    expect(proxyUpdateOrder).not.toHaveBeenCalled();
    const directWrites = updateOrder.mock.calls.flatMap(([, order]) => order);
    expect(directWrites).not.toContain(proxyOnly.guid.replaceAll("-", "").toLowerCase());
    const active = database.db.select().from(appSettings).where(eq(appSettings.key, "emby.libraryOrder.active")).get();
    expect(JSON.parse(active!.value!).order).toContain(proxyOnly.guid.replaceAll("-", "").toLowerCase());
  });

  it("shows a failed proxy settings read separately while the account's direct preview still works", async () => {
    writeSettings(database.db, { "virtualLibraryProxy.upstream": "https://proxy.test" });
    await save([proxyOnly.guid, films.guid]);
    failProxyViews.add("member");

    const { users } = await preview();
    expect(users.find(({ id }) => id === "admin")?.proxyAfter?.[0]).toBe(proxyOnly.name);
    const member = users.find(({ id }) => id === "member");
    expect(member).toMatchObject({
      after: expect.arrayContaining([films.name]),
      proxyReason: "library_order_proxy_read_failed",
    });
    expect(member).not.toHaveProperty("proxyAfter");
  });

  it("reads the settings list separately when the proxy upstream is the same Emby address", async () => {
    writeSettings(database.db, { "virtualLibraryProxy.upstream": "https://emby.test/" });
    extraAdminSettings = [hidden];
    await save([hidden.guid, films.guid]);

    const admin = (await preview()).users.find(({ id }) => id === "admin");
    expect(admin?.after).not.toContain(hidden.name);
    expect(admin?.proxyBefore?.at(-1)).toBe(hidden.name);
    expect(admin?.proxyAfter?.[0]).toBe(hidden.name);
  });

  it("preserves the draft and active order when an unavailable or partial upstream hides a saved library", async () => {
    writeSettings(database.db, { "virtualLibraryProxy.upstream": "https://proxy.test" });
    await save([proxyOnly.guid, films.guid]);
    await apply((await preview()).previewToken);
    const readSaved = () =>
      ["emby.libraryOrder", "emby.libraryOrder.active"].map(
        (key) => database.db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value,
      );
    const saved = readSaved();
    expect(saved.every((value) => value?.includes(proxyOnly.guid.replaceAll("-", "")))).toBe(true);

    proxyConnection = undefined;
    const diagnostic = await (await request(endpoint)).json();
    expect(diagnostic.warnings.join(" ")).toContain("无法确认反代上游");
    expect(await (await request(endpoint, { order: [films.guid] }, cookie, 502)).json()).toEqual({
      error: "library_order_proxy_read_failed",
    });

    proxyConnection = {};
    failProxyFolders = true;
    failProxyViews.add("admin");
    for (const id of Object.keys(proxyViews)) proxyViews[id] = proxyViews[id]!.filter((view) => view !== proxyOnly);
    expect(await (await request(`${endpoint}/preview`, {}, cookie, 502)).json()).toEqual({
      error: "library_order_proxy_read_failed",
    });
    expect((await preview({ userIds: ["admin"] })).users[0]?.after).toContain(films.name);
    expect(readSaved()).toEqual(saved);
  });
});
