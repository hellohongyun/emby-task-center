import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { writeSettings } from "../settings/store";
import { createVirtualLibrarySource } from "./source";

describe("live Emby virtual library source", () => {
  let database: DatabaseHandle;
  beforeEach(() => {
    database = createDatabase(":memory:");
    writeSettings(database.db, { "emby.baseUrl": "http://emby.test/emby/", "emby.apiKey": "secret-token" });
  });
  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  it("queries actual Emby independently of local inventory and forwards pagination and optional filters", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        Items: [{ Id: "1", Name: "整部剧", Type: "Series", ProductionYear: 2020, ImageTags: { Primary: "image" } }],
        TotalRecordCount: 99,
      }),
    );
    const source = createVirtualLibrarySource(database.db, fetcher);
    const result = await source.search({
      searchTerm: "你好",
      parentId: "disabled-local-root",
      startIndex: 25,
      limit: 25,
    });
    expect(result).toEqual({
      items: [{ itemId: "1", name: "整部剧", type: "Series", year: 2020, imageTag: "image" }],
      total: 99,
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("/emby/Items?");
    expect(new URL(String(url)).searchParams.get("ParentId")).toBe("disabled-local-root");
    expect(new URL(String(url)).searchParams.get("IncludeItemTypes")).toBe("Movie,Series");
    expect(new URL(String(url)).searchParams.get("StartIndex")).toBe("25");
    expect(new URL(String(url)).searchParams.get("Fields")).toBe("ProductionYear,ProviderIds");
    expect(init?.headers).toMatchObject({ "X-Emby-Token": "secret-token" });
    expect(String(url)).not.toContain("secret-token");
    writeSettings(database.db, { "emby.baseUrl": "http://new.test" });
    await source.search({ types: "Series" });
    expect(String(fetcher.mock.calls[1][0])).toContain("http://new.test/Items?");
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("IncludeItemTypes")).toBe("Series");
  });

  it("deduplicates ID queries, restores selection order and rejects missing upstream items", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        Items: [
          { Id: "b", Name: "B" },
          { Id: "a", Name: "A" },
        ],
      }),
    );
    const source = createVirtualLibrarySource(database.db, fetcher);
    expect((await source.getItems(["a", "b", "a"])).map((item) => item.itemId)).toEqual(["a", "b"]);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("Ids")).toBe("a,b");
    await expect(source.getItems(["missing"])).rejects.toThrow("部分所选条目已不存在");
  });

  it("reads real source libraries and handles bad responses without exposing upstream secrets", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{ ItemId: "root", Name: "原库" }]))
      .mockResolvedValueOnce(new Response("secret-token", { status: 401 }))
      .mockResolvedValueOnce(new Response("invalid JSON"))
      .mockRejectedValueOnce(new Error("http://secret-token@example.test"));
    const source = createVirtualLibrarySource(database.db, fetcher);
    expect(await source.libraries()).toEqual([{ id: "root", name: "原库" }]);
    await expect(source.search({})).rejects.toThrow("HTTP 401");
    await expect(source.search({})).rejects.toThrow("无效的 JSON");
    await expect(source.search({})).rejects.toThrow("无法连接 Emby");
  });

  it("tolerates missing IDs for reconciliation, filters unsolicited results and normalizes provider identities", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        Items: [
          { Id: "current", Name: "剧集", Type: "Series", ProviderIds: { Tmdb: " 00123 " } },
          { Id: "unsolicited", Name: "其他", ProviderIds: { Tmdb: "456" } },
          { Id: "invalid", Name: "无编号", ProviderIds: { Tmdb: "-123" } },
        ],
      }),
    );
    const source = createVirtualLibrarySource(database.db, fetcher);
    expect(await source.lookupItems(["missing", "current", "invalid", "current"])).toEqual([
      { itemId: "current", name: "剧集", type: "Series", year: null, imageTag: null, tmdbId: "123" },
      { itemId: "invalid", name: "无编号", type: "", year: null, imageTag: null },
    ]);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("Fields")).toContain("ProviderIds");
    const calls = fetcher.mock.calls.length;
    expect(await source.lookupItems([])).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    await expect(source.getItems(["missing"])).rejects.toThrow("部分所选条目已不存在");
  });

  it("paginates provider lookup even when the upstream total is incorrectly zero", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          Items: Array.from({ length: 100 }, (_, index) => ({
            Id: `valid-${index}`,
            Name: "相同作品",
            Type: "Series",
            ProviderIds: { Tmdb: "123" },
          })),
          TotalRecordCount: 0,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          Items: [{ Id: "valid-b", Name: "另一来源", Type: "Series", ProviderIds: { Tmdb: "00123" } }],
          TotalRecordCount: 0,
        }),
      );
    const source = createVirtualLibrarySource(database.db, fetcher);
    const result = await source.findByTmdb("Series", "00123");
    expect(result).toHaveLength(101);
    expect(result.at(-1)?.itemId).toBe("valid-b");
    const params = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(params.get("AnyProviderIdEquals")).toBe("Tmdb.123");
    expect(params.get("IncludeItemTypes")).toBe("Series");
    expect(params.get("SearchTerm")).toBeNull();
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("StartIndex")).toBe("100");
    expect(await source.findByTmdb("Series", "0")).toEqual([]);
    expect(await source.findByTmdb("Episode", "123")).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { Type: "Movie", ProviderIds: { Tmdb: "123" } },
    { Type: "Series", ProviderIds: { Tmdb: "999" } },
    { Type: "Series", ProviderIds: {} },
  ])("rejects ignored upstream identity filters instead of scanning the entire catalogue: %j", async (identity) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        Items: [{ Id: "wrong", Name: "同名也不能重绑", ...identity }],
        TotalRecordCount: 999999,
      }),
    );
    await expect(createVirtualLibrarySource(database.db, fetcher).findByTmdb("Series", "123")).rejects.toThrow(
      "未正确执行作品身份筛选",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects nonadvancing provider pagination rather than silently resolving an incomplete candidate set", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        Items: Array.from({ length: 100 }, (_, index) => ({
          Id: `same-${index}`,
          Name: "重复页",
          Type: "Series",
          ProviderIds: { Tmdb: "123" },
        })),
        TotalRecordCount: 200,
      }),
    );
    await expect(createVirtualLibrarySource(database.db, fetcher).findByTmdb("Series", "123")).rejects.toThrow(
      "重复的分页结果",
    );
  });

  it("aborts requests on timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const outcome = createVirtualLibrarySource(database.db, fetcher).search({});
    const assertion = expect(outcome).rejects.toThrow("Emby 请求超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});
