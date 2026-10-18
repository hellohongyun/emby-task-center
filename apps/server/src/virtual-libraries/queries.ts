import type { IncomingMessage, ServerResponse } from "node:http";
import {
  checked,
  integerParameter,
  listBody,
  parameter,
  result,
  setParameter,
  sendJson,
  UpstreamQueryError,
  type Item,
  type QueryUpstream,
  type VirtualQueryStore,
} from "./query-helpers";
import { authenticate, queryScope } from "./query-scope";
import { facetQuery } from "./query-facets";
import { orderUserViews } from "./view-order";
export type { UpstreamJson } from "./query-helpers";

interface QueryContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
}

function dto(store: VirtualQueryStore, id: string, serverId?: unknown): Item {
  const library = store.get(id)!;
  const cover = store.listItems(id).find((item) => item.imageTag);
  return {
    Id: library.id,
    Name: library.name,
    SortName: library.name,
    Type: "CollectionFolder",
    IsFolder: true,
    CollectionType: library.collectionType === "mixed" ? null : library.collectionType,
    Subviews:
      library.collectionType === "movies"
        ? ["movies", "genres", "folders"]
        : library.collectionType === "tvshows"
          ? ["series", "genres", "folders"]
          : ["movies", "series", "genres", "folders"],
    ChildCount: library.itemCount,
    DisplayPreferencesId: library.id,
    DateCreated: library.createdAt,
    ImageTags: cover?.imageTag ? { Primary: cover.imageTag } : {},
    ...(serverId ? { ServerId: serverId } : {}),
  };
}

function rootQuery(url: URL) {
  if (!/^\/(Users\/[^/]+\/)?Items\/?$/i.test(url.pathname)) return false;
  if (parameter(url, "ParentId")) return false;
  if (parameter(url, "Ids") !== undefined || parameter(url, "Recursive")?.toLowerCase() === "true") return false;
  const types = parameter(url, "IncludeItemTypes");
  return !types || types.split(",").some((type) => /^(CollectionFolder|Folder)$/i.test(type));
}

async function appendLibraries(context: QueryContext) {
  const { url, store, upstream } = context;
  const views = /^\/Users\/[^/]+\/Views\/?$/i.test(url.pathname);
  const source = new URL(url);
  if (views) {
    setParameter(source, "StartIndex");
    setParameter(source, "Limit");
  }
  const response = await checked(upstream, source);
  const original = listBody(response.body);
  const serverId = original.Items.find((item) => item.ServerId)?.ServerId;
  let additions = store.list().map((library) => dto(store, library.id, serverId));
  const search = parameter(url, "SearchTerm")?.toLocaleLowerCase();
  if (search) additions = additions.filter((item) => String(item.Name).toLocaleLowerCase().includes(search));
  const start = integerParameter(url, "StartIndex", 0);
  const total = original.TotalRecordCount ?? original.Items.length;
  const limit = integerParameter(url, "Limit", Number.MAX_SAFE_INTEGER);
  if (views) {
    const ordered = await orderUserViews(url, [...original.Items, ...additions], upstream);
    return {
      ...response,
      body: { ...original, Items: ordered.slice(start, start + limit), TotalRecordCount: total + additions.length },
    };
  }
  const available = Math.max(0, limit - original.Items.length);
  const offset = Math.max(0, start - total);
  const items = [...original.Items, ...additions.slice(offset, offset + available)];
  return { ...response, body: { ...original, Items: items, TotalRecordCount: total + additions.length } };
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
  const root = rootQuery(url);
  if (!library && !parentLibrary && !views && !root) return false;
  try {
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
