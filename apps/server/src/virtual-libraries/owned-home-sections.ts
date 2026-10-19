import { libraryDto } from "./library-dto";
import { anchorOwnedViews } from "./view-order";
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
}

/** Add our latest-content rows without moving or copying configuration from upstream rows. */
export async function appendOwnedHomeSections({
  url,
  store,
  upstream,
  reply,
  ownedOrder,
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
  const ordered = anchorOwnedViews([], additions, ids(configuration.OrderedViews), ownedOrder);
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
  return { ...reply, raw: undefined, body: [...sections, ...rows] };
}
