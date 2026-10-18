import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createProxyMappingRepair } from "./proxy-mapping-repair";
import { createVirtualLibraryStore, type VirtualLibraryStore } from "./store";
import type { QueryUpstream, UpstreamJson } from "./query-helpers";

const item = { itemId: "series", name: "已选择剧集", type: "Series", tmdbId: "223911", year: 2023, imageTag: null };
const dto = { Id: item.itemId, Name: item.name, Type: item.type, ProviderIds: { Tmdb: item.tmdbId } };
const ok = (items = [dto]): UpstreamJson => ({ status: 200, headers: {}, body: { Items: items } });
const request = (headers: IncomingHttpHeaders = {}) => ({ headers, aborted: false }) as IncomingMessage;

describe("client mapping check cache", () => {
  let handle: DatabaseHandle;
  let store: VirtualLibraryStore;
  let id: string;
  let repair: ReturnType<typeof createProxyMappingRepair>;
  let upstream: ReturnType<typeof vi.fn<QueryUpstream>>;
  beforeEach(() => {
    handle = createDatabase(":memory:");
    store = createVirtualLibraryStore(handle.db);
    id = store.create({ name: "剧集精选", collectionType: "tvshows" }).id;
    store.addItems(id, [item]);
    repair = createProxyMappingRepair(store);
    upstream = vi.fn<QueryUpstream>().mockResolvedValue(ok());
  });
  afterEach(() => {
    vi.useRealTimers();
    handle.close();
  });
  const url = (path = "/Users/client/Items", search = "") => new URL(`http://proxy.local${path}?${search}`);
  const token = { "x-emby-token": "client-token" };
  const call = (
    target = url(),
    headers: IncomingHttpHeaders = token,
    base = "http://upstream.local",
    signal?: AbortSignal,
  ) => repair(id, request(headers), target, base, upstream, signal);

  it("shares the check across pagination, filtering, detail and unrelated browser headers", async () => {
    await call(url("/Users/client/Items", "StartIndex=0&IncludeItemTypes=Series"), {
      ...token,
      accept: "application/json",
    });
    await call(url("/Users/client/Items", "StartIndex=50&Genres=Animation"), {
      ...token,
      accept: "image/avif",
      origin: "http://browser",
      "user-agent": "another browser",
    });
    await call(url(`/Users/client/Items/${id}`), { ...token, "cache-control": "no-cache" });
    await call(url("/Items", "UserId=client&Limit=1"));
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["user", "/Users/another/Items", token, "http://upstream.local"],
    ["token", "/Users/client/Items", { "x-emby-token": "different" }, "http://upstream.local"],
    ["authorization", "/Users/client/Items", { ...token, authorization: "Bearer different" }, "http://upstream.local"],
    ["cookie", "/Users/client/Items", { ...token, cookie: "session=different" }, "http://upstream.local"],
    [
      "emby authorization",
      "/Users/client/Items",
      { ...token, "x-emby-authorization": 'Emby UserId="another"' },
      "http://upstream.local",
    ],
    ["upstream", "/Users/client/Items", token, "http://another-upstream.local"],
    ["unspecified user", "/Items", token, "http://upstream.local"],
  ] as const)("isolates a changed %s context", async (_label, path, headers, base) => {
    await call();
    await call(url(path), headers, base);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("normalizes credential parameter casing and keeps different credentials isolated", async () => {
    await call(url("/Items", "API_KEY=one&UserId=client"));
    await call(url("/Users/client/Items", "api_key=one&Limit=20"));
    expect(upstream).toHaveBeenCalledTimes(1);
    await call(url("/Users/client/Items", "Api_Key=two"));
    await call(url("/Users/client/Items", "Token=another"));
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("shares concurrent checks and invalidates when mappings are added or removed", async () => {
    let resolve!: (value: UpstreamJson) => void;
    upstream.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = call();
    const second = call(url("/Users/client/Items", "Limit=100"));
    expect(upstream).toHaveBeenCalledTimes(1);
    resolve(ok());
    await Promise.all([first, second]);
    const added = { ...item, itemId: "another", tmdbId: "99" };
    store.addItems(id, [added]);
    upstream.mockResolvedValue(ok([dto, { ...dto, Id: added.itemId, ProviderIds: { Tmdb: "99" } }]));
    await call();
    expect(upstream).toHaveBeenCalledTimes(2);
    store.removeItem(id, item.itemId);
    await call();
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("does not immediately repeat a successful check after learning identity or replacing an ID", async () => {
    upstream.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([{ ...dto, Id: "replacement" }]));
    await call();
    expect(store.listItems(id)[0]?.itemId).toBe("replacement");
    await call(url(`/Users/client/Items/${id}`));
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not cache a concurrently added mapping that the original check never examined", async () => {
    let resolve!: (value: UpstreamJson) => void;
    upstream.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = call();
    store.addItems(id, [{ ...item, itemId: "new", tmdbId: "99" }]);
    resolve(ok());
    await first;
    upstream.mockResolvedValue(ok([dto, { ...dto, Id: "new", ProviderIds: { Tmdb: "99" } }]));
    await call();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("retries after failed or denied checks instead of caching them", async () => {
    upstream.mockResolvedValueOnce({ status: 401, headers: {}, body: "denied" });
    await call();
    await call();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("lets an active waiter retry with its own upstream after the owner's request is canceled", async () => {
    const controller = new AbortController();
    upstream.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
        }),
    );
    const owner = call(url(), token, "http://upstream.local", controller.signal);
    const waiterUpstream = vi.fn<QueryUpstream>().mockResolvedValue(ok());
    const waiter = repair(id, request(token), url(), "http://upstream.local", waiterUpstream);
    controller.abort();
    await Promise.all([owner, waiter]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(waiterUpstream).toHaveBeenCalledTimes(1);
    await call();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("expires successful checks after 30 seconds", async () => {
    vi.useFakeTimers();
    await call();
    await vi.advanceTimersByTimeAsync(30_001);
    await call();
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
