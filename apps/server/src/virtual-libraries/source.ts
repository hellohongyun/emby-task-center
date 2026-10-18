import type { AppDatabase } from "@emby-task-center/database/client";
import { normalizeVirtualLibraryTmdbId, type VirtualLibraryItem } from "@emby-task-center/contracts/virtual-library";
import { readSettings } from "../settings/store";
import { discardBody } from "../util/http";

interface EmbyItem {
  Id: string;
  Name: string;
  Type?: string;
  ProductionYear?: number;
  ImageTags?: { Primary?: string };
  ProviderIds?: { Tmdb?: unknown };
}

export class VirtualLibrarySourceError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

export interface SourceItemsQuery {
  searchTerm?: string;
  parentId?: string;
  startIndex?: number;
  limit?: number;
  types?: "Movie" | "Series" | "Movie,Series";
}

function normalize(item: EmbyItem): VirtualLibraryItem {
  const tmdbId = normalizeVirtualLibraryTmdbId(item.ProviderIds?.Tmdb);
  return {
    itemId: item.Id,
    name: item.Name,
    type: item.Type ?? "",
    year: item.ProductionYear ?? null,
    imageTag: item.ImageTags?.Primary ?? null,
    ...(tmdbId ? { tmdbId } : {}),
  };
}

function validItem(value: unknown): value is EmbyItem {
  if (!value || typeof value !== "object") return false;
  const item = value as EmbyItem;
  return typeof item.Id === "string" && item.Id.length > 0 && typeof item.Name === "string";
}

export function createVirtualLibrarySource(database: AppDatabase, fetcher: typeof fetch = fetch) {
  async function request(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const { values } = readSettings(database);
    const baseUrl = values["emby.baseUrl"];
    const apiKey = values["emby.apiKey"];
    if (!baseUrl || !apiKey) throw new VirtualLibrarySourceError("请先在系统设置配置 Emby 地址和 API Key", 503);
    let url: URL;
    try {
      url = new URL(`${baseUrl.replace(/\/+$/, "")}/${path}`);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    } catch {
      throw new VirtualLibrarySourceError("Emby 地址无效，请检查系统设置", 503);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response | undefined;
    try {
      response = await fetcher(url, {
        headers: { "X-Emby-Token": apiKey, accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        discardBody(response);
        throw new VirtualLibrarySourceError(`Emby 请求失败（HTTP ${response.status}）`);
      }
      try {
        return await response.json();
      } catch {
        throw new VirtualLibrarySourceError(
          controller.signal.aborted ? "Emby 请求超时" : "Emby 返回了无效的 JSON 数据",
        );
      }
    } catch (error) {
      discardBody(response);
      if (error instanceof VirtualLibrarySourceError) throw error;
      throw new VirtualLibrarySourceError(
        controller.signal.aborted ? "Emby 请求超时" : "无法连接 Emby，请检查地址及网络",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function queryItems(params: Record<string, string>) {
    const payload = await request("Items", params);
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { Items?: unknown }).Items)) {
      throw new VirtualLibrarySourceError("Emby 返回了无效的影片列表");
    }
    const result = payload as { Items: unknown[]; TotalRecordCount?: number };
    if (!result.Items.every(validItem)) throw new VirtualLibrarySourceError("Emby 返回了无效的影片条目");
    return { items: result.Items.map(normalize), total: result.TotalRecordCount ?? result.Items.length };
  }

  async function lookupItems(itemIds: string[]): Promise<VirtualLibraryItem[]> {
    const ids = [...new Set(itemIds)];
    const found = new Map<string, VirtualLibraryItem>();
    for (let start = 0; start < ids.length; start += 50) {
      const chunk = ids.slice(start, start + 50);
      const result = await queryItems({
        Ids: chunk.join(","),
        Recursive: "true",
        Fields: "ProductionYear,ProviderIds",
        Limit: String(chunk.length),
      });
      for (const item of result.items) if (chunk.includes(item.itemId)) found.set(item.itemId, item);
    }
    return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
  }

  return {
    async libraries(): Promise<{ id: string; name: string }[]> {
      const payload = await request("Library/VirtualFolders");
      if (!Array.isArray(payload)) throw new VirtualLibrarySourceError("Emby 返回了无效的媒体库列表");
      return payload.flatMap((entry: { ItemId?: string; Name?: string }) =>
        typeof entry?.ItemId === "string" && typeof entry.Name === "string"
          ? [{ id: entry.ItemId, name: entry.Name }]
          : [],
      );
    },
    async search(query: SourceItemsQuery) {
      const params: Record<string, string> = {
        Recursive: "true",
        StartIndex: String(query.startIndex ?? 0),
        Limit: String(query.limit ?? 50),
        Fields: "ProductionYear,ProviderIds",
        SortBy: "SortName",
        SortOrder: "Ascending",
        EnableTotalRecordCount: "true",
        IncludeItemTypes: query.types ?? "Movie,Series",
      };
      if (query.searchTerm) params.SearchTerm = query.searchTerm;
      if (query.parentId) params.ParentId = query.parentId;
      return queryItems(params);
    },
    lookupItems,
    async getItems(itemIds: string[]): Promise<VirtualLibraryItem[]> {
      const items = await lookupItems(itemIds);
      if (items.length !== new Set(itemIds).size) {
        throw new VirtualLibrarySourceError("部分所选条目已不存在于 Emby，请刷新后重试", 400);
      }
      return items;
    },
    async findByTmdb(type: string, value: string): Promise<VirtualLibraryItem[]> {
      const tmdbId = normalizeVirtualLibraryTmdbId(value);
      if (!tmdbId || !["Movie", "Series"].includes(type)) return [];
      const found = new Map<string, VirtualLibraryItem>();
      const seen = new Set<string>();
      for (let startIndex = 0; ;) {
        const result = await queryItems({
          Recursive: "true",
          IncludeItemTypes: type,
          AnyProviderIdEquals: `Tmdb.${tmdbId}`,
          Fields: "ProductionYear,ProviderIds",
          EnableTotalRecordCount: "true",
          StartIndex: String(startIndex),
          Limit: "100",
        });
        if (!result.items.length) break;
        if (result.items.some((item) => item.type !== type || item.tmdbId !== tmdbId)) {
          throw new VirtualLibrarySourceError("Emby 未正确执行作品身份筛选，请稍后重试");
        }
        const unseen = result.items.filter((item) => !seen.has(item.itemId));
        if (!unseen.length) throw new VirtualLibrarySourceError("Emby 返回了重复的分页结果，请稍后重试");
        for (const item of result.items) {
          seen.add(item.itemId);
          found.set(item.itemId, item);
        }
        startIndex += result.items.length;
        if (result.items.length < 100) break;
      }
      return [...found.values()];
    },
  };
}
