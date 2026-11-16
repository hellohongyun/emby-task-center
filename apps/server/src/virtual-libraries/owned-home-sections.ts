import { libraryDto } from "./library-dto";
import { anchorOwnedViews, applyAdminLibraryOrder } from "./view-order";
import { viewIdentity, type OwnedViewAnchor } from "./owned-view-preferences";
import {
  authenticationUrl,
  type Item,
  type QueryUpstream,
  type UpstreamJson,
  type VirtualQueryStore,
} from "./query-helpers";

const prefix = "task-center-latest:";
export const ownedLatestSectionId = (id: string) => `${prefix}${id}`;
export function ownedLatestLibraryId(sectionId: string, store: VirtualQueryStore) {
  const id = sectionId.startsWith(prefix) ? sectionId.slice(prefix.length) : "";
  return id && store.get(id) ? id : undefined;
}

export async function ownHomeConfiguration(url: URL, upstream: QueryUpstream): Promise<Record<string, unknown>> {
  const user = /^\/Users\/([^/]+)\//i.exec(url.pathname)?.[1];
  if (!user) return {};
  try {
    const reply = await upstream(authenticationUrl(url, `/Users/${user}`), 1_500);
    if (reply.status < 200 || reply.status >= 300) return {};
    const body = reply.body as { Configuration?: unknown } | null;
    return body?.Configuration && typeof body.Configuration === "object"
      ? (body.Configuration as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface OwnedHomeContext {
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
  reply: UpstreamJson;
  ownedOrder?: OwnedViewAnchor[];
  personalOrder?: readonly string[];
  ownLibraryIds?: readonly string[];
  adminOrder?: readonly string[];
}

/** Add our latest-content rows without moving or copying configuration from upstream rows. */
export async function appendOwnedHomeSections({
  url,
  store,
  upstream,
  reply,
  ownedOrder,
  personalOrder,
  ownLibraryIds,
  adminOrder,
}: OwnedHomeContext): Promise<UpstreamJson> {
  if (reply.status < 200 || reply.status >= 300 || !Array.isArray(reply.body) || !store.list().length) return reply;
  const sections = reply.body as Item[];
  if (sections.some((section) => !section || typeof section !== "object" || typeof section.Id !== "string"))
    return reply;
  // An upstream with no latest-content rows may have that home feature disabled.
  const template = sections.find((section) => section?.SectionType === "latestmedia");
  if (!template) return reply;
  const configuration = await ownHomeConfiguration(url, upstream);
  const ids = (value: unknown) =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").map(viewIdentity) : [];
  const hidden = new Set([...ids(configuration.MyMediaExcludes), ...ids(configuration.LatestItemsExcludes)]);
  const existing = new Set(sections.map((section) => section?.Id));
  const parent = template.ParentItem as Item | undefined;
  const additions = store
    .list()
    .filter((library) => !hidden.has(viewIdentity(library.id)) && !existing.has(ownedLatestSectionId(library.id)))
    .map((library) => libraryDto(store, library.id, parent?.ServerId));
  const privateIds = new Set(
    store
      .list()
      .filter((library) => library.ownerMemberId != null)
      .map((library) => library.id),
  );
  const ordered = [
    ...additions.filter((item) => privateIds.has(String(item.Id))),
    ...anchorOwnedViews(
      [],
      additions.filter((item) => !privateIds.has(String(item.Id))),
      ids(configuration.OrderedViews),
      ownedOrder,
    ),
  ];
  if (!ordered.length) return reply;
  const rows = ordered.map((item) => ({
    Name: `最新${item.Name}`,
    Id: ownedLatestSectionId(item.Id!),
    SectionType: "latestmedia",
    CollectionType: item.CollectionType,
    Monitor: ["markplayed", "videoplayback"],
    ItemTypes: [],
    ExcludedFolders: [],
    CardSizeOffset: 0,
    ParentItem: item,
    ParentId: item.Id,
    IncludeNextUpInResume: true,
    Query: {
      StudioIds: [],
      TagIds: [],
      GenreIds: [],
      CollectionTypes: [],
      ...(configuration.HidePlayedInLatest === true ? { IsPlayed: false } : {}),
    },
  }));
  if (ownLibraryIds) {
    const own = new Set(ownLibraryIds.map(viewIdentity));
    const saved = new Set(personalOrder?.map(viewIdentity));
    const leading = rows.filter(
      (row) => own.has(viewIdentity(String(row.ParentId))) && !saved.has(viewIdentity(String(row.ParentId))),
    );
    const leadingIds = new Set(leading.map((row) => row.Id));
    const latest = sections.filter((row) => row.SectionType === "latestmedia");
    const sorted = [
      ...leading,
      ...applyAdminLibraryOrder(
        [...latest, ...rows.filter((row) => !leadingIds.has(row.Id))],
        personalOrder ?? adminOrder ?? [],
        (row) => [row.ParentId, (row.ParentItem as Item | undefined)?.Id, (row.ParentItem as Item | undefined)?.Guid],
      ),
    ];
    let position = 0;
    const result: Item[] = [];
    for (const section of sections) {
      if (section.SectionType === "latestmedia") result.push(sorted[position++]);
      else result.push(section);
    }
    result.push(...sorted.slice(position));
    return { ...reply, raw: undefined, body: result };
  }
  const personalRows = rows.filter((row) => privateIds.has(String(row.ParentId)));
  const publicRows = rows.filter((row) => !privateIds.has(String(row.ParentId)));
  return { ...reply, raw: undefined, body: [...personalRows, ...sections, ...publicRows] };
}
