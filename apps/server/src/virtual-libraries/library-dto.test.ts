import { describe, expect, it } from "vitest";
import { libraryDto } from "./library-dto";
import type { VirtualQueryStore } from "./query-helpers";
import { DEFAULT_LIBRARY_POSTER_TAG } from "@emby-task-center/contracts/library-poster";

const library = {
  id: "0123456789abcdef0123456789abcdef",
  name: "精选剧集",
  collectionType: "tvshows" as const,
  sortOrder: 0,
  itemCount: 1,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
};

function store(imageTag: string | null): VirtualQueryStore {
  return {
    list: () => [library],
    get: (id) => (id === library.id ? library : undefined),
    listItems: () => [
      {
        itemId: "source-id",
        name: "源剧集",
        type: "Series",
        imageTag,
        year: 2026,
      },
    ],
  };
}

describe("owned CollectionFolder client metadata", () => {
  it("provides a stable folder identity and neutral folder user state", () => {
    const dto = libraryDto(store("poster-tag"), library.id, "server-id");
    expect(dto).toMatchObject({
      Id: library.id,
      Guid: library.id,
      PresentationUniqueKey: library.id,
      DisplayPreferencesId: library.id,
      ServerId: "server-id",
      Type: "CollectionFolder",
      IsFolder: true,
      UserData: {
        Key: library.id,
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        IsFavorite: false,
        Played: false,
      },
    });
    // Folder compatibility must not introduce permissions for real media.
    expect(dto).not.toHaveProperty("CanDelete");
    expect(dto).not.toHaveProperty("CanDownload");
  });

  it("advertises built-in artwork instead of a mapped film's image", () => {
    const dto = libraryDto(store("poster-tag"), library.id);
    expect(dto).toMatchObject({
      ImageTags: { Primary: DEFAULT_LIBRARY_POSTER_TAG, Thumb: DEFAULT_LIBRARY_POSTER_TAG },
      PrimaryImageTag: DEFAULT_LIBRARY_POSTER_TAG,
      HasPrimaryImage: true,
      PrimaryImageAspectRatio: 16 / 9,
    });
  });

  it("advertises the same built-in artwork for an empty library", () => {
    const dto = libraryDto(store(null), library.id);
    expect(dto.ImageTags).toEqual({ Primary: DEFAULT_LIBRARY_POSTER_TAG, Thumb: DEFAULT_LIBRARY_POSTER_TAG });
    expect(dto.HasPrimaryImage).toBe(true);
    expect(dto.PrimaryImageTag).toBe(DEFAULT_LIBRARY_POSTER_TAG);
    expect(dto).not.toHaveProperty("ServerId");
  });
});
