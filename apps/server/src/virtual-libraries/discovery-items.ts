import {
  listBody,
  parameter,
  result,
  setParameter,
  UpstreamQueryError,
  type QueryUpstream,
  type UpstreamJson,
  type VirtualQueryStore,
} from "./query-helpers";
import { authenticate } from "./query-scope";
import { overlayLibraries } from "./owned-library-overlay";

interface DiscoveryContext {
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
}

function identity(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^[a-f\d]{32}$/i.test(value) || /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : value;
}

/** Add owned folders without changing upstream discovery queries or DTOs. */
export async function discoveryItems({ url, store, upstream }: DiscoveryContext): Promise<UpstreamJson | undefined> {
  const folders = /^\/Library\/MediaFolders\/?$/i.test(url.pathname);
  const byIds = /^\/(?:Users\/[^/]+\/)?Items\/?$/i.test(url.pathname);
  if (!folders && (!byIds || parameter(url, "ParentId") !== undefined || !parameter(url, "Ids"))) return undefined;
  const ids = (parameter(url, "Ids") ?? "").split(",").filter(Boolean);
  const libraries = new Map(store.list().map((library) => [identity(library.id), library.id]));
  const virtualIds = [...new Set(ids.map((id) => libraries.get(identity(id))).filter((id): id is string => !!id))];
  if (!store.list().length || (!folders && !virtualIds.length)) return undefined;
  try {
    if (folders) return overlayLibraries({ url, store, upstream, reply: await upstream(url) });
    const realIds = ids.filter((id) => !libraries.has(identity(id)));
    let reply: UpstreamJson;
    let serverId: unknown;
    if (realIds.length) {
      const target = new URL(url);
      // Remove only owned IDs; preserve every other parameter and upstream entry.
      setParameter(target, "Ids", realIds.join(","));
      reply = await upstream(target);
    } else {
      // Never broaden an all-owned lookup into an empty-Ids upstream scan.
      const probe = await authenticate(upstream, url);
      serverId = listBody(probe.body).Items.find((item) => item.ServerId)?.ServerId;
      reply = result({ Items: [], TotalRecordCount: 0 });
    }
    return overlayLibraries({ url, store, upstream, reply, onlyIds: virtualIds, serverId });
  } catch (error) {
    if (error instanceof UpstreamQueryError) return error.result;
    throw error;
  }
}
