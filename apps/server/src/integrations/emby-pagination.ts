export type EmbyItemsGet = (query: URLSearchParams) => Promise<unknown>;
export type EmbyRawItem = Record<string, unknown> & { Id: string };

const DEFAULT_PAGE_SIZE = 500;
const MAX_ITEMS = 1_000_000;
const MAX_PAGES = 10_000;

/**
 * 仅在所有页的总数一致、ID 不重叠、累计数等于总数时返回。
 * 成功 HTTP 响应不等于完整库存：错误或截断只抛异常，不向调用方泄漏已收集的部分结果。
 */
export async function fetchAllEmbyItems(
  get: EmbyItemsGet,
  query: URLSearchParams,
  requestedPageSize = DEFAULT_PAGE_SIZE,
): Promise<EmbyRawItem[]> {
  const pageSize =
    Number.isFinite(requestedPageSize) && requestedPageSize > 0
      ? Math.max(1, Math.min(1_000, Math.floor(requestedPageSize)))
      : DEFAULT_PAGE_SIZE;
  const items: EmbyRawItem[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams(query);
    params.set("StartIndex", String(items.length));
    params.set("Limit", String(pageSize));
    params.set("EnableTotalRecordCount", "true");
    params.set("SortBy", "SortName");
    params.set("SortOrder", "Ascending");
    const response = await get(params);
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("emby_pagination_invalid_response");
    }
    const body = response as Record<string, unknown>;
    if (!Array.isArray(body.Items)) throw new Error("emby_pagination_invalid_items");
    if (
      typeof body.TotalRecordCount !== "number" ||
      !Number.isSafeInteger(body.TotalRecordCount) ||
      body.TotalRecordCount < 0
    ) {
      throw new Error("emby_pagination_invalid_total");
    }
    if (body.TotalRecordCount > MAX_ITEMS) throw new Error("emby_pagination_limit_exceeded");
    if (total !== undefined && body.TotalRecordCount !== total) throw new Error("emby_pagination_total_changed");
    total = body.TotalRecordCount;
    if (body.StartIndex !== undefined && body.StartIndex !== items.length)
      throw new Error("emby_pagination_offset_mismatch");
    if (body.Items.length > pageSize || items.length + body.Items.length > total)
      throw new Error("emby_pagination_count_mismatch");
    if (!body.Items.length && items.length < total) throw new Error("emby_pagination_truncated");
    for (const value of body.Items) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("emby_pagination_invalid_item");
      const item = value as Record<string, unknown>;
      if (typeof item.Id !== "string" || !item.Id.trim()) throw new Error("emby_pagination_invalid_id");
      if (seen.has(item.Id)) throw new Error("emby_pagination_duplicate_id");
      seen.add(item.Id);
      items.push(item as EmbyRawItem);
    }
    if (items.length === total) return items;
  }
  throw new Error("emby_pagination_limit_exceeded");
}
