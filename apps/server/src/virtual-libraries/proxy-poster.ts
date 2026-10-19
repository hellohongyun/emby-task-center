import type { VirtualLibraryStore } from "./store";
import { authenticate } from "./query-scope";
import { listBody, parameter, sendJson, UpstreamQueryError } from "./query-helpers";
import { upstreamJson, type ProxyTarget } from "./proxy-transport";

/** Only locally owned poster IDs are handled; original media images stay upstream. */
export async function serveOwnedPoster(context: ProxyTarget, url: URL, store: VirtualLibraryStore) {
  if (context.request.method !== "GET" && context.request.method !== "HEAD") return false;
  const image = /^\/Items\/([^/]+)\/Images\/(Primary|Thumb|Backdrop)(?:\/\d+)?$/i.exec(url.pathname);
  if (!image || !store.get(image[1])) return false;
  const poster = store.getPoster(image[1]);
  if (!poster) return false;
  // Emby image elements carry the advertised image tag, not an API token.
  // A current exact tag grants access to this poster only; other requests still
  // use their own credentials, never the configured administrator key.
  if (parameter(url, "tag") !== poster.imageTag) {
    try {
      const probe = await authenticate((target) => upstreamJson(context, target), url);
      listBody(probe.body);
    } catch (error) {
      if (!(error instanceof UpstreamQueryError)) throw error;
      sendJson(context.response, error.result);
      return true;
    }
  }
  const etag = `"${poster.imageTag}"`;
  const headers = {
    "content-type": poster.contentType,
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    etag,
  };
  if (context.request.headers["if-none-match"]?.split(",").some((value) => value.trim() === etag)) {
    context.response.writeHead(304, headers).end();
  } else {
    context.response.writeHead(200, { ...headers, "content-length": poster.content.length });
    context.response.end(context.request.method === "HEAD" ? undefined : poster.content);
  }
  return true;
}
