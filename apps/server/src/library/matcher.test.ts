import { describe, expect, it } from "vitest";

import type { MediaItemRow } from "@emby-task-center/database/schema";
import { inferSourceIdentity, matchMedia } from "./matcher";

function item(overrides: Partial<MediaItemRow> & { title: string; id?: number }): MediaItemRow {
  const { title, ...rest } = overrides;
  return {
    id: rest.id ?? 1,
    tmdbId: 1,
    mediaType: "tv",
    title,
    originalTitle: null,
    aliases: [],
    releaseYear: null,
    overview: null,
    posterUrl: null,
    backdropUrl: null,
    genres: [],
    languages: [],
    regions: [],
    platforms: [],
    seasonCount: null,
    episodeCount: null,
    mappedRootId: null,
    mappedFolderPath: null,
    imdbId: null,
    doubanId: null,
    externalIds: {},
    tmdbPayload: {},
    syncedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...rest,
  };
}

describe("media title matching", () => {
  it("matches exact normalized titles", () => {
    expect(matchMedia({ title: "仙逆", year: 2023 }, [item({ title: "仙逆", releaseYear: 2023 })])?.confidence).toBe(1);
    expect(matchMedia({ title: "仙逆", year: null }, [item({ title: "仙逆" })])?.confidence).toBe(0.9);
  });

  it("treats Roman numeral and Arabic numeral titles as the same", () => {
    const candidates = [item({ title: "斗罗大陆Ⅱ绝世唐门", releaseYear: 2023 })];
    expect(matchMedia({ title: "斗罗大陆2：绝世唐门", year: 2023 }, candidates)?.mediaItemId).toBe(1);
    expect(matchMedia({ title: "斗罗大陆II绝世唐门", year: 2023 }, candidates)?.mediaItemId).toBe(1);
    expect(matchMedia({ title: "斗罗大陆2绝世唐门", year: 2023 }, candidates)?.mediaItemId).toBe(1);
  });

  it("matches a shorter folder title as a prefix when years agree", () => {
    const candidates = [item({ title: "斗罗大陆Ⅱ绝世唐门", releaseYear: 2023 })];
    expect(matchMedia({ title: "斗罗大陆2", year: 2023 }, candidates)?.confidence).toBe(0.75);
  });

  it("allows an explicit alias to override a year conflict", () => {
    const candidates = [item({ id: 1, title: "斗破苍穹", releaseYear: 2018, aliases: ["斗破苍穹：年番"] })];
    expect(matchMedia({ title: "斗破苍穹：年番", year: 2022 }, candidates)?.mediaItemId).toBe(1);
  });

  it("rejects prefix matches when years conflict", () => {
    const candidates = [item({ title: "斗罗大陆Ⅱ绝世唐门", releaseYear: 2023 })];
    expect(matchMedia({ title: "斗罗大陆", year: 2018 }, candidates)).toBeNull();
  });

  it("rejects a first-season prefix against a numeric-continuation title", () => {
    const candidates = [item({ title: "斩神之凡尘神域Ⅱ", releaseYear: 2026 })];
    expect(matchMedia({ title: "斩神之凡尘神域", year: 2026 }, candidates)).toBeNull();
  });

  it("matches a source title against a manual alias", () => {
    const candidates = [item({ title: "斗破苍穹年番第五季", aliases: ["斗破苍弯年番"], releaseYear: 2025 })];
    expect(matchMedia({ title: "斗破苍弯年番", year: 2025 }, candidates)?.mediaItemId).toBe(1);
    expect(matchMedia({ title: "斗破苍弯年番", year: 2025 }, candidates)?.confidence).toBe(1);
  });

  it("prefers a manual alias exact match over a partial prefix match", () => {
    const candidates = [
      item({ id: 1, title: "斗破苍穹年番第五季", aliases: ["斗破苍弯年番"], releaseYear: 2025 }),
      item({ id: 2, title: "斗破苍弯年番外篇", releaseYear: 2025 }),
    ];
    expect(matchMedia({ title: "斗破苍弯年番", year: 2025 }, candidates)?.mediaItemId).toBe(1);
  });

  it("stays unresolved when several items match exactly", () => {
    const candidates = [
      item({ id: 1, title: "仙逆", releaseYear: 2023 }),
      item({ id: 2, title: "仙逆特别篇", aliases: ["仙逆"], releaseYear: 2023 }),
    ];
    expect(matchMedia({ title: "仙逆", year: 2023 }, candidates)).toBeNull();
  });

  it("does not match titles that are too short or too small a fraction", () => {
    expect(matchMedia({ title: "龙", year: 2023 }, [item({ title: "斗罗大陆" })])).toBeNull();
    expect(
      matchMedia({ title: "斗罗大陆", year: 2023 }, [item({ title: "斗罗大陆之神界传说", releaseYear: 2023 })]),
    ).toBeNull();
  });

  it("extracts source identity and skips classification folders", () => {
    expect(
      inferSourceIdentity("更新-动漫-123/斗罗大陆2：绝世唐门 (2023)/Season 01/斗罗大陆2：绝世唐门 (2023) S01E01.strm"),
    ).toEqual({ title: "斗罗大陆2：绝世唐门", year: 2023 });
  });

  it("truncates release-group folder names at the first bracketed year", () => {
    expect(
      inferSourceIdentity(
        "电影-杜比视界-123/阿凡达 (2009) Avatar 2009 USA BluRay Remux UHD DoVi HDR10 2160p Atmos TrueHD7.1-DreamHD/阿凡达 (2009) Avatar 2009 USA BluRay Remux UHD DoVi HDR10 2160p Atmos TrueHD7.1-DreamHD.strm",
      ),
    ).toEqual({ title: "阿凡达", year: 2009 });
    expect(
      inferSourceIdentity(
        "电影-杜比视界-123/阿凡达：水之道 (2022) Avatar.The.Way.of.Water.2022.2160p.REPACK.UHD.BluRay.REMUX.DV.HDR.HEVC.Atmos-TRiToN/阿凡达：水之道 (2022) Avatar.The.Way.of.Water.2022.2160p.REPACK.UHD.BluRay.REMUX.DV.HDR.HEVC.Atmos-TRiToN.strm",
      ),
    ).toEqual({ title: "阿凡达：水之道", year: 2022 });
  });

  it("extracts a separator-bounded year from filenames without brackets", () => {
    expect(inferSourceIdentity("Show.2020.1080p.strm")).toEqual({ title: "Show", year: 2020 });
  });

  it("extracts source identity from the new tgtodrive nested structure", () => {
    expect(
      inferSourceIdentity(
        "光鸭云盘/天鸿影视/剧集/其他剧集/2026/迷途善人 (2026) {tmdb-304210}/Season 1/迷途善人.2026.S01E03.第3集.1080p.Netflix.WEB-DL.SDR.H.264.25fps.AAC 2.0-BlackTV.strm",
      ),
    ).toEqual({ title: "迷途善人", year: 2026 });
    expect(
      inferSourceIdentity(
        "123云盘/天鸿影视/电影/欧美电影/1975/巴里·林登 (1975) {tmdb-3175}/巴里·林登 (1975) - 2160p.BluRay REMUX.DoVi P7.H.265.10-bit.23.976fps.DTS 5.1.strm",
      ),
    ).toEqual({ title: "巴里·林登", year: 1975 });
  });
});
