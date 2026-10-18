import { describe, expect, it } from "vitest";

import type { LibraryItem, LibraryRoot, LibraryScan } from "../types";
import {
  buildUnmatchedReport,
  classifyUnmatched,
  collectGenres,
  collectYears,
  groupItems,
  posterUrlFor,
  summarizeLibrary,
} from "./work-groups";

const tvRoot: LibraryRoot = { id: "tv", name: "剧集", mediaType: "tv", lastScannedAt: "2026-08-11T08:00:00Z" };

function item(overrides: Partial<LibraryItem> & { relativePath: string }): LibraryItem {
  return {
    sourceTitle: null,
    sourceYear: null,
    posterPath: null,
    tags: [],
    genres: [],
    cast: [],
    recognitionStatus: "matched",
    identity: {
      physicalSeason: null,
      parsedSeason: null,
      episodeNumbers: [],
      absoluteEpisodeNumbers: [],
      numberingMode: "unresolved",
      warning: null,
    },
    ...overrides,
  } as LibraryItem;
}

describe("work groups", () => {
  it("groups by type, title and year, and keeps the first poster", () => {
    const groups = groupItems([
      item({ relativePath: "a/仙逆 S01E01.strm", sourceTitle: "仙逆", sourceYear: 2023, posterPath: "p1.jpg" }),
      item({ relativePath: "a/仙逆 S01E02.strm", sourceTitle: "仙逆", sourceYear: 2023, posterPath: "p2.jpg" }),
      item({ relativePath: "b/阿凡达 (2009).strm", sourceTitle: "阿凡达", sourceYear: 2009 }),
    ]);

    expect(groups).toHaveLength(2);
    const xianni = groups.find((group) => group.title === "仙逆")!;
    expect(xianni.items).toHaveLength(2);
    expect(xianni.posterPath).toBe("p1.jpg");
    // 电影与剧集同名单也不会合并（key 里带类型）
    expect(groups.find((group) => group.title === "阿凡达")!.isTv).toBe(false);
  });

  it("falls back to the file name when there is no source title", () => {
    const groups = groupItems([item({ relativePath: "电影/某片 (2024)/某片 2024 1080p.strm" })]);
    expect(groups[0]!.title).toBe("某片 2024 1080p");
    expect(groups[0]!.year).toBeNull();
  });

  it("derives resolution from tags and merges genres/cast without duplicates", () => {
    const groups = groupItems([
      item({
        relativePath: "a/片 A.strm",
        sourceTitle: "片A",
        tags: ["1080p", "HEVC", "1080p"],
        genres: ["动作", "动作"],
        cast: ["甲"],
      }),
      item({ relativePath: "a/片 A 2.strm", sourceTitle: "片A", tags: ["2160p"], genres: ["科幻"], cast: ["乙"] }),
    ]);

    expect(groups[0]!.resolution).toBe("2160p");
    expect(groups[0]!.tags).toEqual(["1080p", "HEVC", "2160p"]);
    expect(groups[0]!.genres).toEqual(["动作", "科幻"]);
    expect(groups[0]!.cast).toEqual(["甲", "乙"]);
  });

  it("summarizes files, works and the match ratio", () => {
    const scan: LibraryScan = {
      root: tvRoot,
      items: [
        item({ relativePath: "a/1.strm", sourceTitle: "一" }),
        item({ relativePath: "a/2.strm", sourceTitle: "一" }),
        item({ relativePath: "a/3.strm", sourceTitle: "二", recognitionStatus: "unresolved" }),
      ],
    };
    expect(summarizeLibrary([tvRoot], { tv: scan })).toEqual({
      totalFiles: 3,
      workCount: 2,
      matchedFiles: 2,
      unmatchedFiles: 1,
      matchRatio: 67,
      // 海报/题材覆盖率：媒体库页现在用这两项当门面指标（TMDB 匹配率是 STRM 时代的）
      posterFiles: 0,
      posterRatio: 0,
      missingGenreFiles: 3,
    });
    // 未扫描的目录不计入
    expect(summarizeLibrary([tvRoot], {}).totalFiles).toBe(0);
    expect(summarizeLibrary([tvRoot], {})).toMatchObject({ matchRatio: 0, posterRatio: 0 });
  });

  it("counts items that have an Emby poster and items whose genres are missing", () => {
    const scan: LibraryScan = {
      root: tvRoot,
      items: [
        item({ relativePath: "a/1.strm", sourceTitle: "有图", posterPath: "emby:1", genres: ["动画"] }),
        item({ relativePath: "a/2.strm", sourceTitle: "无图", posterPath: null, genres: [] }),
      ],
    };
    expect(summarizeLibrary([tvRoot], { tv: scan })).toMatchObject({
      totalFiles: 2,
      posterFiles: 1,
      posterRatio: 50,
      missingGenreFiles: 1,
    });
  });

  it("classifies why works are unmatched and sorts by count", () => {
    expect(classifyUnmatched("某片", null)).toBe("标题缺年份");
    expect(classifyUnmatched("电影-经典-123", 2020)).toBe("疑似分类目录误解析");
    expect(classifyUnmatched("Avatar 2009", 2009)).toBe("外语片名/缺中文别名");
    expect(classifyUnmatched("沙丘：第二部", 2024)).toBe("标题带分隔符（冒号）");
    expect(classifyUnmatched("普通名字", 2024)).toBe("其他/未知");

    const scan: LibraryScan = {
      root: tvRoot,
      items: [
        item({
          relativePath: "a/Avatar.strm",
          sourceTitle: "Avatar",
          sourceYear: 2009,
          recognitionStatus: "unresolved",
        }),
        item({ relativePath: "a/无名.strm", sourceTitle: "无名", recognitionStatus: "unresolved" }),
        item({ relativePath: "a/已匹配.strm", sourceTitle: "已匹配", recognitionStatus: "matched" }),
      ],
    };
    const report = buildUnmatchedReport([tvRoot], { tv: scan });
    expect(report.map((bucket) => bucket.label)).toEqual(["标题缺年份", "外语片名/缺中文别名"]);
    expect(report[0]!.count).toBe(1);
    expect(report[0]!.sample).toEqual(["无名"]);
  });

  it("collects filter options and builds poster URLs", () => {
    const scan: LibraryScan = {
      root: tvRoot,
      items: [
        item({ relativePath: "a/1.strm", sourceTitle: "一", sourceYear: 2023, genres: ["动作"] }),
        item({ relativePath: "a/2.strm", sourceTitle: "二", sourceYear: 2009, genres: ["科幻"] }),
      ],
    };
    expect(collectGenres({ tv: scan })).toEqual(["动作", "科幻"]);
    expect(collectYears({ tv: scan })).toEqual([2023, 2009]);

    expect(posterUrlFor(null)).toBeNull();
    // 非 Emby 引用（旧数据的磁盘路径）不再产出任何 URL：读磁盘的旁挂图链路已删除
    expect(posterUrlFor("a b/封面.jpg")).toBeNull();
  });
});

describe("poster URLs", () => {
  it("only ever produces the Emby proxy URL", () => {
    expect(posterUrlFor("emby:12345")).toBe("/api/library/emby-poster?id=12345");
    expect(posterUrlFor(null)).toBeNull();
    // 残缺引用与磁盘路径都不产出 URL（否则前端会去请求一个不存在的文件）
    expect(posterUrlFor("emby:")).toBeNull();
    expect(posterUrlFor("某剧/poster.jpg")).toBeNull();
  });
});
