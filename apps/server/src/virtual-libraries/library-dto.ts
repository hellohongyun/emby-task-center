import type { Item, VirtualQueryStore } from "./query-helpers";
import {
  DEFAULT_LIBRARY_POSTER_TAG,
  DEFAULT_LIBRARY_POSTER_ASPECT_RATIO,
} from "@emby-task-center/contracts/library-poster";

export function libraryDto(store: VirtualQueryStore, id: string, serverId?: unknown): Item {
  const library = store.get(id)!;
  const imageTag = library.posterImageTag ?? DEFAULT_LIBRARY_POSTER_TAG;
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
    ImageTags: { Primary: imageTag, Thumb: imageTag },
    HasPrimaryImage: true,
    PrimaryImageTag: imageTag,
    BackdropImageTags: [imageTag],
    PrimaryImageAspectRatio: library.posterAspectRatio ?? DEFAULT_LIBRARY_POSTER_ASPECT_RATIO,
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
