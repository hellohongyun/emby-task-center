import type { Item, VirtualQueryStore } from "./query-helpers";

export function libraryDto(store: VirtualQueryStore, id: string, serverId?: unknown): Item {
  const library = store.get(id)!;
  const cover = store.listItems(id).find((item) => item.imageTag);
  return {
    Id: library.id,
    Guid: library.id,
    Name: library.name,
    SortName: library.name,
    Type: "CollectionFolder",
    IsFolder: true,
    CollectionType: library.collectionType === "mixed" ? null : library.collectionType,
    Subviews:
      library.collectionType === "movies"
        ? ["movies", "genres", "folders"]
        : library.collectionType === "tvshows"
          ? ["series", "genres", "folders"]
          : ["movies", "series", "genres", "folders"],
    ChildCount: library.itemCount,
    DisplayPreferencesId: library.id,
    DateCreated: library.createdAt,
    ImageTags: cover?.imageTag ? { Primary: cover.imageTag } : {},
    ...(serverId ? { ServerId: serverId } : {}),
  };
}
