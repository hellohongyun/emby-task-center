import { DEFAULT_LIBRARY_POSTER_TAG } from "@emby-task-center/contracts/library-poster";
import { DEFAULT_LIBRARY_POSTER_PNG_BASE64 } from "@emby-task-center/contracts/library-poster-png";
import type { VirtualLibraryStore } from "./store";

const defaultPoster = {
  imageTag: DEFAULT_LIBRARY_POSTER_TAG,
  contentType: "image/png",
  content: Buffer.from(DEFAULT_LIBRARY_POSTER_PNG_BASE64, "base64"),
};

/** Callers must authorize the library before obtaining its artwork. */
export function libraryPoster(store: VirtualLibraryStore, id: string) {
  return store.getPoster(id) ?? defaultPoster;
}
