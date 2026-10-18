import type { EmbyLibraryItem } from "./emby-client";
import { fetchAllEmbyItems, type EmbyItemsGet } from "./emby-pagination";
import { isUnnumberedEmbySpecial, validateEmbyEpisodeRange } from "./emby-episode-range";

/** .NET 时间戳裁到毫秒，供时间字符串排序。 */
export function normalizeEmbyDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.replace(/(\.\d{3})\d+Z$/, "$1Z");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 这些方法成功返回的数组始终来自完整、已验证的分页结果。 */
export function createEmbyLibraryReader(get: EmbyItemsGet) {
  return {
    async listLibraryItems(
      query: { mediaType?: "movie" | "tv"; limit?: number; libraryId?: string } = {},
    ): Promise<EmbyLibraryItem[]> {
      const params = new URLSearchParams({
        Recursive: "true",
        IncludeItemTypes: query.mediaType === "movie" ? "Movie" : query.mediaType === "tv" ? "Series" : "Movie,Series",
        Fields: "ProviderIds,ProductionYear,ImageTags,Genres,DateCreated",
      });
      if (query.libraryId) params.set("ParentId", query.libraryId);
      const items = await fetchAllEmbyItems(get, params, query.limit);
      return items.map((item): EmbyLibraryItem => {
        const type = item.Type === "Movie" ? "movie" : item.Type === "Series" ? "tv" : null;
        if (
          !type ||
          (query.mediaType && query.mediaType !== type) ||
          typeof item.Name !== "string" ||
          !item.Name.trim()
        ) {
          throw new Error("emby_library_invalid_item");
        }
        const rawTmdb = record(item.ProviderIds)?.Tmdb;
        const tmdbId = typeof rawTmdb === "string" ? Number(rawTmdb) : typeof rawTmdb === "number" ? rawTmdb : null;
        return {
          id: item.Id,
          name: item.Name,
          year:
            item.ProductionYear != null &&
            Number.isInteger(Number(item.ProductionYear)) &&
            Number(item.ProductionYear) > 0
              ? Number(item.ProductionYear)
              : null,
          type,
          tmdbId: Number.isInteger(tmdbId) ? tmdbId : null,
          hasPrimaryImage: typeof record(item.ImageTags)?.Primary === "string",
          dateCreated: normalizeEmbyDate(item.DateCreated),
          genres: Array.isArray(item.Genres)
            ? item.Genres.filter((genre): genre is string => typeof genre === "string")
            : [],
        };
      });
    },
    async listItemEpisodes(seriesId: string) {
      const items = await fetchAllEmbyItems(
        get,
        new URLSearchParams({
          ParentId: seriesId,
          Recursive: "true",
          IncludeItemTypes: "Episode",
          Fields: "IndexNumber,IndexNumberEnd,ParentIndexNumber",
        }),
      );
      return items.map((episode) => {
        // 未编号 S00 特别篇保留库存；正片缺号仍拒绝整轮，避免发布不完整的正片集合。
        if (episode.Type !== undefined && episode.Type !== "Episode") throw new Error("emby_episode_invalid_type");
        const unnumberedSpecial = isUnnumberedEmbySpecial({
          seasonNumber: episode.ParentIndexNumber,
          episodeNumber: episode.IndexNumber,
          episodeNumberEnd: episode.IndexNumberEnd,
        });
        if (!unnumberedSpecial) validateEmbyEpisodeRange(episode.IndexNumber, episode.IndexNumberEnd);
        if (
          episode.ParentIndexNumber != null &&
          (!Number.isSafeInteger(episode.ParentIndexNumber) || (episode.ParentIndexNumber as number) < 0)
        ) {
          throw new Error("emby_episode_invalid_season");
        }
        return {
          id: episode.Id,
          seasonNumber: Number.isInteger(episode.ParentIndexNumber) ? (episode.ParentIndexNumber as number) : null,
          episodeNumber: unnumberedSpecial ? null : (episode.IndexNumber as number),
          ...(episode.IndexNumberEnd == null ? {} : { episodeNumberEnd: episode.IndexNumberEnd as number }),
          name: typeof episode.Name === "string" && episode.Name.trim() ? episode.Name : null,
        };
      });
    },
  };
}
