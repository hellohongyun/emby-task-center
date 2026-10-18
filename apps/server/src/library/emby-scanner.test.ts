import { describe, expect, it } from "vitest";

import type { EmbyClient } from "../integrations/emby-client";
import { createEmbyScan, embyPosterItemId } from "./emby-scanner";
import { classifyItemMediaType } from "./scan-items";

describe("createEmbyScan", () => {
  it("maps a movie to one placeholder strm item", async () => {
    const emby = {
      configured: true,
      listLibraryItems: async () => [{ id: "m1", name: "钢铁侠", year: 2008, type: "movie", tmdbId: 1726 }],
      listItemEpisodes: async () => [],
    } as unknown as EmbyClient;

    const scan = createEmbyScan(emby);
    const { items, complete } = await scan("emby:127638");
    expect(complete).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]?.relativePath).toBe("钢铁侠/钢铁侠 [m1].strm");
    expect(items[0]?.identity.numberingMode).toBe("unresolved");
  });

  it("maps a series into one item per episode", async () => {
    const emby = {
      configured: true,
      listLibraryItems: async () => [{ id: "s1", name: "暗黑", year: 2017, type: "tv", tmdbId: 70523 }],
      listItemEpisodes: async () => [
        { id: "e1", seasonNumber: 1, episodeNumber: 1 },
        { id: "e2", seasonNumber: 1, episodeNumber: 2 },
        { id: "e3", seasonNumber: 2, episodeNumber: 1 },
      ],
    } as unknown as EmbyClient;

    const scan = createEmbyScan(emby);
    const { items, complete } = await scan("emby:112667");
    expect(complete).toBe(true);
    expect(items).toHaveLength(3);
    expect(items[0]?.relativePath).toBe("暗黑/Season 1/EP01 [e1].strm");
    expect(items[0]?.identity.episodeNumbers).toEqual([1]);
    expect(items[2]?.relativePath).toBe("暗黑/Season 2/EP01 [e3].strm");
  });

  it("asks Emby for that library only", async () => {
    const calls: Array<{ libraryId?: string } | undefined> = [];
    const emby = {
      configured: true,
      listLibraryItems: async (query?: { libraryId?: string }) => {
        calls.push(query);
        return [];
      },
      listItemEpisodes: async () => [],
    } as unknown as EmbyClient;

    await createEmbyScan(emby)("emby:119935");
    expect(calls).toEqual([{ libraryId: "119935" }]);
  });

  it("refuses to scan the whole server when the root has no library id", async () => {
    const emby = {
      configured: true,
      listLibraryItems: async () => [],
      listItemEpisodes: async () => [],
    } as unknown as EmbyClient;
    await expect(createEmbyScan(emby)("/media/strm")).rejects.toThrow("emby_library_id_missing");
  });
});

describe("synthetic path uniqueness", () => {
  it("keeps same-named works apart by embedding the Emby item id", async () => {
    // 真实库里同名不同年的重制版会撞唯一键 (root, relative_path)，整个库扫描回滚
    const emby = {
      configured: true,
      listLibraryItems: async () => [
        { id: "1001", name: "狮子王", year: 1994, type: "movie", tmdbId: 8587 },
        { id: "2002", name: "狮子王", year: 2019, type: "movie", tmdbId: 420818 },
      ],
      listItemEpisodes: async () => [],
    } as unknown as EmbyClient;

    const { items, complete } = await createEmbyScan(emby)("emby:127638");
    expect(complete).toBe(true);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.relativePath)).size).toBe(2);
    // 目录段保持干净（片名/年份从这里推断），id 只在文件名里
    expect(items.map((item) => item.relativePath.split("/")[0])).toEqual(["狮子王", "狮子王"]);
  });
});

describe("duplicate works in Emby", () => {
  it("lists a work once even when Emby holds several series entries sharing the same episodes", async () => {
    // 真实数据：「名侦探柯南」有 4 个剧集条目、指向同一批集
    const emby = {
      configured: true,
      listLibraryItems: async () => [
        { id: "s1", name: "名侦探柯南", year: 1996, type: "tv", tmdbId: 30984 },
        { id: "s2", name: "名侦探柯南", year: 1996, type: "tv", tmdbId: 30984 },
        { id: "s3", name: "名侦探柯南", year: 1996, type: "tv", tmdbId: 30984 },
      ],
      listItemEpisodes: async () => [
        { id: "e1", seasonNumber: 1, episodeNumber: 1 },
        { id: "e2", seasonNumber: 1, episodeNumber: 2 },
      ],
    } as unknown as EmbyClient;

    const { items, complete } = await createEmbyScan(emby)("emby:129008");
    expect(complete).toBe(true);
    // 同一部剧只出现一次，集不重复
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.relativePath)).size).toBe(2);
  });

  it("merges new episodes held by a later duplicate entry instead of dropping them", async () => {
    // 真实数据：中餐厅有 3 个条目，9 月 13 日新增的条目里装着 S10E11/E12 的新集 Id。
    const episodesBySeries: Record<
      string,
      Array<{ id: string; seasonNumber: number | null; episodeNumber: number; name: string | null }>
    > = {
      old1: [
        { id: "e1", seasonNumber: 10, episodeNumber: 9, name: "第 9 集" },
        { id: "e2", seasonNumber: 10, episodeNumber: 10, name: "第 10 集" },
      ],
      old2: [{ id: "e1", seasonNumber: 10, episodeNumber: 9, name: "第 9 集" }],
      fresh: [
        { id: "n1", seasonNumber: 10, episodeNumber: 11, name: "第 11 集" },
        { id: "n2", seasonNumber: 10, episodeNumber: 12, name: "第 12 集" },
      ],
    };
    const emby = {
      configured: true,
      listLibraryItems: async () => [
        { id: "old1", name: "中餐厅", year: 2017, type: "tv", tmdbId: 91914 },
        { id: "old2", name: "中餐厅", year: 2017, type: "tv", tmdbId: 91914 },
        { id: "fresh", name: "中餐厅", year: 2017, type: "tv", tmdbId: 91914 },
      ],
      listItemEpisodes: async (seriesId: string) => episodesBySeries[seriesId] ?? [],
    } as unknown as EmbyClient;

    const { items, complete } = await createEmbyScan(emby)("emby:112667");
    expect(complete).toBe(true);

    // 共享的 E9/E10 只算一次；重复条目里的新集 E11/E12 必须被收进来（否则缺集总览会误报）。
    expect(items.map((item) => item.relativePath)).toEqual([
      "中餐厅/Season 10/EP09 [e1].strm",
      "中餐厅/Season 10/EP10 [e2].strm",
      "中餐厅/Season 10/EP11 [n1].strm",
      "中餐厅/Season 10/EP12 [n2].strm",
    ]);
  });

  it("still keeps same-named works apart when their years differ", async () => {
    const emby = {
      configured: true,
      listLibraryItems: async () => [
        { id: "a", name: "狮子王", year: 1994, type: "movie", tmdbId: 8587 },
        { id: "b", name: "狮子王", year: 2019, type: "movie", tmdbId: 420818 },
      ],
      listItemEpisodes: async () => [],
    } as unknown as EmbyClient;

    const { items, complete } = await createEmbyScan(emby)("emby:127638");
    expect(complete).toBe(true);
    expect(items).toHaveLength(2);
  });
});

describe("poster references", () => {
  it("preserves the identity, metadata and TV type of empty same-named series", async () => {
    const emby = {
      configured: true,
      listLibraryItems: async () => [
        {
          id: "old",
          name: "Empty show",
          year: 1999,
          type: "tv",
          tmdbId: 10,
          hasPrimaryImage: true,
          genres: ["Drama"],
          dateCreated: "2026-10-03",
        },
        { id: "new", name: "Empty show", year: 2024, type: "tv", tmdbId: 20 },
      ],
      listItemEpisodes: async () => [],
    } as unknown as EmbyClient;
    const { items, complete } = await createEmbyScan(emby)("emby:root");
    expect(complete).toBe(true);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.relativePath)).size).toBe(2);
    expect(items.map((item) => item.embyItemId)).toEqual(["old", "new"]);
    expect(items.map((item) => item.sourceYearHint)).toEqual([1999, 2024]);
    expect(items.map((item) => classifyItemMediaType(item.identity, item.relativePath))).toEqual(["tv", "tv"]);
    expect(items[0]).toMatchObject({
      sourceTitleHint: "Empty show",
      tmdbId: 10,
      posterPath: "emby:old",
      genres: ["Drama"],
      fileModifiedAt: "2026-10-03",
    });
    expect(items.every((item) => item.identity.episodeNumbers.length === 0)).toBe(true);
  });

  it("points the inventory at Emby's image endpoint instead of a disk file", async () => {
    const emby = {
      configured: true,
      listLibraryItems: async () => [
        { id: "m1", name: "钢铁侠", year: 2008, type: "movie", tmdbId: 1726, hasPrimaryImage: true },
        { id: "m2", name: "没有海报的片", year: 2009, type: "movie", tmdbId: 1, hasPrimaryImage: false },
      ],
      listItemEpisodes: async () => [],
    } as unknown as EmbyClient;

    const { items, complete } = await createEmbyScan(emby)("emby:127638");
    expect(complete).toBe(true);
    expect(items[0]?.posterPath).toBe("emby:m1");
    expect(items[1]?.posterPath).toBeUndefined();
    expect(embyPosterItemId(items[0]?.posterPath)).toBe("m1");
    expect(embyPosterItemId(items[1]?.posterPath)).toBeNull();
    expect(embyPosterItemId("电影/某片/poster.jpg")).toBeNull();
  });

  it("reuses the series image for every episode of that series", async () => {
    const emby = {
      configured: true,
      listLibraryItems: async () => [
        { id: "s9", name: "暗黑", year: 2017, type: "tv", tmdbId: 70523, hasPrimaryImage: true },
      ],
      listItemEpisodes: async () => [
        { id: "e1", seasonNumber: 1, episodeNumber: 1 },
        { id: "e2", seasonNumber: 1, episodeNumber: 2 },
      ],
    } as unknown as EmbyClient;

    const { items, complete } = await createEmbyScan(emby)("emby:112667");
    expect(complete).toBe(true);
    expect(items.map((item) => item.posterPath)).toEqual(["emby:s9", "emby:s9"]);
  });
});
