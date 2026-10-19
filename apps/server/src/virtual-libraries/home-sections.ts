import { authenticationUrl, type QueryUpstream, type UpstreamJson, type VirtualQueryStore } from "./query-helpers";
import { overlayLibraries } from "./owned-library-overlay";

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

  return overlayLibraries({ url, store, upstream, reply: await upstream(url) });
}
