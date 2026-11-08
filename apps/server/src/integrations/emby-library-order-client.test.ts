import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbyClient } from "./emby-client";

const userId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const dramaGuid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const filmsGuid = "cccccccccccccccccccccccccccccccc";
const hiddenGuid = "dddddddddddddddddddddddddddddddd";
const user = { Id: userId, Name: "会员", Policy: { IsAdministrator: false } };

describe("native Emby library order connector", () => {
  let server: Server;
  let baseUrl: string;
  let detail: unknown;
  let views: unknown;
  let writeStatus: number;
  let requests: Array<{ path: string; method: string; token?: string; contentType?: string; body: string }>;

  beforeEach(async () => {
    requests = [];
    detail = {
      ...user,
      Configuration: {
        OrderedViews: [dramaGuid, filmsGuid],
        MyMediaExcludes: [hiddenGuid],
        AudioLanguagePreference: "eng",
        HidePlayedInLatest: true,
      },
    };
    views = {
      Items: [
        { Id: "101", Guid: dramaGuid, Name: "剧集" },
        { Id: "102", Guid: filmsGuid, Name: "电影" },
      ],
      TotalRecordCount: 2,
    };
    writeStatus = 204;
    server = createServer(async (request, response) => {
      const path = request.url!;
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(chunk);
      requests.push({
        path,
        method: request.method!,
        token: request.headers["x-emby-token"] as string | undefined,
        contentType: request.headers["content-type"],
        body: Buffer.concat(body).toString(),
      });
      if (path === `/emby/Users/${userId}/Configuration/Partial?reqformat=json`) {
        response.writeHead(writeStatus).end();
        return;
      }
      const data =
        path === "/emby/Users"
          ? [user]
          : path === "/emby/Library/VirtualFolders"
            ? [{ ItemId: "101", Name: "剧集", CollectionType: "tvshows" }]
            : path === "/emby/Library/MediaFolders"
              ? { Items: [{ Id: "101", Name: "剧集", Guid: dramaGuid }] }
              : path === `/emby/Users/${userId}`
                ? detail
                : path.startsWith(`/emby/Users/${userId}/Views?`)
                  ? views
                  : undefined;
      response.writeHead(data === undefined ? 404 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
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

  function open() {
    return createEmbyClient({ baseUrl, apiKey: "local-admin-key" }).openLibraryOrderSession!()!;
  }

  it("reads visible native library IDs and posts only OrderedViews with Emby Web's partial format", async () => {
    const session = open();
    await expect(session.listUsers()).resolves.toEqual([user]);
    await expect(session.getUserPreferences(userId)).resolves.toEqual({
      isAdministrator: false,
      orderedViews: [dramaGuid, filmsGuid],
      hiddenViews: [hiddenGuid],
    });
    await expect(session.listUserViews(userId)).resolves.toEqual([
      { id: "101", guid: dramaGuid, name: "剧集" },
      { id: "102", guid: filmsGuid, name: "电影" },
    ]);
    await expect(session.listServerLibraries()).resolves.toEqual([
      { id: "101", name: "剧集", collectionType: "tvshows" },
    ]);
    await expect(session.listMediaFolders()).resolves.toEqual([{ id: "101", name: "剧集", guid: dramaGuid }]);
    expect(requests[2]?.path).toBe(
      `/emby/Users/${userId}/Views?IncludeExternalContent=false&IncludeHidden=false&AllowDynamicChildren=false`,
    );
    expect(requests.every(({ method }) => method === "GET")).toBe(true);

    await session.updateOrder(userId, [filmsGuid, dramaGuid]);
    expect(requests.at(-1)).toEqual({
      path: `/emby/Users/${userId}/Configuration/Partial?reqformat=json`,
      method: "POST",
      token: "local-admin-key",
      contentType: "text/plain",
      body: JSON.stringify({ OrderedViews: [filmsGuid, dramaGuid] }),
    });
  });

  it("defaults empty preferences and rejects ambiguous roles, malformed lists and mismatched users", async () => {
    const session = open();
    detail = { ...user, Configuration: { OrderedViews: null } };
    await expect(session.getUserPreferences(userId)).resolves.toEqual({
      isAdministrator: false,
      orderedViews: [],
      hiddenViews: [],
    });
    for (const candidate of [
      { ...user, Configuration: { OrderedViews: [123] } },
      { ...user, Configuration: null },
      { ...user, Configuration: {}, Policy: {} },
      { ...user, Configuration: {}, Id: "different" },
    ]) {
      detail = candidate;
      await expect(session.getUserPreferences(userId)).rejects.toBeInstanceOf(Error);
    }
    views = { Items: [{ Id: "101", Name: "剧集" }], TotalRecordCount: 2 };
    await expect(session.listUserViews(userId)).rejects.toThrow("emby_incomplete_views");
  });

  it("never falls back to a full configuration write when the partial endpoint fails", async () => {
    writeStatus = 404;
    await expect(open().updateOrder(userId, [filmsGuid, dramaGuid])).rejects.toThrow("emby_http_404");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toContain("/Configuration/Partial");
  });

  it("pins credentials for an open session and rotates the opaque identity when settings change", async () => {
    let apiKey: string | undefined = "first";
    const client = createEmbyClient({ resolve: () => ({ baseUrl, apiKey }) });
    const session = client.openLibraryOrderSession!()!;
    expect(client.openLibraryOrderSession!()?.identity).toBe(session.identity);
    apiKey = "second";
    const replacement = client.openLibraryOrderSession!()!;
    expect(replacement.identity).not.toBe(session.identity);
    await session.listUsers();
    await replacement.listUsers();
    expect(requests.map(({ token }) => token)).toEqual(["first", "second"]);

    apiKey = undefined;
    expect(client.openLibraryOrderSession!()).toBeUndefined();
    apiKey = "first";
    expect(client.openLibraryOrderSession!()?.identity).not.toBe(session.identity);
  });
});
