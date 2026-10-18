import type { TrendingSection, TrendingSectionKey, TrendingSource } from "../types";
import type { TrendingAdapter } from "./common";
import { createTmdbAdapter } from "./tmdb";
import { createImdbAdapter } from "./imdb";
import { createDoubanAdapter } from "./douban";

export function createTrendingAdapters(): Record<TrendingSource, TrendingAdapter> {
  return {
    tmdb: createTmdbAdapter(),
    imdb: createImdbAdapter(),
    douban: createDoubanAdapter(),
  };
}

/** 每个区块的稳定 key / 来源 / 展示名（缓存与刷新配置在 source 级别）。 */
export interface DefaultSection {
  key: TrendingSectionKey;
  source: TrendingSource;
  label: string;
}

export interface DefaultSourceSettings {
  enabled: boolean;
  ttlMs: number;
  refreshMs: number;
}

export const DEFAULT_SECTIONS: DefaultSection[] = [
  { key: "douban_hot", source: "douban", label: "豆瓣热门" },
  { key: "tmdb_trending", source: "tmdb", label: "影片趋势" },
  { key: "tmdb_hot", source: "tmdb", label: "TMDB 热门" },
  { key: "imdb_hot", source: "imdb", label: "IMDB 热门" },
  { key: "imdb_top", source: "imdb", label: "IMDB Top" },
  { key: "douban_top250", source: "douban", label: "豆瓣 Top250" },
];

/** 各来源的默认启用/缓存/刷新设置。 */
export const DEFAULT_SOURCE_SETTINGS: Record<TrendingSource, DefaultSourceSettings> = {
  tmdb: { enabled: true, ttlMs: 60 * 60_000, refreshMs: 30 * 60_000 },
  imdb: { enabled: true, ttlMs: 2 * 60 * 60_000, refreshMs: 60 * 60_000 },
  douban: { enabled: true, ttlMs: 30 * 60_000, refreshMs: 30 * 60_000 },
};

export function defaultSourceConfigs(source: TrendingSource): DefaultSourceSettings {
  return DEFAULT_SOURCE_SETTINGS[source];
}

export type { TrendingAdapter, TrendingSection };
