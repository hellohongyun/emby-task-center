import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import {
  upstreamVirtualLibraries as libraries,
  upstreamVirtualLibrarySubscriptions as subscriptions,
} from "@emby-task-center/database/schema";
import type { UpstreamMarketCatalog, UpstreamMarketLibrary } from "@emby-task-center/contracts/virtual-library-market";
import {
  discoverUpstreamLibraries,
  UpstreamLibraryError,
  upstreamLibraryConfiguration,
  type UpstreamCandidate,
} from "./upstream-library-catalog";
import { createUpstreamMarketInitializer, upstreamMarketSettings } from "./upstream-market-initialize";
import { privateIdentity } from "./private-access";

export function createUpstreamLibraryMarketService(database: AppDatabase, fetcher: typeof fetch = fetch) {
  const config = () => upstreamLibraryConfiguration(database);
  const settings = upstreamMarketSettings(database);
  const key = () => `upstreamLibraryMarket.catalog.${config().upstream}`;
  function rows() {
    return database.select().from(libraries).where(eq(libraries.upstream, config().upstream)).all();
  }
  function get(id: string) {
    return rows().find((row) => row.id === id);
  }
  function isEnabled(subscriberId: string, id: string) {
    const library = get(id);
    if (!library || !library.available || !library.published) return false;
    const row = database
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.subscriberId, subscriberId), eq(subscriptions.libraryId, id)))
      .get();
    return !!row?.enabled && row.publicationVersion === library.publicationVersion;
  }
  function dto(row: ReturnType<typeof rows>[number], subscriberId?: string): UpstreamMarketLibrary {
    return {
      id: row.id,
      name: row.name,
      collectionType: row.collectionType,
      sortOrder: 0,
      itemCount: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      published: row.published,
      publicationVersion: row.publicationVersion,
      posterImageTag: row.posterImageTag,
      posterAspectRatio: row.posterAspectRatio,
      source: "tgtodrive",
      playbackId: row.sourceId,
      authorName: "系统自带",
      owned: false,
      canSubscribe: true,
      enabled: subscriberId ? isEnabled(subscriberId, row.id) : false,
      available: row.available,
    };
  }
  function list(subscriberId?: string) {
    return rows()
      .filter((row) => row.available && row.published)
      .map((row) => dto(row, subscriberId));
  }
  function status(): UpstreamMarketCatalog {
    const cached = settings.read<{ candidates: UpstreamCandidate[]; lastSyncedAt: string | null }>(key(), {
      candidates: [],
      lastSyncedAt: null,
    });
    const imported = new Set(rows().map((row) => privateIdentity(row.sourceId)));
    return {
      configured: !!(config().upstream && config().native && config().apiKey),
      initializationPending: createUpstreamMarketInitializer(database, config().upstream, fetcher).pendingCount(rows()),
      libraries: rows().map((row) => dto(row)),
      candidates: cached.candidates.map((candidate) => ({
        ...candidate,
        imported: imported.has(privateIdentity(candidate.sourceId)),
      })),
      lastSyncedAt: cached.lastSyncedAt,
    };
  }
  function subscribe(subscriberId: string, id: string, value: boolean) {
    const library = get(id);
    if (!library || (value && (!library.available || !library.published)))
      throw new UpstreamLibraryError(404, "virtual_library_not_found");
    const row = {
      subscriberId,
      libraryId: id,
      publicationVersion: library.publicationVersion,
      enabled: value,
      updatedAt: new Date().toISOString(),
    };
    database
      .insert(subscriptions)
      .values(row)
      .onConflictDoUpdate({ target: [subscriptions.subscriberId, subscriptions.libraryId], set: row })
      .run();
    return value;
  }
  async function initialize() {
    const init = createUpstreamMarketInitializer(database, config().upstream, fetcher);
    await init.initialize((subscriberId, id) => {
      const existing = database
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.subscriberId, subscriberId), eq(subscriptions.libraryId, id)))
        .get();
      const library = get(id);
      if (!existing && library?.available && library.published) subscribe(subscriberId, id, true);
    }, rows());
  }
  async function sync() {
    const userId =
      settings.read<{ adminEmbyUserId?: string }>("virtualLibraryMarket.defaults", {}).adminEmbyUserId ?? null;
    const discovered = await discoverUpstreamLibraries(database, userId, fetcher);
    if (config().upstream !== discovered.upstream || config().native !== discovered.native)
      throw new UpstreamLibraryError(409, "upstream_catalog_changed");
    const now = new Date().toISOString();
    database.transaction(() => {
      const candidates = new Map(discovered.candidates.map((item) => [privateIdentity(item.sourceId), item]));
      for (const row of rows()) {
        const candidate = candidates.get(privateIdentity(row.sourceId));
        database
          .update(libraries)
          .set(
            candidate
              ? {
                  name: candidate.name,
                  sourceGuid: candidate.sourceGuid,
                  collectionType: candidate.collectionType,
                  posterImageTag: candidate.posterImageTag,
                  posterAspectRatio: candidate.posterAspectRatio,
                  available: true,
                  updatedAt: now,
                }
              : {
                  available: false,
                  publicationVersion: row.publicationVersion + (row.available ? 1 : 0),
                  updatedAt: now,
                },
          )
          .where(eq(libraries.id, row.id))
          .run();
      }
      settings.write(key(), { candidates: discovered.candidates, lastSyncedAt: now });
    });
    await initialize();
    return status();
  }
  async function importLibraries(sourceIds: string[]) {
    const cached = settings.read<{ candidates: UpstreamCandidate[] }>(key(), { candidates: [] });
    const requested = new Set(sourceIds.map(privateIdentity));
    if (
      !requested.size ||
      ![...requested].every((id) => cached.candidates.some((item) => privateIdentity(item.sourceId) === id))
    )
      throw new UpstreamLibraryError(400, "invalid_upstream_library_selection");
    const userId =
      settings.read<{ adminEmbyUserId?: string }>("virtualLibraryMarket.defaults", {}).adminEmbyUserId ?? null;
    const fresh = await discoverUpstreamLibraries(database, userId, fetcher);
    if (config().upstream !== fresh.upstream || config().native !== fresh.native)
      throw new UpstreamLibraryError(409, "upstream_catalog_changed");
    const selected = fresh.candidates.filter((item) => requested.has(privateIdentity(item.sourceId)));
    if (selected.length !== requested.size) throw new UpstreamLibraryError(409, "upstream_catalog_changed");
    const imported: string[] = [];
    const marketId = (sourceId: string) =>
      `ttd-${createHash("sha256")
        .update(JSON.stringify([config().upstream, privateIdentity(sourceId)]))
        .digest("hex")
        .slice(0, 32)}`;
    database.transaction(() => {
      for (const item of selected) {
        const id = marketId(item.sourceId);
        if (get(id)) continue;
        const now = new Date().toISOString();
        database
          .insert(libraries)
          .values({
            id,
            upstream: config().upstream,
            ...item,
            published: true,
            available: true,
            publicationVersion: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        imported.push(id);
      }
      if (imported.length)
        createUpstreamMarketInitializer(database, config().upstream, fetcher).capture(
          cached.candidates.map((candidate) => marketId(candidate.sourceId)),
        );
    });
    await initialize();
    return status();
  }
  function publication(id: string, published: boolean) {
    const row = get(id);
    if (!row) throw new UpstreamLibraryError(404, "virtual_library_not_found");
    if (published && !row.available) throw new UpstreamLibraryError(409, "upstream_library_unavailable");
    if (row.published !== published)
      database
        .update(libraries)
        .set({
          published,
          publicationVersion: row.publicationVersion + (published ? 0 : 1),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(libraries.id, id))
        .run();
    return dto(get(id)!);
  }
  return {
    rows,
    get,
    list,
    isEnabled,
    subscribe,
    status,
    sync,
    import: importLibraries,
    publication,
    access: (subscriberId?: string) => ({
      libraries: rows(),
      enabledIds: subscriberId
        ? rows()
            .filter((row) => isEnabled(subscriberId, row.id))
            .map((row) => row.sourceId)
        : [],
    }),
  };
}
