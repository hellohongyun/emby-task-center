import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbyClient } from "./emby-client";

const memberId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const adminId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const unknownId = "cccccccccccccccccccccccccccccccc";
const member = { Id: memberId, Name: "普通会员", Policy: { IsAdministrator: false, IsDisabled: true } };
const admin = { Id: adminId, Name: "管理员", Policy: { IsAdministrator: true, IsHidden: true } };
const unknown = { Id: unknownId, Name: "权限未知", Policy: null };

describe("native Emby automatic membership cleanup connector", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ method: string; path: string; token?: string }>;
  let details: Map<string, unknown>;
  let accountList: unknown;
  let listStatus: number;
  let serverInfo: unknown;
  let history: unknown;
  let sessions: unknown;
  let deleteStatus: number;
  let redirectPath: string | undefined;

  beforeEach(async () => {
    requests = [];
    details = new Map<string, unknown>([
      [memberId, member],
      [adminId, admin],
      [unknownId, unknown],
    ]);
    accountList = { Items: [member, admin, unknown], TotalRecordCount: 3 };
    listStatus = 200;
    serverInfo = { Id: "cleanup-fixture-server", ServerName: "Local fixture" };
    history = { Items: [], TotalRecordCount: 0 };
    sessions = [];
    deleteStatus = 204;
    redirectPath = undefined;
    server = createServer((request, response) => {
      const { method = "GET", url: path = "/" } = request;
      requests.push({ method, path, token: request.headers["x-emby-token"] as string | undefined });
      if (redirectPath === path) {
        response.writeHead(302, { location: "/redirected" }).end();
        return;
      }
      if (method === "DELETE") {
        response.writeHead(deleteStatus).end();
        return;
      }
      if (path.startsWith(`/emby/Users/${memberId}/Items?`) || path === "/emby/Sessions") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(path === "/emby/Sessions" ? sessions : history));
        return;
      }
      const body =
        path === "/emby/System/Info"
          ? serverInfo
          : path === "/emby/Users/Query"
            ? accountList
            : details.get(path.slice("/emby/Users/".length));
      const status = path === "/emby/Users/Query" ? listStatus : body === undefined ? 404 : 200;
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  const open = () => createEmbyClient({ baseUrl, apiKey: "loopback-fixture-token" }).openMemberCleanupSession!()!;

  it("checks authenticated server identity and lists all roles without hidden or disabled filters", async () => {
    const session = open();
    await expect(session.serverId()).resolves.toBe("cleanup-fixture-server");
    await expect(session.listAccounts()).resolves.toEqual([
      { id: memberId, name: member.Name, role: "ordinary" },
      { id: adminId, name: admin.Name, role: "administrator" },
      { id: unknownId, name: unknown.Name, role: "unknown" },
    ]);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /emby/System/Info",
      "GET /emby/Users/Query",
    ]);
    expect(requests.every(({ token }) => token === "loopback-fixture-token")).toBe(true);
    serverInfo = { Id: null };
    await expect(session.serverId()).rejects.toBeInstanceOf(Error);
  });

  it("requires a complete authorized account listing to corroborate a detail 404", async () => {
    const session = open();
    details.delete(memberId);
    await expect(session.readRole(memberId)).resolves.toBe("unknown");
    const dashedId = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
    accountList = { Items: [{ ...member, Id: dashedId }], TotalRecordCount: 1 };
    await expect(session.readRole(memberId)).resolves.toBe("unknown");
    accountList = { Items: [admin], TotalRecordCount: 2 };
    await expect(session.readRole(memberId)).rejects.toThrow("emby_cleanup_incomplete_accounts");
    accountList = { Items: [member, { ...member, Id: dashedId }], TotalRecordCount: 2 };
    await expect(session.readRole(memberId)).rejects.toThrow("emby_cleanup_incomplete_accounts");
    accountList = { Items: [admin], TotalRecordCount: 1 };
    listStatus = 403;
    await expect(session.readRole(memberId)).rejects.toThrow("emby_http_403");
    listStatus = 200;
    await expect(session.readRole(memberId)).resolves.toBe("missing");
  });

  it("reads the current role and runs the policy guard immediately before deleting the exact ordinary account", async () => {
    const session = open();
    const allowDelete = vi.fn(() => {
      expect(requests.at(-1)).toMatchObject({ method: "GET", path: `/emby/Users/${memberId}` });
      return true;
    });
    await session.deleteAccount(memberId, allowDelete);
    expect(allowDelete).toHaveBeenCalledTimes(1);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /emby/Users/${memberId}`,
      `DELETE /emby/Users/${memberId}`,
    ]);

    details.set(memberId, { ...member, Policy: { IsAdministrator: true } });
    await expect(session.deleteAccount(memberId)).rejects.toMatchObject({
      message: "emby_cleanup_not_ordinary",
      deleteStarted: false,
    });
    await expect(session.deleteAccount(unknownId)).rejects.toMatchObject({ deleteStarted: false });
    expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });

  it("never issues DELETE when a guard rejects, a target ID is unsafe or the detail response identifies another user", async () => {
    const session = open();
    await expect(session.deleteAccount(memberId, () => false)).rejects.toMatchObject({
      message: "emby_cleanup_cancelled",
      deleteStarted: false,
    });
    details.set("1", admin);
    await expect(session.deleteAccount("1")).rejects.toMatchObject({
      message: "emby_cleanup_role_unverified",
      deleteStarted: false,
    });
    await expect(session.deleteAccount("../Users")).rejects.toMatchObject({ deleteStarted: false });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
  });

  it("distinguishes a failed DELETE from a refused preflight and never follows redirects", async () => {
    const session = open();
    for (const status of [401, 403, 404, 503]) {
      deleteStatus = status;
      await expect(session.deleteAccount(memberId)).rejects.toMatchObject({ status, deleteStarted: true });
    }
    redirectPath = `/emby/Users/${memberId}`;
    await expect(session.deleteAccount(memberId)).rejects.toMatchObject({ deleteStarted: false });
    expect(requests.some(({ path }) => path === "/redirected")).toBe(false);
  });

  it("uses the newest user item data without excluding partially watched titles", async () => {
    const session = open();
    history = {
      Items: [{ Id: "partial", UserData: { Played: false, LastPlayedDate: "2026-11-08T08:30:00.1234567+08:00" } }],
      TotalRecordCount: 500,
    };
    await expect(session.readLastPlayed!(memberId)).resolves.toBe("2026-11-08T00:30:00.123Z");
    const url = new URL(requests[0]!.path, baseUrl);
    expect(url.pathname).toBe(`/emby/Users/${memberId}/Items`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      Recursive: "true",
      SortBy: "DatePlayed",
      SortOrder: "Descending",
      Limit: "1",
      EnableUserData: "true",
      Fields: "UserDataLastPlayedDate,UserDataPlayCount",
    });
    expect(url.searchParams.has("IsPlayed")).toBe(false);

    history = { Items: [], TotalRecordCount: 0 };
    await expect(session.readLastPlayed!(memberId)).resolves.toBeNull();
    history = { Items: [], TotalRecordCount: 1 };
    await expect(session.readLastPlayed!(memberId)).rejects.toThrow("incomplete_playback_history");
    history = { Items: [{ Id: "partial", UserData: { PlaybackPositionTicks: 100 } }], TotalRecordCount: 1 };
    await expect(session.readLastPlayed!(memberId)).rejects.toThrow("unverified_playback_history");
  });

  it("protects users in active and paused playback sessions, including additional users", async () => {
    const session = open();
    sessions = [
      { Id: "idle", UserId: unknownId },
      {
        Id: "paused",
        UserId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        AdditionalUsers: [{ UserId: adminId }],
        NowPlayingItem: { Id: "video" },
        PlayState: { IsPaused: true },
      },
    ];
    await expect(session.readPlaybackSessions!()).resolves.toEqual(new Set([memberId, adminId]));
    sessions = [{ Id: "unidentified", NowPlayingItem: { Id: "video" } }];
    await expect(session.readPlaybackSessions!()).rejects.toThrow("unidentified_playback_session");
  });

  it("refuses deletion after the asynchronous playback check fails or the account is promoted", async () => {
    const session = open();
    await expect(
      session.deleteAccount(
        memberId,
        () => true,
        async () => false,
      ),
    ).rejects.toMatchObject({
      deleteStarted: false,
    });
    await expect(
      session.deleteAccount(
        memberId,
        () => true,
        async () => {
          details.set(memberId, { ...member, Policy: { IsAdministrator: true } });
          return true;
        },
      ),
    ).rejects.toMatchObject({ deleteStarted: false });
    expect(requests.some(({ method }) => method === "DELETE")).toBe(false);
  });

  it("pins reads to the selected credentials, rotates identity and refuses a stale write", async () => {
    let apiKey: string | undefined = "first";
    const client = createEmbyClient({ resolve: () => ({ baseUrl, apiKey }) });
    const initial = client.openMemberCleanupSession!()!;
    expect(client.openMemberCleanupSession!()?.identity).toBe(initial.identity);
    apiKey = "second";
    const next = client.openMemberCleanupSession!()!;
    expect(next.identity).not.toBe(initial.identity);
    await expect(initial.deleteAccount(memberId)).rejects.toMatchObject({
      message: "emby_cleanup_cancelled",
      deleteStarted: false,
    });
    await next.deleteAccount(memberId);
    expect(requests.map(({ method, token }) => [method, token])).toEqual([
      ["GET", "first"],
      ["GET", "second"],
      ["DELETE", "second"],
    ]);
    apiKey = undefined;
    expect(client.openMemberCleanupSession!()).toBeUndefined();
  });
});
