import type { IncomingMessage, ServerResponse } from "node:http";
import type { VirtualLibraryStore } from "./store";
import { handleVirtualQuery } from "./queries";
import { forwardRequest, upstreamJson, type ProxyTarget } from "./proxy-transport";
import { createProxyMappingRepair } from "./proxy-mapping-repair";
import { parameter } from "./query-helpers";

export function createVirtualProxyHandler(store: VirtualLibraryStore, upstream: () => string, marker: string) {
  const repairMappings = createProxyMappingRepair(store);
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.headers["x-task-center-proxy"] === marker) {
        response.writeHead(508).end();
        return;
      }
      request.headers["x-task-center-proxy"] = marker;
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      request.once("aborted", () => abort.abort());
      const context: ProxyTarget = { upstream: upstream(), request, response, signal: abort.signal };
      const url = new URL(request.url ?? "/", "http://proxy.local");
      url.pathname = url.pathname.replace(/^\/emby(?=\/|$)/i, "") || "/";
      const image = /^\/Items\/([^/]+)\/Images\/(Primary|Thumb|Backdrop)(?:\/\d+)?$/i.exec(url.pathname);
      const detail = /^\/(?:Users\/[^/]+\/)?Items\/([^/]+)\/?$/i.exec(url.pathname);
      const virtualId = parameter(url, "ParentId") ?? image?.[1] ?? detail?.[1];
      if (request.method === "GET" && virtualId && store.get(virtualId)) {
        await repairMappings(
          virtualId,
          request,
          url,
          context.upstream,
          (target) => upstreamJson(context, target),
          context.signal,
        );
      }
      if (image && (request.method === "GET" || request.method === "HEAD") && store.get(image[1]!)) {
        const first = store.listItems(image[1]!).find((item) => item.imageTag);
        if (first) {
          const prefix = /^\/emby\//i.test(request.url ?? "") ? "/emby" : "";
          forwardRequest(context, `${prefix}/Items/${encodeURIComponent(first.itemId)}/Images/Primary${url.search}`);
        } else {
          response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-cache" });
          response.end(
            request.method === "HEAD"
              ? undefined
              : '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340" viewBox="0 0 600 340"><rect width="600" height="340" rx="20" fill="#14252f"/><path d="M210 100h75l22 26h83v115H210Z" fill="#67bf74"/><path d="m285 151 48 30-48 30Z" fill="#14252f"/></svg>',
          );
        }
        return;
      }
      if (
        await handleVirtualQuery({
          request,
          response,
          url,
          store,
          upstream: (target, timeoutMs) => upstreamJson(context, target, timeoutMs),
        })
      )
        return;
      const deleted = request.method === "DELETE" ? /^\/Items\/([^/]+)\/?$/i.exec(url.pathname)?.[1] : undefined;
      forwardRequest(
        context,
        request.url ?? "/",
        deleted
          ? () => {
              try {
                store.removeItemEverywhere(decodeURIComponent(deleted));
              } catch {
                /* A later read can still show an absent upstream item. */
              }
            }
          : undefined,
      );
    } catch {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else
        response
          .writeHead(502, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "virtual_proxy_upstream_unavailable" }));
    }
  };
}
