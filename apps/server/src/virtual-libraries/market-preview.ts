import { and, asc, count, eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers, virtualLibraryItems } from "@emby-task-center/database/schema";
import type { MarketLibraryDetails } from "@emby-task-center/contracts/virtual-library-market";
import type { VirtualLibraryItem } from "@emby-task-center/contracts/virtual-library";
import { createVirtualLibraryMarketService, MarketError, type MarketActor } from "./market-service";
import { createUpstreamLibraryMarketService } from "./upstream-market-service";
import { catalogJson, catalogList, upstreamLibraryConfiguration } from "./upstream-library-catalog";
import { privateIdentity } from "./private-access";
import { fetchImage } from "../util/image-request";
import { memberAccessError } from "../subscriptions/member-access";
import { targetUrl } from "./proxy-transport";

type Item = Record<string, unknown>;
const notFound = () => new MarketError(404, "virtual_library_not_found");
export const previewImageTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp"];
export function createMarketPreview(database: AppDatabase) {
  const market = createVirtualLibraryMarketService(database);
  const external = createUpstreamLibraryMarketService(database);
  const pendingCatalogs = new Map<string, Promise<Awaited<ReturnType<typeof catalogList>>>>();
  function concurrentCatalog(libraryId: string, base: string, path: string, apiKey: string) {
    const key = JSON.stringify([libraryId, base, path, apiKey]);
    const pending = pendingCatalogs.get(key);
    if (pending) return pending;
    const request = catalogList(base, path, apiKey, fetch);
    pendingCatalogs.set(key, request);
    // Only share concurrent reads; every later request must prove current upstream access again.
    void request.then(
      () => pendingCatalogs.delete(key),
      () => pendingCatalogs.delete(key),
    );
    return request;
  }
  function library(actor: MarketActor, id: string) {
    if (actor.memberId !== undefined) {
      const member = database.select().from(submissionUsers).where(eq(submissionUsers.id, actor.memberId)).get();
      if (!member?.embyUserId || memberAccessError(database, member.email, true))
        throw new MarketError(403, "member_unavailable");
    }
    const value = market.list(actor).find((entry) => entry.id === id);
    if (!value) throw notFound();
    return value;
  }
  function userId(actor: MarketActor) {
    const id =
      actor.memberId === undefined
        ? market.readDefaults().adminEmbyUserId
        : database.select().from(submissionUsers).where(eq(submissionUsers.id, actor.memberId)).get()?.embyUserId;
    if (!id) throw new MarketError(403, "emby_account_required");
    return id;
  }
  async function upstream(actor: MarketActor, id: string) {
    library(actor, id);
    const row = external.get(id);
    if (!row?.available || !row.published) throw notFound();
    const viewer = userId(actor);
    const config = upstreamLibraryConfiguration(database);
    if (!config.upstream || !config.apiKey) throw new MarketError(503, "emby_not_configured");
    const views = await concurrentCatalog(
      id,
      config.upstream,
      `Users/${encodeURIComponent(viewer)}/Views`,
      config.apiKey,
    );
    if (
      !views.Items.some(
        (item) => typeof item.Id === "string" && privateIdentity(item.Id) === privateIdentity(row.sourceId),
      )
    )
      throw notFound();
    return { row, viewer, config };
  }
  function recheck(actor: MarketActor, id: string, viewer?: string) {
    library(actor, id);
    if (viewer && userId(actor) !== viewer) throw notFound();
  }
  function itemScope(id: string, itemId?: string) {
    return and(
      eq(virtualLibraryItems.libraryId, id),
      itemId === undefined ? undefined : eq(virtualLibraryItems.itemId, itemId),
    );
  }
  function dto(item: Item): VirtualLibraryItem {
    if (typeof item.Id !== "string" || typeof item.Name !== "string" || typeof item.Type !== "string")
      throw new MarketError(502, "invalid_upstream_catalog");
    return {
      itemId: item.Id,
      name: item.Name,
      type: item.Type,
      year: typeof item.ProductionYear === "number" ? item.ProductionYear : null,
      imageTag: typeof (item.ImageTags as Item)?.Primary === "string" ? String((item.ImageTags as Item).Primary) : null,
    };
  }
  async function details(
    actor: MarketActor,
    id: string,
    startIndex: number,
    limit: number,
  ): Promise<MarketLibraryDetails> {
    const value = library(actor, id);
    if (!external.get(id)) {
      const total = database.select({ value: count() }).from(virtualLibraryItems).where(itemScope(id)).get()!.value;
      const items = database
        .select({
          itemId: virtualLibraryItems.itemId,
          name: virtualLibraryItems.name,
          type: virtualLibraryItems.type,
          year: virtualLibraryItems.year,
          imageTag: virtualLibraryItems.imageTag,
          tmdbId: virtualLibraryItems.tmdbId,
        })
        .from(virtualLibraryItems)
        .where(itemScope(id))
        .orderBy(asc(virtualLibraryItems.position), asc(virtualLibraryItems.itemId))
        .offset(startIndex)
        .limit(limit)
        .all();
      return { library: value, items, total, startIndex, limit };
    }
    const { row, viewer, config } = await upstream(actor, id);
    const query = new URLSearchParams({
      ParentId: row.sourceId,
      Recursive: "false",
      StartIndex: String(startIndex),
      Limit: String(limit),
      Fields: "ProductionYear",
      EnableTotalRecordCount: "true",
    });
    const body = (await catalogJson(
      config.upstream,
      `Users/${encodeURIComponent(viewer)}/Items?${query}`,
      config.apiKey,
    )) as Item;
    recheck(actor, id, viewer);
    if (
      !body ||
      !Array.isArray(body.Items) ||
      body.Items.length > limit ||
      !Number.isInteger(body.TotalRecordCount) ||
      Number(body.TotalRecordCount) < 0
    )
      throw new MarketError(502, "invalid_upstream_catalog");
    return { library: value, items: body.Items.map(dto), total: Number(body.TotalRecordCount), startIndex, limit };
  }
  async function poster(actor: MarketActor, id: string, itemId: string, signal: AbortSignal) {
    library(actor, id);
    let viewer: string | undefined;
    let config = upstreamLibraryConfiguration(database);
    const externalRow = external.get(id);
    if (externalRow) {
      const target = await upstream(actor, id);
      viewer = target.viewer;
      config = target.config;
      // Scope comes exclusively from this viewer and the current market root, never from a requested item ID.
      const query = new URLSearchParams({ ParentId: target.row.sourceId, Recursive: "false" });
      const entries = await concurrentCatalog(
        id,
        config.upstream,
        `Users/${encodeURIComponent(viewer)}/Items?${query}`,
        config.apiKey,
      );
      if (!entries.Items.some((entry) => entry.Id === itemId))
        throw new MarketError(404, "virtual_library_item_not_found");
    } else if (!database.select().from(virtualLibraryItems).where(itemScope(id, itemId)).get()) {
      throw new MarketError(404, "virtual_library_item_not_found");
    }
    const root = externalRow ? config.upstream : config.native;
    if (!root || !config.apiKey) throw new MarketError(404, "poster_not_found");
    const url = targetUrl(
      root,
      `${externalRow ? "" : "/emby"}/Items/${encodeURIComponent(itemId)}/Images/Primary`,
    ).href;
    let image;
    try {
      image = await fetchImage(url, {
        headers: { "X-Emby-Token": config.apiKey },
        signal,
        timeoutMs: 5000,
        maxBytes: 5 * 1024 * 1024,
        allowUrl: (target) => target === url,
      });
    } catch {
      throw new MarketError(404, "poster_not_found");
    }
    recheck(actor, id, viewer);
    if (!externalRow && !database.select().from(virtualLibraryItems).where(itemScope(id, itemId)).get())
      throw new MarketError(404, "virtual_library_item_not_found");
    if (!previewImageTypes.includes(image.contentType.split(";")[0].trim().toLowerCase()))
      throw new MarketError(404, "poster_not_found");
    return image;
  }
  return { details, poster };
}
