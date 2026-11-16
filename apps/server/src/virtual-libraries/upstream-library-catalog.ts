import type { AppDatabase } from "@emby-task-center/database/client";
import { readSettings } from "../settings/store";
import { privateIdentity } from "./private-access";

export class UpstreamLibraryError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export interface UpstreamCandidate {
  sourceId: string;
  sourceGuid: string | null;
  name: string;
  collectionType: "movies" | "tvshows" | "mixed";
  posterImageTag: string | null;
  posterAspectRatio: number | null;
}
type Item = Record<string, unknown>;
export function upstreamLibraryConfiguration(database: AppDatabase) {
  const { values } = readSettings(database);
  const raw = values["virtualLibraryProxy.upstream"] || values["emby.baseUrl"];
  let upstream = "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    upstream = url.href.replace(/\/+$/, "");
  } catch {
    /* Unconfigured installation. */
  }
  return { upstream, native: values["emby.baseUrl"], apiKey: values["emby.apiKey"] };
}
export async function catalogJson(
  base: string,
  path: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  try {
    const response = await fetcher(`${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`, {
      headers: { "X-Emby-Token": apiKey },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamLibraryError(502, "upstream_catalog_unavailable");
    }
    return await response.json();
  } catch (error) {
    if (error instanceof UpstreamLibraryError) throw error;
    throw new UpstreamLibraryError(502, "upstream_catalog_unavailable");
  }
}
function items(value: unknown): Item[] {
  const entries = Array.isArray(value) ? value : (value as { Items?: unknown })?.Items;
  if (!Array.isArray(entries) || entries.some((item) => !item || typeof item !== "object"))
    throw new UpstreamLibraryError(502, "invalid_upstream_catalog");
  return entries;
}
function keys(item: Item) {
  return [item.Id, item.ItemId, item.Guid]
    .filter((id): id is string => typeof id === "string" && !!id)
    .map(privateIdentity);
}
/** A successful partial listing must never mark the remaining registered libraries unavailable. */
export async function catalogList(base: string, path: string, apiKey: string, fetcher: typeof fetch) {
  const target = new URL(path, "http://catalog.local/");
  target.searchParams.set("Limit", "200");
  const found: Item[] = [];
  const seen = new Set<string>();
  for (;;) {
    target.searchParams.set("StartIndex", String(found.length));
    const body = await catalogJson(base, target.pathname + target.search, apiKey, fetcher);
    const page = items(body);
    const total = (body as { TotalRecordCount?: unknown })?.TotalRecordCount;
    const count = typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : undefined;
    for (const entry of page) {
      const id = keys(entry)[0];
      if (!id || seen.has(id)) throw new UpstreamLibraryError(502, "invalid_upstream_catalog");
      seen.add(id);
      found.push(entry);
    }
    if (count !== undefined ? found.length >= count : page.length < 200) return { Items: found };
    if (!page.length || found.length >= 10000) throw new UpstreamLibraryError(502, "incomplete_upstream_catalog");
  }
}
export async function discoverUpstreamLibraries(
  database: AppDatabase,
  userId: string | null,
  fetcher: typeof fetch = fetch,
) {
  const config = upstreamLibraryConfiguration(database);
  if (!config.upstream || !config.native || !config.apiKey) throw new UpstreamLibraryError(503, "emby_not_configured");
  const path = userId ? `Users/${encodeURIComponent(userId)}/Views?IncludeHidden=true` : "Library/MediaFolders";
  // Many installations configure the TTD proxy as both application sources.
  // Its explicit root CollectionFolder query is an entity listing, whereas
  // Views/MediaFolders include injected folders. Still require administrator
  // confirmation and exclude all physical-folder identities before import.
  const sameEntry = config.upstream === config.native?.replace(/\/+$/, "");
  const nativePath = sameEntry
    ? `${userId ? `Users/${encodeURIComponent(userId)}/` : ""}Items?IncludeItemTypes=CollectionFolder&Recursive=false`
    : path;
  const [upstreamInfo, nativeInfo, upstreamBody, nativeBody, nativeFolders] = await Promise.all([
    catalogJson(config.upstream, "System/Info/Public", config.apiKey, fetcher),
    catalogJson(config.native, "System/Info/Public", config.apiKey, fetcher),
    catalogList(config.upstream, path, config.apiKey, fetcher),
    catalogList(config.native, nativePath, config.apiKey, fetcher),
    catalogJson(config.native, "Library/VirtualFolders", config.apiKey, fetcher),
  ]);
  const upstreamId = (upstreamInfo as Item)?.Id,
    nativeId = (nativeInfo as Item)?.Id;
  if (typeof upstreamId !== "string" || !upstreamId || upstreamId !== nativeId)
    throw new UpstreamLibraryError(409, "upstream_server_mismatch");
  const native = [...items(nativeBody), ...items(nativeFolders)];
  if (native.some((item) => !keys(item).length)) throw new UpstreamLibraryError(502, "invalid_upstream_catalog");
  const excluded = new Set(native.flatMap(keys));
  const views = items(upstreamBody);
  const seen = new Set<string>();
  const candidates = views.flatMap((item): UpstreamCandidate[] => {
    if (item.Type !== "CollectionFolder" || keys(item).some((id) => excluded.has(id))) return [];
    if (
      ["boxsets", "playlists", "music", "photos", "books", "games"].includes(String(item.CollectionType).toLowerCase())
    )
      return [];
    if (typeof item.Id !== "string" || !item.Id || typeof item.Name !== "string" || !item.Name) return [];
    const id = privateIdentity(item.Id);
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        sourceId: item.Id,
        sourceGuid: typeof item.Guid === "string" ? item.Guid : null,
        name: item.Name,
        collectionType:
          item.CollectionType === "movies" || item.CollectionType === "tvshows" ? item.CollectionType : "mixed",
        posterImageTag:
          typeof (item.ImageTags as Item)?.Primary === "string"
            ? (item.ImageTags as { Primary: string }).Primary
            : null,
        posterAspectRatio:
          typeof item.PrimaryImageAspectRatio === "number" &&
          Number.isFinite(item.PrimaryImageAspectRatio) &&
          item.PrimaryImageAspectRatio > 0
            ? item.PrimaryImageAspectRatio
            : null,
      },
    ];
  });
  return { candidates, views, upstream: config.upstream, native: config.native };
}
