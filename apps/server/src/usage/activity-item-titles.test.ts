import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryItems, mediaRoots } from "@emby-task-center/database/schema";
import { loadActivityItemTitles } from "./activity-log";

describe("activity titles limited to the current log batch", () => {
  let handle: DatabaseHandle;
  afterEach(() => {
    vi.restoreAllMocks();
    handle?.close();
  });

  function fixture() {
    handle = createDatabase(":memory:");
    const timestamp = new Date().toISOString();
    const root = handle.db
      .insert(mediaRoots)
      .values({
        name: "历史库",
        mediaType: "tv",
        containerPath: "/history",
        enabled: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    const add = (id: string, title: string, path = id) => {
      const targetRoot =
        path === id
          ? root
          : handle.db
              .insert(mediaRoots)
              .values({
                name: path,
                mediaType: "tv",
                containerPath: `/history/${path}`,
                enabled: false,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get();
      return handle.db
        .insert(libraryItems)
        .values({
          mediaRootId: targetRoot.id,
          relativePath: path,
          embyItemId: id,
          sourceTitle: title,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    };
    return { add };
  }

  it("does not read inventory for an empty batch and preserves historical title fallback", () => {
    const { add } = fixture();
    add("unrelated", "无关作品");
    add("wanted", "原标题");
    add("wanted", "后来的标题", "second-copy");
    add("wanted", "", "empty-copy");
    const select = vi.spyOn(handle.db, "select");
    expect(loadActivityItemTitles(handle.db, [])).toEqual(new Map());
    expect(loadActivityItemTitles(handle.db, [{ Id: 1, ItemId: null }])).toEqual(new Map());
    expect(select).not.toHaveBeenCalled();
    expect(
      loadActivityItemTitles(handle.db, [
        { Id: 2, ItemId: "wanted" },
        { Id: 3, ItemId: "wanted" },
        { Id: 4, ItemId: "missing" },
      ]),
    ).toEqual(new Map([["wanted", "后来的标题"]]));
  });

  it("supports batches larger than one query without returning unrelated inventory", () => {
    const { add } = fixture();
    add("unrelated", "无关作品");
    const entries = Array.from({ length: 501 }, (_, index) => {
      const id = `item-${index}`;
      add(id, `标题 ${index}`);
      return { Id: index, ItemId: id };
    });
    const titles = loadActivityItemTitles(handle.db, entries);
    expect(titles.size).toBe(501);
    expect(titles.get("item-500")).toBe("标题 500");
    expect(titles.has("unrelated")).toBe(false);
  });
});
