/** 热点数据来源。 */
export type TrendingSource = "tmdb" | "imdb" | "douban";

/** 首页热点区块的稳定 key（前端按此渲染卡片流）。 */
export type TrendingSectionKey =
  | "tmdb_trending" // 影片趋势（近 7 天 trending）
  | "tmdb_hot" // TMDB 热门
  | "imdb_hot" // IMDB 热门（经 TMDB 代理）
  | "imdb_top" // IMDB Top（经 TMDB 高分代理）
  | "douban_hot" // 豆瓣热门
  | "douban_top250"; // 豆瓣 Top250

export interface TrendingItem {
  /** 来源内的稳定 id（如 "tmdb:603"、"douban:1292052"）。 */
  id: string;
  title: string;
  originalTitle?: string;
  mediaType: "movie" | "tv";
  year: number | null;
  posterUrl: string | null;
  /** 0-10 评分；非评分型榜单（如票房）可为 null。 */
  rating: number | null;
  /** 一句话简介（TMDB 等来源提供时填充，仅用于详情展示）。 */
  overview?: string | null;
  /** 在当前榜单中的名次（1 起）。 */
  rank: number;
  source: TrendingSource;
  externalUrl?: string;
  /** 尽力匹配到的 TMDB id，用于“一键投稿”。 */
  tmdbId?: number | null;
  /** TMDB 横版背景图（仅在可用时提供，用于首页焦点/大卡）。 */
  backdropUrl?: string | null;
  /** 该片是否已在媒体库（由公开榜单路由按 TMDB id 批量匹配）。 */
  inLibrary?: boolean;
  /** 已在库时提供的 Emby“去观看”链接。 */
  watchUrl?: string | null;
}

export interface TrendingSection {
  key: TrendingSectionKey;
  label: string;
  source: TrendingSource;
  items: TrendingItem[];
  /** 数据抓取/更新时间戳。 */
  updatedAt: number;
  /** 是否处于降级状态（缓存过期但抓取失败/被限流）。 */
  stale: boolean;
}

/** 每个区块的配置（来源层持久化在 DB，运行时合并默认值）。 */
export interface TrendingSectionConfig {
  key: TrendingSectionKey;
  source: TrendingSource;
  label: string;
  enabled: boolean;
  /** 缓存时长（毫秒）。 */
  ttlMs: number;
  /** 后台刷新间隔（毫秒）。 */
  refreshMs: number;
}

export interface TrendingResult {
  sections: TrendingSection[];
  updatedAt: number;
  /** 本次降级/失败的数据源。 */
  degradedSources: TrendingSource[];
  /** 所选来源正在后台刷新；快照读取不会等待它。 */
  refreshing?: boolean;
}

/** 缓存存储接口：Redis 生产用、内存测试/兜底用。 */
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}
