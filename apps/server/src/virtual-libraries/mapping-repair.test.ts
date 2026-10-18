import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import type { VirtualLibraryItem } from "@emby-task-center/contracts/virtual-library";
import { repairVirtualMappings, type MappingSource } from "./mapping-repair";
import { createVirtualLibraryStore, type VirtualLibraryStore } from "./store";

const old: VirtualLibraryItem = {
  itemId: "old",
  name: "已选择剧集",
  type: "Series",
  year: 2023,
  imageTag: "poster",
  tmdbId: "223911",
};
const replacement = { ...old, itemId: "new", name: "上游新片名" };
describe("stable virtual mapping repair", () => {
  let handle: DatabaseHandle;
  let store: VirtualLibraryStore;
  let id: string;
  let source: MappingSource;
  beforeEach(() => {
    handle = createDatabase(":memory:");
    store = createVirtualLibraryStore(handle.db);
    id = store.create({ name: "剧集精选", collectionType: "tvshows" }).id;
    store.addItems(id, [old]);
    source = { lookupItems: vi.fn().mockResolvedValue([]), findByTmdb: vi.fn().mockResolvedValue([replacement]) };
  });
  afterEach(() => handle.close());

  it("rebinds a missing ID to the single proven type/TMDB match and persists it", async () => {
    const another = store.create({ name: "另一个虚拟库", collectionType: "tvshows" });
    store.addItems(another.id, [old]);
    const response = await repairVirtualMappings(store, id, source);
    expect(response).toEqual({ items: [replacement], issues: [] });
    expect(store.get(id)?.itemCount).toBe(1);
    expect(store.listItems(another.id)).toEqual([old]);
    expect(source.findByTmdb).toHaveBeenCalledWith("Series", "223911");
  });

  it("learns a stable provider identity only while the original ID and type still match", async () => {
    const { tmdbId: _tmdbId, ...legacy } = old;
    store.removeItem(id, old.itemId);
    store.addItems(id, [legacy]);
    source.lookupItems = vi.fn().mockResolvedValue([old]);
    expect(await repairVirtualMappings(store, id, source)).toEqual({ items: [old], issues: [] });
    expect(source.findByTmdb).not.toHaveBeenCalled();
  });

  it.each([
    { candidates: [], reason: "missing" },
    { candidates: [replacement, { ...replacement, itemId: "another" }], reason: "ambiguous" },
    {
      candidates: [
        { ...replacement, type: "Movie" },
        { ...replacement, tmdbId: "999" },
      ],
      reason: "missing",
    },
  ])("keeps mappings when a match is not uniquely proven: $reason", async ({ candidates, reason }) => {
    source.findByTmdb = vi.fn().mockResolvedValue(candidates);
    const result = await repairVirtualMappings(store, id, source);
    expect(result.items).toEqual([old]);
    expect(result.issues).toMatchObject([{ itemId: "old", reason }]);
  });

  it("does not trust a reused ID pointing to a different TMDB work", async () => {
    source.lookupItems = vi.fn().mockResolvedValue([{ ...old, tmdbId: "999" }]);
    expect((await repairVirtualMappings(store, id, source)).items).toEqual([replacement]);
    expect(source.findByTmdb).toHaveBeenCalledWith("Series", "223911");
  });

  it("never uses a title to repair legacy mappings with no provider identity", async () => {
    const { tmdbId: _tmdbId, ...legacy } = old;
    store.removeItem(id, "old");
    store.addItems(id, [legacy]);
    const result = await repairVirtualMappings(store, id, source);
    expect(result.items).toEqual([legacy]);
    expect(result.issues).toMatchObject([{ reason: "unidentified" }]);
    expect(source.findByTmdb).not.toHaveBeenCalled();
  });

  it("does not delete mappings on authentication or transport failures", async () => {
    source.lookupItems = vi.fn().mockRejectedValue(new Error("HTTP 401"));
    const result = await repairVirtualMappings(store, id, source);
    expect(result.items).toEqual([old]);
    expect(result.issues).toMatchObject([{ reason: "unavailable" }]);
    expect(source.findByTmdb).not.toHaveBeenCalled();
  });

  it("does not resurrect an association removed while the source lookup is pending", async () => {
    source.findByTmdb = vi.fn().mockImplementation(async () => {
      store.removeItem(id, "old");
      return [replacement];
    });
    expect(await repairVirtualMappings(store, id, source)).toEqual({ items: [], issues: [] });
  });

  it("bounds the entire check and never writes a late identity lookup result", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (items: VirtualLibraryItem[]) => void;
      source.findByTmdb = vi.fn().mockImplementation(
        () =>
          new Promise<VirtualLibraryItem[]>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = repairVirtualMappings(store, id, source);
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await pending;
      expect(result.items).toEqual([old]);
      expect(result.issues).toMatchObject([{ reason: "unavailable" }]);
      finish([replacement]);
      await Promise.resolve();
      expect(store.listItems(id)).toEqual([old]);
    } finally {
      vi.useRealTimers();
    }
  });
});
