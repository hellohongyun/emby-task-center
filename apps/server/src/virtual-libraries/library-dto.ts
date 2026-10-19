import type { Item, VirtualQueryStore } from "./query-helpers";

export function libraryDto(store: VirtualQueryStore, id: string, serverId?: unknown): Item {
  const library = store.get(id)!;
  const cover = store.listItems(id).find((item) => item.imageTag);
  const imageTag = library.posterImageTag ?? cover?.imageTag;
  return {
    Id: library.id,
    Guid: library.id,
    Name: library.name,
    SortName: library.name,
    PresentationUniqueKey: library.id,
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
    ImageTags: imageTag ? { Primary: imageTag, ...(library.posterImageTag ? { Thumb: imageTag } : {}) } : {},
    HasPrimaryImage: Boolean(imageTag),
    ...(imageTag ? { PrimaryImageTag: imageTag } : {}),
    ...(library.posterImageTag ? { BackdropImageTags: [imageTag] } : {}),
    PrimaryImageAspectRatio: library.posterAspectRatio ?? 16 / 9,
    // This logical folder has no independent playback history. Never copy a
    // source item's user state or another user's preferences onto the library.
    UserData: {
      Key: library.id,
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      IsFavorite: false,
      Played: false,
    },
    ...(serverId ? { ServerId: serverId } : {}),
  };
}
