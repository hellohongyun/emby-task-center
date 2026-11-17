import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { fetchQqAvatar } from "../subscriptions/member-qq-avatar";
import { createVirtualLibraryStore } from "./store";
import { createVirtualLibraryMarketService, MarketError } from "./market-service";

type Image = { contentType: string; body: Buffer };
const caches = new WeakMap<AppDatabase, Map<string, { expires: number; image: Image | null }>>();
export async function marketAuthorAvatar(
  database: AppDatabase,
  id: string,
  adminInspection = false,
  signal?: AbortSignal,
) {
  function author() {
    const library = createVirtualLibraryStore(database, { all: true }).get(id);
    if (
      !library ||
      library.ownerMemberId == null ||
      (!adminInspection && !createVirtualLibraryMarketService(database).available(library))
    )
      throw new MarketError(404, "virtual_library_not_found");
    const member = database.select().from(submissionUsers).where(eq(submissionUsers.id, library.ownerMemberId)).get();
    if (!member?.qqNumber || member.qqAvatarSyncStatus === "unavailable")
      throw new MarketError(404, "avatar_not_found");
    return member.qqNumber;
  }
  const qq = author();
  let cache = caches.get(database);
  if (!cache) {
    cache = new Map();
    caches.set(database, cache);
  }
  const saved = cache.get(qq);
  let image = saved && saved.expires > Date.now() ? saved.image : undefined;
  if (image === undefined) {
    try {
      image = await fetchQqAvatar(qq, signal);
    } catch {
      image = null;
    }
    if (cache.size > 300) cache.clear();
    cache.set(qq, { expires: Date.now() + (image ? 5 * 60_000 : 30_000), image });
  }
  if (author() !== qq || !image) throw new MarketError(404, "avatar_not_found");
  return image;
}
