import type { AppDatabase } from "@emby-task-center/database/client";
import { createEmbyLibraryOrderStore, expandLibraryOrder } from "../integrations/emby-library-order-store";
import { readSettings } from "../settings/store";
import { createVirtualLibrarySource } from "./source";
import { createVirtualLibraryStore } from "./store";
import { createVirtualLibraryMarketService } from "./market-service";
import { readVirtualProxyConfig, virtualProxyUpstream } from "./proxy-settings";
import {
  composeLibraryOrder,
  createPersonalLibraryOrderService,
  type PersonalLibraryOrderItem,
} from "./personal-library-order";
import { createOwnedViewPreferences, viewIdentity } from "./owned-view-preferences";
import { legacyLibraryConfiguration, legacyLibrarySequence } from "./personal-library-order-legacy";
import { createUpstreamLibraryMarketService } from "./upstream-market-service";

export function personalOrderUpstream(database: AppDatabase) {
  return virtualProxyUpstream(database, readVirtualProxyConfig(database));
}

export async function personalLibraryOrderCatalog(
  database: AppDatabase,
  embyUserId: string,
  source = createVirtualLibrarySource(database, fetch, embyUserId, personalOrderUpstream(database)),
) {
  const upstream = personalOrderUpstream(database);
  const market = createVirtualLibraryMarketService(database);
  const access = market.resolveAccess(embyUserId);
  if (!access) throw new Error("library_identity_unavailable");
  const store = createVirtualLibraryStore(database, { all: true });
  const all = new Set(store.list().map((library) => viewIdentity(library.id)));
  const own = new Set(access.ownLibraryIds.map(viewIdentity));
  const visible = new Set(access.visibleLibraryIds.map(viewIdentity));
  const external = createUpstreamLibraryMarketService(database);
  const externalById = new Map(
    external
      .rows()
      .flatMap((library) =>
        [library.sourceId, library.sourceGuid]
          .filter((id): id is string => !!id)
          .map((id) => [viewIdentity(id), library] as const),
      ),
  );
  const natives = await source.libraries({ includeGuid: true });
  const items: PersonalLibraryOrderItem[] = [
    ...natives.flatMap((item): PersonalLibraryOrderItem[] => {
      if (all.has(viewIdentity(item.id))) return [];
      const library =
        externalById.get(viewIdentity(item.id)) ?? (item.guid ? externalById.get(viewIdentity(item.guid)) : undefined);
      if (!library) return [{ ...item, kind: "native" }];
      if (!external.isEnabled(access.subscriberId, library.id)) return [];
      return [
        {
          ...item,
          id: library.sourceId,
          kind: "subscribed",
          source: "tgtodrive",
          marketId: library.id,
          posterImageTag: library.posterImageTag,
        },
      ];
    }),
    ...store
      .list()
      .filter((library) => visible.has(viewIdentity(library.id)))
      .map((library) => ({
        id: library.id,
        name: library.name,
        posterImageTag: library.posterImageTag,
        kind: own.has(viewIdentity(library.id)) ? ("owned" as const) : ("subscribed" as const),
      })),
  ];
  const unique = [...new Map(items.map((item) => [viewIdentity(item.id), item])).values()];
  const embyUrl = readSettings(database).values["emby.baseUrl"] || upstream;
  const template = createEmbyLibraryOrderStore(database).readActive(embyUrl, upstream);
  const order = createPersonalLibraryOrderService(database).read(upstream, embyUserId);
  let inherited: string[] | undefined;
  if (order === undefined) {
    // Only an arrangement this proxy actually observed counts as a legacy personal order.
    // Emby can give a brand-new account a non-empty OrderedViews (the native library list in
    // server order); inheriting that would hide the administrator template until the member
    // explicitly presses "恢复默认".
    const anchors = createOwnedViewPreferences(database, store).read(upstream, embyUserId);
    if (anchors.length) {
      const config = await legacyLibraryConfiguration(database, embyUserId);
      const raw = Array.isArray(config.OrderedViews)
        ? config.OrderedViews.filter((id): id is string => typeof id === "string")
        : [];
      const dto = (item: PersonalLibraryOrderItem) => ({ Id: item.id, Name: item.name, Guid: item.guid });
      inherited = legacyLibrarySequence(
        unique.filter((item) => item.kind === "native").map(dto),
        unique.filter((item) => item.kind !== "native").map(dto),
        raw,
        anchors,
        access.ownLibraryIds,
      )?.map((item) => item.Id!);
    }
  }
  const ordered = composeLibraryOrder(
    unique,
    order ?? inherited,
    template ? expandLibraryOrder(template.order, template.aliases) : [],
  );
  return {
    items: ordered.map(({ id, name, kind, posterImageTag, marketId, source }) => ({
      id,
      name,
      kind,
      ...(posterImageTag ? { posterImageTag } : {}),
      ...(marketId ? { marketId, source } : {}),
    })),
    order: ordered.map((item) => item.id),
    hasPersonalOrder: !!(order?.length || inherited?.length),
  };
}

/** Materialize before enabling: a newly subscribed library must follow the existing full sequence. */
export async function prepareMarketSubscriptionOrder(database: AppDatabase, embyUserId: string) {
  const catalog = await personalLibraryOrderCatalog(database, embyUserId);
  const upstream = personalOrderUpstream(database);
  const service = createPersonalLibraryOrderService(database);
  return {
    append: (id: string) => {
      service.append(upstream, embyUserId, id, catalog.order);
    },
  };
}
