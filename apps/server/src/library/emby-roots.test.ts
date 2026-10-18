import { describe, expect, it, vi } from "vitest";

import type { EmbyClient } from "../integrations/emby-client";
import {
  createEmbyRootsSource,
  EMBY_LIBRARY_NOT_CONFIGURED,
  embyRootPath,
  libraryFolderToRoot,
  planRootSync,
} from "./emby-roots";
import type { LibraryRootConfig } from "./service";

const root = (id: string, name: string, mediaType: LibraryRootConfig["mediaType"] = "movie"): LibraryRootConfig => ({
  id,
  name,
  mediaType,
  path: embyRootPath(id),
});

describe("emby library folders to roots", () => {
  it("maps the three collection types and keeps the Emby library id as the root id", () => {
    expect(libraryFolderToRoot({ id: "127638", name: "动画电影", collectionType: "movies", locations: [] })).toEqual({
      id: "127638",
      name: "动画电影",
      mediaType: "movie",
      path: "emby:127638",
    });
    expect(
      libraryFolderToRoot({ id: "112667", name: "国产动漫", collectionType: "tvshows", locations: [] }).mediaType,
    ).toBe("tv");
    expect(libraryFolderToRoot({ id: "1", name: "混合", collectionType: "mixed", locations: [] }).mediaType).toBe(
      "mixed",
    );
  });

  it("loads the folders sorted by name and asks Emby every time", async () => {
    const listLibraryFolders = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "b", name: "欧美电影", collectionType: "movies", locations: [] },
        { id: "a", name: "国产电影", collectionType: "movies", locations: [] },
      ])
      .mockResolvedValueOnce([{ id: "a", name: "国产电影", collectionType: "movies", locations: [] }]);
    const source = createEmbyRootsSource({ configured: true, listLibraryFolders } as unknown as EmbyClient);

    expect((await source.load()).map((item) => item.name)).toEqual(["国产电影", "欧美电影"]);
    // 第二次调用重新问 Emby：Emby 侧删库后这里必须变少（实时映射）
    expect(await source.load()).toHaveLength(1);
    expect(listLibraryFolders).toHaveBeenCalledTimes(2);
  });

  it("refuses to answer when Emby is not configured instead of pretending the library is empty", async () => {
    const source = createEmbyRootsSource({ configured: false } as unknown as EmbyClient);
    await expect(source.load()).rejects.toThrow(EMBY_LIBRARY_NOT_CONFIGURED);
  });
});

describe("root sync plan", () => {
  it("splits into added / updated / removed by Emby library id", () => {
    const current = [root("1", "国产电影"), root("2", "欧美电影"), root("3", "老库")];
    const incoming = [root("1", "国产电影"), root("2", "欧美电影（改名）"), root("4", "新库", "tv")];

    const plan = planRootSync(current, incoming);
    expect(plan.added.map((item) => item.id)).toEqual(["4"]);
    expect(plan.updated.map((item) => item.id)).toEqual(["2"]);
    expect(plan.removed).toEqual(["3"]);
  });

  it("treats a rename as an update, never as a new library", () => {
    const plan = planRootSync([root("9", "旧名")], [root("9", "新名")]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.updated).toEqual([root("9", "新名")]);
  });

  it("reports nothing when Emby and the current roots agree", () => {
    const same = [root("1", "国产电影"), root("2", "国产剧集", "tv")];
    expect(planRootSync(same, [same[1]!, same[0]!])).toEqual({ added: [], updated: [], removed: [] });
  });

  it("treats every current root as removed when Emby returns nothing", () => {
    // 这是"删库跟随"的极端情况；调用方需自行判断是否属于 Emby 异常（返回空 ≠ 用户删光了库）
    expect(planRootSync([root("1", "A"), root("2", "B")], []).removed).toEqual(["1", "2"]);
  });
});
