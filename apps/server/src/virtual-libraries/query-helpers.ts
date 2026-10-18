import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { createVirtualLibraryStore } from "./store";
import { proxyHeaders } from "./proxy-transport";

export type VirtualQueryStore = Pick<ReturnType<typeof createVirtualLibraryStore>, "list" | "get" | "listItems">;
export interface UpstreamJson {
  status: number;
  headers: IncomingHttpHeaders;
  body: unknown;
  raw?: Buffer;
}
export type QueryUpstream = (url: URL, timeoutMs?: number) => Promise<UpstreamJson>;
export type Item = Record<string, unknown> & { Id?: string };

export class UpstreamQueryError extends Error {
  constructor(public result: UpstreamJson) {
    super(`Emby HTTP ${result.status}`);
  }
}

export function parameter(url: URL, name: string): string | undefined {
  return [...url.searchParams].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
export function setParameter(url: URL, name: string, value?: string) {
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === name.toLowerCase()) url.searchParams.delete(key);
  }
  if (value !== undefined) url.searchParams.set(name, value);
}
export function integerParameter(url: URL, key: string, fallback: number) {
  const raw = parameter(url, key);
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
}
export function itemsPath(url: URL) {
  const user = /^\/Users\/([^/]+)\//i.exec(url.pathname)?.[1];
  return user ? `/Users/${user}/Items` : "/Items";
}
export function authenticationUrl(url: URL, path = itemsPath(url)) {
  const target = new URL(path, url.origin);
  for (const [key, value] of url.searchParams) {
    if (/^(api_key|apikey|token|x-emby-token|userid)$/i.test(key)) target.searchParams.append(key, value);
  }
  return target;
}
export async function checked(upstream: QueryUpstream, url: URL) {
  const result = await upstream(url);
  if (result.status < 200 || result.status >= 300) throw new UpstreamQueryError(result);
  return result;
}
export function listBody(body: unknown): { Items: Item[]; TotalRecordCount?: number } {
  const value = Array.isArray(body) ? { Items: body } : body;
  if (!value || typeof value !== "object" || !Array.isArray((value as { Items?: unknown }).Items)) {
    throw new UpstreamQueryError({ status: 502, headers: {}, body: { error: "Emby 返回了无效的媒体列表" } });
  }
  return value as { Items: Item[]; TotalRecordCount?: number };
}
export async function allPages(upstream: QueryUpstream, source: URL): Promise<Item[]> {
  const url = new URL(source);
  setParameter(url, "EnableTotalRecordCount", "true");
  setParameter(url, "Limit", "200");
  const items: Item[] = [];
  const pages = new Set<string>();
  for (let offset = 0; ;) {
    setParameter(url, "StartIndex", String(offset));
    const page = listBody((await checked(upstream, url)).body);
    if (!page.Items.length) break;
    const signature = JSON.stringify(page.Items.map((item) => item.Id));
    if (pages.has(signature)) {
      throw new UpstreamQueryError({ status: 502, headers: {}, body: { error: "Emby 未正确处理分页查询" } });
    }
    pages.add(signature);
    items.push(...page.Items);
    offset += page.Items.length;
    if (typeof page.TotalRecordCount === "number" && offset >= page.TotalRecordCount) break;
  }
  return items;
}
export function sendJson(response: ServerResponse, result: UpstreamJson) {
  response.statusCode = result.status;
  if ((result.status < 200 || result.status >= 300) && result.raw) {
    for (const [key, value] of Object.entries(proxyHeaders(result.headers))) {
      if (value !== undefined) response.setHeader(key, value);
    }
    response.end(result.raw);
    return;
  }
  // 上游压缩、长度和缓存校验头不适用于重写后的 JSON。
  for (const key of ["www-authenticate", "retry-after", "set-cookie", "access-control-allow-origin", "location"]) {
    const value = result.headers[key];
    if (value !== undefined) response.setHeader(key, value);
  }
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(result.body));
}
export function result(body: unknown): UpstreamJson {
  return { status: 200, headers: {}, body };
}
