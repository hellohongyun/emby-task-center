import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listBody,
  parameter,
  result,
  sendJson,
  UpstreamQueryError,
  type QueryUpstream,
  type VirtualQueryStore,
} from "./query-helpers";
import { authenticate, queryScope } from "./query-scope";
import { facetQuery } from "./query-facets";
import { overlayLibraries } from "./owned-library-overlay";
import { libraryDto as dto } from "./library-dto";
import { homeSectionItems } from "./home-sections";
import { discoveryItems } from "./discovery-items";
export type { UpstreamJson } from "./query-helpers";

interface QueryContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
  homeSections?: unknown;
}

async function appendLibraries(context: QueryContext) {
  const { url, store, upstream } = context;
  return overlayLibraries({ url, store, upstream, reply: await upstream(url) });
}

export async function handleVirtualQuery(context: QueryContext): Promise<boolean> {
  if (context.request.method !== "GET") return false;
  const { url, store, upstream, response } = context;
  if (store.list().length === 0) return false;
  const path = url.pathname;
  const detail = /^\/(?:Users\/[^/]+\/)?Items\/([^/]+)\/?$/i.exec(path);
  const library = detail ? store.get(decodeURIComponent(detail[1])) : undefined;
  const parent = parameter(url, "ParentId");
  const parentLibrary = parent ? store.get(parent) : undefined;
  const scoped =
    /^\/(?:Users\/[^/]+\/)?Items(?:\/(?:Latest|Resume))?\/?$/i.test(path) || /^\/Shows\/NextUp\/?$/i.test(path);
  const views = /^\/Users\/[^/]+\/Views\/?$/i.test(path);
  try {
    if (!library && !parentLibrary) {
      const discovery = (await homeSectionItems(context)) ?? (await discoveryItems(context));
      if (discovery) {
        sendJson(response, discovery);
        return true;
      }
    }
    if (!library && !parentLibrary && !views) return false;
    if (library) {
      const probe = await authenticate(upstream, url);
      const serverId = listBody(probe.body).Items[0]?.ServerId;
      sendJson(response, result(dto(store, library.id, serverId)));
    } else if (parentLibrary && scoped) {
      sendJson(response, await queryScope(store, parentLibrary.id, url, upstream));
    } else if (parentLibrary && /^\/(Items\/(Filters2?|Counts)|Genres|Studios|Tags|Years)\/?$/i.test(path)) {
      sendJson(response, await facetQuery(store, parentLibrary.id, url, upstream));
    } else if (parentLibrary) {
      // 不把虚拟 ParentId 传给上游，未知的库级查询返回明确的协议错误。
      await authenticate(upstream, url);
      sendJson(response, { status: 400, headers: {}, body: { error: "此虚拟媒体库查询暂不支持" } });
    } else {
      sendJson(response, await appendLibraries(context));
    }
    return true;
  } catch (error) {
    if (!(error instanceof UpstreamQueryError)) throw error;
    sendJson(response, error.result);
    return true;
  }
}
