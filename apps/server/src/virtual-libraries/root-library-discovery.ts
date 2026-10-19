import { overlayLibraries } from "./owned-library-overlay";
import {
  parameter,
  setParameter,
  type UpstreamJson,
  type QueryUpstream,
  type VirtualQueryStore,
} from "./query-helpers";
import type { OwnedViewAnchor } from "./owned-view-preferences";

// Root item queries can also be media searches. Restrict this compatibility
// path to unscoped, user-specific folder discovery and confirm the response.
const discoveryParameters = new Set([
  "userid",
  "api_key",
  "apikey",
  "token",
  "x-emby-token",
  "includeitemtypes",
  "excludeitemtypes",
  "recursive",
  "isfolder",
  "fields",
  "enableimages",
  "enableuserdata",
  "enabletotalrecordcount",
  "imagetypelimit",
  "enableimagetypes",
  "startindex",
  "limit",
  "sortby",
  "sortorder",
  "includehidden",
]);
const itemTypes = (value: string | undefined) => value?.split(",").map((type) => type.trim().toLowerCase());

export function isRootLibraryDiscovery(url: URL): boolean {
  const userPath = /^\/Users\/[^/]+\/Items\/?$/i.test(url.pathname);
  if (!userPath && (!/^\/Items\/?$/i.test(url.pathname) || !parameter(url, "UserId")?.trim())) return false;
  if ([...url.searchParams.keys()].some((key) => !discoveryParameters.has(key.toLowerCase()))) return false;
  const predicates = ["recursive", "isfolder", "includeitemtypes", "excludeitemtypes", "userid"];
  if (predicates.some((name) => [...url.searchParams.keys()].filter((key) => key.toLowerCase() === name).length > 1))
    return false;
  if (parameter(url, "Recursive") !== undefined && parameter(url, "Recursive")?.toLowerCase() !== "false") return false;
  if (parameter(url, "IsFolder") !== undefined && parameter(url, "IsFolder")?.toLowerCase() !== "true") return false;
  const included = itemTypes(parameter(url, "IncludeItemTypes"));
  if (included && (!included.length || included.some((type) => type !== "collectionfolder"))) return false;
  const excluded = itemTypes(parameter(url, "ExcludeItemTypes"));
  // Bare root Items is intentionally transparent; require a type-oriented
  // discovery request before considering its response for an overlay.
  if (!included && !excluded?.some(Boolean) && parameter(url, "IsFolder")?.toLowerCase() !== "true") return false;
  return !excluded?.some((type) => type === "collectionfolder" || type === "folder");
}

interface RootDiscoveryContext {
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
  reply: UpstreamJson;
  ownedOrder?: OwnedViewAnchor[];
}

/** Preserve every upstream item; append owned libraries only to confirmed root folder lists. */
export async function rootLibraryDiscovery(context: RootDiscoveryContext): Promise<UpstreamJson> {
  const { url, reply } = context;
  if (!isRootLibraryDiscovery(url) || reply.status < 200 || reply.status >= 300) return reply;
  const body = reply.body as { Items?: unknown } | null;
  if (
    !body ||
    !Array.isArray(body.Items) ||
    !body.Items.length ||
    body.Items.some((item) => !item || typeof item !== "object" || item.Type !== "CollectionFolder")
  )
    return reply;
  const overlayUrl = new URL(url);
  // Normalize whitespace only for the owned overlay predicate, after the
  // original URL has already reached upstream without changes.
  if (parameter(url, "IncludeItemTypes") !== undefined)
    setParameter(overlayUrl, "IncludeItemTypes", "CollectionFolder");
  return overlayLibraries({ ...context, url: overlayUrl });
}
