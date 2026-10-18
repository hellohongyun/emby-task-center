import { libraryDto } from "./library-dto";
import {
  authenticationUrl,
  integerParameter,
  listBody,
  parameter,
  setParameter,
  type QueryUpstream,
  type UpstreamJson,
  type VirtualQueryStore,
} from "./query-helpers";
import { orderUserViews } from "./view-order";

interface HomeSectionContext {
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
  homeSections?: unknown;
}

/** Emby 4.10 loads the home library row through a server-defined section ID. */
export async function homeSectionItems({
  url,
  store,
  upstream,
  homeSections,
}: HomeSectionContext): Promise<UpstreamJson | undefined> {
  const match = /^\/Users\/([^/]+)\/Sections\/([^/]+)\/Items\/?$/i.exec(url.pathname);
  if (!match || !store.list().length) return undefined;
  try {
    const sections = Array.isArray(homeSections)
      ? { status: 200, body: homeSections }
      : await upstream(authenticationUrl(url, `/Users/${match[1]}/HomeSections`), 1_500);
    if (sections.status < 200 || sections.status >= 300 || !Array.isArray(sections.body)) return undefined;
    const sectionId = decodeURIComponent(match[2]);
    const section = sections.body.find(
      (value: unknown) => value && typeof value === "object" && (value as { Id?: unknown }).Id === sectionId,
    );
    if (!section || section.SectionType !== "userviews") return undefined;
  } catch {
    // Unknown sections, network errors and old servers retain the upstream behavior.
    return undefined;
  }

  const source = new URL(url);
  setParameter(source, "StartIndex");
  setParameter(source, "Limit");
  const response = await upstream(source);
  if (response.status < 200 || response.status >= 300) return response;
  const original = listBody(response.body);
  const serverId = original.Items.find((item) => item.ServerId)?.ServerId;
  const existing = new Set(original.Items.map((item) => item.Id));
  const search = parameter(url, "SearchTerm")?.toLocaleLowerCase();
  const additions = store
    .list()
    .filter((library) => !existing.has(library.id) && (!search || library.name.toLocaleLowerCase().includes(search)))
    .map((library) => libraryDto(store, library.id, serverId));
  const ordered = await orderUserViews(url, [...original.Items, ...additions], upstream);
  const start = integerParameter(url, "StartIndex", 0);
  const limit = integerParameter(url, "Limit", Number.MAX_SAFE_INTEGER);
  return {
    ...response,
    body: {
      ...original,
      Items: ordered.slice(start, start + limit),
      TotalRecordCount: ordered.length,
    },
  };
}
