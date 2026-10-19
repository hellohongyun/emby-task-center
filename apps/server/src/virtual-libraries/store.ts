import { randomBytes } from "node:crypto";
import { and, asc, count, eq, max, sql } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { virtualLibraries, virtualLibraryItems, virtualLibraryPosters } from "@emby-task-center/database/schema";
import {
  CreateVirtualLibrarySchema,
  UpdateVirtualLibrarySchema,
  normalizeVirtualLibraryTmdbId,
  type CreateVirtualLibraryInput,
  type UpdateVirtualLibraryInput,
  type VirtualLibrary,
  type VirtualLibraryItem,
} from "@emby-task-center/contracts/virtual-library";
import { validateVirtualLibraryItems } from "./type-validation";
import { createPosterStore } from "./poster-store";

export class VirtualLibraryNotFoundError extends Error {
  constructor() {
    super("虚拟媒体库不存在");
  }
}

export function createVirtualLibraryStore(database: AppDatabase) {
  function list(): VirtualLibrary[] {
    return database
      .select({
        id: virtualLibraries.id,
        name: virtualLibraries.name,
        collectionType: virtualLibraries.collectionType,
        sortOrder: virtualLibraries.sortOrder,
        createdAt: virtualLibraries.createdAt,
        updatedAt: virtualLibraries.updatedAt,
        itemCount: count(virtualLibraryItems.itemId),
        posterImageTag: virtualLibraryPosters.imageTag,
        posterAspectRatio: sql<
          number | null
        >`CAST(${virtualLibraryPosters.width} AS REAL) / ${virtualLibraryPosters.height}`,
      })
      .from(virtualLibraries)
      .leftJoin(virtualLibraryItems, eq(virtualLibraries.id, virtualLibraryItems.libraryId))
      .leftJoin(virtualLibraryPosters, eq(virtualLibraries.id, virtualLibraryPosters.libraryId))
      .groupBy(virtualLibraries.id)
      .orderBy(asc(virtualLibraries.sortOrder), asc(virtualLibraries.createdAt), asc(virtualLibraries.id))
      .all();
  }

  function get(id: string) {
    return list().find((library) => library.id === id);
  }
  function requireLibrary(id: string) {
    const library = database.select().from(virtualLibraries).where(eq(virtualLibraries.id, id)).get();
    if (!library) throw new VirtualLibraryNotFoundError();
    return library;
  }
  function touch(id: string) {
    database
      .update(virtualLibraries)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(virtualLibraries.id, id))
      .run();
  }
  function listItems(id: string): VirtualLibraryItem[] {
    return database
      .select({
        itemId: virtualLibraryItems.itemId,
        name: virtualLibraryItems.name,
        type: virtualLibraryItems.type,
        year: virtualLibraryItems.year,
        imageTag: virtualLibraryItems.imageTag,
        tmdbId: virtualLibraryItems.tmdbId,
      })
      .from(virtualLibraryItems)
      .where(eq(virtualLibraryItems.libraryId, id))
      .orderBy(asc(virtualLibraryItems.position), asc(virtualLibraryItems.itemId))
      .all()
      .map(({ tmdbId, ...item }) => (tmdbId ? { ...item, tmdbId } : item));
  }

  return {
    ...createPosterStore(database, requireLibrary, touch),
    list,
    get,
    listItems,
    create(input: CreateVirtualLibraryInput): VirtualLibrary {
      const parsed = CreateVirtualLibrarySchema.parse(input);
      const now = new Date().toISOString();
      const row = { ...parsed, id: randomBytes(16).toString("hex"), createdAt: now, updatedAt: now };
      database.insert(virtualLibraries).values(row).run();
      return get(row.id)!;
    },
    update(id: string, input: UpdateVirtualLibraryInput): VirtualLibrary {
      const parsed = UpdateVirtualLibrarySchema.parse(input);
      return database.transaction(() => {
        const library = requireLibrary(id);
        if (parsed.collectionType && parsed.collectionType !== library.collectionType) {
          validateVirtualLibraryItems(parsed.collectionType, listItems(id));
        }
        database
          .update(virtualLibraries)
          .set({ ...parsed, updatedAt: new Date().toISOString() })
          .where(eq(virtualLibraries.id, id))
          .run();
        return get(id)!;
      });
    },
    remove(id: string): boolean {
      return database.transaction(() => {
        const exists = Boolean(get(id));
        database.delete(virtualLibraryItems).where(eq(virtualLibraryItems.libraryId, id)).run();
        database.delete(virtualLibraries).where(eq(virtualLibraries.id, id)).run();
        return exists;
      });
    },
    addItems(id: string, items: VirtualLibraryItem[]): VirtualLibraryItem[] {
      return database.transaction(() => {
        const library = requireLibrary(id);
        validateVirtualLibraryItems(library.collectionType, items);
        let position =
          (database
            .select({ value: max(virtualLibraryItems.position) })
            .from(virtualLibraryItems)
            .where(eq(virtualLibraryItems.libraryId, id))
            .get()?.value ?? -1) + 1;
        for (const item of items) {
          const normalized = { ...item, tmdbId: normalizeVirtualLibraryTmdbId(item.tmdbId) };
          database
            .insert(virtualLibraryItems)
            .values({ ...normalized, libraryId: id, position: position++ })
            .onConflictDoUpdate({
              target: [virtualLibraryItems.libraryId, virtualLibraryItems.itemId],
              set: { ...normalized, tmdbId: sql`COALESCE(excluded.tmdb_id, virtual_library_items.tmdb_id)` },
            })
            .run();
        }
        touch(id);
        return listItems(id);
      });
    },
    replaceItem(
      id: string,
      oldItemId: string,
      resolvedItem: VirtualLibraryItem,
      expected?: VirtualLibraryItem,
    ): boolean {
      return database.transaction(() => {
        const scope = (itemId: string) =>
          and(eq(virtualLibraryItems.libraryId, id), eq(virtualLibraryItems.itemId, itemId));
        const old = database.select().from(virtualLibraryItems).where(scope(oldItemId)).get();
        if (!old || old.type.toLowerCase() !== resolvedItem.type.toLowerCase()) return false;
        const tmdbId = normalizeVirtualLibraryTmdbId(resolvedItem.tmdbId);
        if (old.tmdbId && old.tmdbId !== tmdbId) return false;
        if (
          expected &&
          (expected.itemId !== old.itemId ||
            expected.type !== old.type ||
            expected.name !== old.name ||
            expected.year !== old.year ||
            expected.imageTag !== old.imageTag ||
            normalizeVirtualLibraryTmdbId(expected.tmdbId) !== old.tmdbId)
        )
          return false;
        const target = database.select().from(virtualLibraryItems).where(scope(resolvedItem.itemId)).get();
        if (
          target &&
          (target.type.toLowerCase() !== old.type.toLowerCase() || (target.tmdbId && target.tmdbId !== tmdbId))
        )
          return false;
        const row = {
          ...resolvedItem,
          tmdbId: tmdbId ?? old.tmdbId,
          libraryId: id,
          position: Math.min(old.position, target?.position ?? old.position),
        };
        database
          .insert(virtualLibraryItems)
          .values(row)
          .onConflictDoUpdate({
            target: [virtualLibraryItems.libraryId, virtualLibraryItems.itemId],
            set: row,
          })
          .run();
        if (oldItemId !== resolvedItem.itemId) database.delete(virtualLibraryItems).where(scope(oldItemId)).run();
        touch(id);
        return true;
      });
    },
    removeItem(id: string, itemId: string): void {
      database.transaction(() => {
        requireLibrary(id);
        database
          .delete(virtualLibraryItems)
          .where(and(eq(virtualLibraryItems.libraryId, id), eq(virtualLibraryItems.itemId, itemId)))
          .run();
        touch(id);
      });
    },
    removeItemEverywhere(itemId: string): void {
      database.transaction(() => {
        const libraries = database
          .select({ id: virtualLibraryItems.libraryId })
          .from(virtualLibraryItems)
          .where(eq(virtualLibraryItems.itemId, itemId))
          .all();
        database.delete(virtualLibraryItems).where(eq(virtualLibraryItems.itemId, itemId)).run();
        for (const { id } of libraries) touch(id);
      });
    },
  };
}

export type VirtualLibraryStore = ReturnType<typeof createVirtualLibraryStore>;
