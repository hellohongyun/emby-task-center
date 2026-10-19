import {
  authenticationUrl,
  parameter,
  result,
  setParameter,
  type QueryUpstream,
  type UpstreamJson,
  type VirtualQueryStore,
} from "./query-helpers";
import { overlayLibraries } from "./owned-library-overlay";
import type { OwnedViewAnchor } from "./owned-view-preferences";
import { ownedLatestLibraryId, ownHomeConfiguration } from "./owned-home-sections";
import { queryScope } from "./query-scope";

interface HomeSectionContext {
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
  homeSections?: unknown;
  ownedOrder?: OwnedViewAnchor[];
}

/** Emby 4.10 loads the home library row through a server-defined section ID. */
export async function homeSectionItems({
  url,
  store,
  upstream,
  homeSections,
  ownedOrder,
}: HomeSectionContext): Promise<UpstreamJson | undefined> {
  const match = /^\/Users\/([^/]+)\/Sections\/([^/]+)\/Items\/?$/i.exec(url.pathname);
  if (!match || !store.list().length) return undefined;
  const ownLibrary = ownedLatestLibraryId(decodeURIComponent(match[2]), store);
  if (ownLibrary) {
    const latest = new URL(url);
    latest.pathname = `/Users/${match[1]}/Items/Latest`;
    setParameter(latest, "ParentId", ownLibrary);
    if (parameter(latest, "IsPlayed") === undefined) {
      const config = await ownHomeConfiguration(url, upstream);
      if (config.HidePlayedInLatest === true) setParameter(latest, "IsPlayed", "false");
    }
    const reply = await queryScope(store, ownLibrary, latest, upstream);
    if (reply.status < 200 || reply.status >= 300) return reply;
    const items = reply.body;
    return Array.isArray(items) ? result({ Items: items, TotalRecordCount: items.length }) : reply;
  }
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

  return overlayLibraries({ url, store, upstream, reply: await upstream(url), ownedOrder });
}
