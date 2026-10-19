import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { virtualLibraryPosters } from "@emby-task-center/database/schema";
import { parsePosterImage } from "./poster-image";

export function createPosterStore(
  database: AppDatabase,
  requireLibrary: (id: string) => unknown,
  touch: (id: string) => void,
) {
  return {
    getPoster(id: string) {
      return database.select().from(virtualLibraryPosters).where(eq(virtualLibraryPosters.libraryId, id)).get();
    },
    setPoster(id: string, content: Buffer, contentType?: string) {
      requireLibrary(id);
      const row = { ...parsePosterImage(content, contentType), libraryId: id, updatedAt: new Date().toISOString() };
      database.transaction(() => {
        database
          .insert(virtualLibraryPosters)
          .values(row)
          .onConflictDoUpdate({ target: virtualLibraryPosters.libraryId, set: row })
          .run();
        touch(id);
      });
    },
    removePoster(id: string) {
      requireLibrary(id);
      database.transaction(() => {
        database.delete(virtualLibraryPosters).where(eq(virtualLibraryPosters.libraryId, id)).run();
        touch(id);
      });
    },
  };
}
