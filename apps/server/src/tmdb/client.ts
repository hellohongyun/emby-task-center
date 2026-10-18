import { createTmdbRequest } from "./request";
import { parseEpisodeMetadata, parseSeasonMetadata } from "./episode-metadata";

export type TmdbFetch = typeof fetch;
export type TmdbMediaType = "movie" | "tv";

export interface TmdbSeason {
  seasonNumber: number;
  name: string | null;
  episodeCount: number;
  airDate: string | null;
}

/** 分集级信息：缺集总览要显示「S05E18 · 三年之约」就必须拿到集名。 */
export interface TmdbEpisode {
  episodeNumber: number;
  name: string | null;
  airDate: string | null;
}

export interface TmdbMedia {
  id: number;
  mediaType: TmdbMediaType;
  title: string;
  originalTitle: string;
  releaseYear: number | null;
  /** 完整上映/首播日期（YYYY-MM-DD），搜索结果显示用。 */
  releaseDate?: string | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  /** tv 总集数与季列表（创建任务时选季/展示用）。 */
  totalEpisodes?: number | null;
  seasons?: TmdbSeason[];
  /** tv 已播集数（整剧聚合；搜索时并发补算）。 */
  airedEpisodes?: number | null;
  /** 详情页扩展信息（仅 details 接口有值）。 */
  runtime?: number | null;
  genres?: string[];
  status?: string | null;
  voteAverage?: number | null;
  directors?: string[];
  cast?: string[];
  castAvatars?: Array<{ name: string; character: string | null; avatarUrl: string | null }>;
  /** YouTube 官方预告 key（详情页“播放预告”用）。 */
  trailerKey?: string | null;
  budget?: number | null;
  revenue?: number | null;
}

export interface TmdbClient {
  search(query: string): Promise<TmdbMedia[]>;
  details(type: TmdbMediaType, id: number): Promise<TmdbMedia>;
  seasonProgress(tvId: number, seasonNumber: number, now?: Date, graceHours?: number): Promise<TmdbSeasonProgress>;
  seasonEpisodes(tvId: number, seasonNumber: number): Promise<TmdbEpisode[]>;
  airedEpisodeCount(tvId: number, now?: Date): Promise<number>;
}

/** "YYYY-MM-DD" → 当天本地 00:00 的时间戳（TMDB 只给日期，没有时刻，一律按本地日历日算）。 */
export function localDateMs(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
}

/**
 * 这一集是否已经"播够了、该入库了"——播出的当天 00:00 + 宽限期之前，都还不算缺集。
 *
 * 默认 24 小时 = 次日 0 点起算：当天 18 点更新、20 点入库的集，白天不会被报成缺集；
 * 次日仍未入库就正常落进缺集清单，所以不会漏报。宽限期 0 = 旧口径（当天即算）。
 */
export function isEpisodeAiredEnough(airDate: string, now: Date, graceHours: number): boolean {
  const airedAt = localDateMs(airDate);
  if (airedAt === null) return false;
  const graceMs = Math.max(0, graceHours) * 60 * 60 * 1_000;
  return airedAt + graceMs <= now.getTime();
}

export interface TmdbSeasonProgress {
  seasonNumber: number;
  airedEpisodes: number;
  totalEpisodes: number;
  lastAirDate: string | null;
  nextAirDate: string | null;
  /**
   * 已播出、但仍在"等待入库"宽限期内的集数（默认口径 = 当天播出、次日 0 点前）——界面标「今日更新」。
   *
   * 为什么需要它：TMDB 的 air_date 只有日期、没有时刻，"今天 18 点更新"从当天 00:00 起就算已播，
   * 而片源要到晚上才入库，白天按 `airedEpisodes` 比对就会把这一集误报成缺集（8 点看到"缺集"）。
   * 宽限期由设置项 `library.missingGraceHours` 决定；`graceHours = 0` 时恒为 0（旧口径）。
   *
   * 可选：老测试替身/老实现可能没有这个字段，消费方一律按 0 处理。
   */
  pendingEpisodes?: number;
}

export interface TmdbClientOptions {
  token: string;
  timeoutMs?: number;
  fetchImpl?: TmdbFetch;
  apiBaseUrl?: string;
  imageBaseUrl?: string;
}

export function createTmdbClient(options: TmdbClientOptions): TmdbClient {
  const request = createTmdbRequest(options);
  const imageBaseUrl = options.imageBaseUrl ?? "https://image.tmdb.org/t/p";

  async function seasonProgress(
    tvId: number,
    seasonNumber: number,
    now = new Date(),
    graceHours = 0,
  ): Promise<TmdbSeasonProgress> {
    const payload = await request(`/tv/${tvId}/season/${seasonNumber}`, new URLSearchParams({ language: "zh-CN" }));
    if (!isRecord(payload) || !Array.isArray(payload.episodes)) {
      throw new Error("TMDB returned invalid season data.");
    }
    const today = localIsoDate(now);
    const airDates = payload.episodes
      .map((episode) => (isRecord(episode) ? readIsoDate(episode.air_date) : null))
      .filter((date): date is string => date !== null)
      .sort();
    const aired = airDates.filter((date) => date <= today);
    const upcoming = airDates.filter((date) => date > today);
    return {
      seasonNumber,
      airedEpisodes: aired.length,
      totalEpisodes: payload.episodes.length,
      lastAirDate: aired.at(-1) ?? null,
      nextAirDate: upcoming[0] ?? null,
      pendingEpisodes: aired.filter((date) => !isEpisodeAiredEnough(date, now, graceHours)).length,
    };
  }

  /**
   * 缺集总览的集名来源：和 seasonProgress 打同一个接口，但保留 episode_number/name。
   * 非法分集使整季读取失败，避免静默丢集后发布不完整的缺集结果；name 可能为空。
   */
  async function seasonEpisodes(tvId: number, seasonNumber: number): Promise<TmdbEpisode[]> {
    const payload = await request(`/tv/${tvId}/season/${seasonNumber}`, new URLSearchParams({ language: "zh-CN" }));
    return parseEpisodeMetadata(payload);
  }

  async function airedEpisodeCount(tvId: number, now = new Date()): Promise<number> {
    const payload = await request(`/tv/${tvId}`, new URLSearchParams({ language: "zh-CN" }));
    const seasonCount =
      isRecord(payload) && Number.isInteger(payload.number_of_seasons) ? (payload.number_of_seasons as number) : 0;
    let aired = 0;
    for (let seasonNumber = 1; seasonNumber <= seasonCount; seasonNumber += 1) {
      try {
        aired += (await seasonProgress(tvId, seasonNumber, now)).airedEpisodes;
      } catch {
        // Skip seasons whose data is missing or malformed.
      }
    }
    return aired;
  }

  async function mapWithLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    async function run(): Promise<void> {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
    return results;
  }

  async function aggregateAired(tvId: number, seasons: TmdbSeason[], now = new Date()): Promise<number | null> {
    const positive = seasons
      .filter((season) => season.seasonNumber > 0)
      .map((season) => season.seasonNumber)
      .slice(0, 8);
    if (positive.length === 0) return null;
    const results = await Promise.allSettled(
      await mapWithLimit(positive, 4, (number) => seasonProgress(tvId, number, now)),
    );
    const aired = results
      .filter((result): result is PromiseFulfilledResult<TmdbSeasonProgress> => result.status === "fulfilled")
      .map((result) => result.value.airedEpisodes);
    return aired.length ? aired.reduce((total, count) => total + count, 0) : null;
  }

  return {
    async search(query) {
      const payload = await request(
        "/search/multi",
        new URLSearchParams({
          query,
          include_adult: "false",
          language: "zh-CN",
        }),
      );
      const base = readResults(payload).flatMap((item) => normalize(item, undefined, imageBaseUrl));
      const tvItems = base.filter((item) => item.mediaType === "tv");
      if (tvItems.length === 0) return base;
      const enriched = await mapWithLimit(tvItems, 4, async (item) => {
        try {
          const detail = await request(`/tv/${item.id}`, new URLSearchParams({ language: "zh-CN" }));
          const seasons = readSeasons(detail);
          const totalEpisodes =
            isRecord(detail) && Number.isInteger(detail.number_of_episodes)
              ? (detail.number_of_episodes as number)
              : null;
          const aired = await aggregateAired(item.id, seasons);
          return { ...item, seasons, totalEpisodes, airedEpisodes: aired };
        } catch {
          return item;
        }
      });
      const byId = new Map(enriched.map((item) => [item.id, item]));
      return base.map((item) => (item.mediaType === "tv" ? (byId.get(item.id) ?? item) : item));
    },
    async details(type, id) {
      const payload = await request(
        `/${type}/${id}`,
        new URLSearchParams({
          language: "zh-CN",
          append_to_response: "credits,videos",
          include_video_language: "en-US",
        }),
      );
      const extra =
        type === "tv"
          ? {
              seasons: parseSeasonMetadata(payload),
              totalEpisodes:
                isRecord(payload) && Number.isInteger(payload.number_of_episodes)
                  ? (payload.number_of_episodes as number)
                  : null,
            }
          : undefined;
      const normalized = normalize(payload, type, imageBaseUrl, extra)[0];
      if (!normalized) throw new Error("TMDB returned an invalid media item.");
      return normalized;
    },
    seasonProgress,
    seasonEpisodes,
    airedEpisodeCount,
  };
}

function readResults(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
  return payload.results;
}

function readSeasons(value: unknown): TmdbSeason[] {
  if (!isRecord(value) || !Array.isArray(value.seasons)) return [];
  return value.seasons.flatMap((season) => {
    if (!isRecord(season) || !Number.isInteger(season.season_number)) return [];
    return [
      {
        seasonNumber: season.season_number as number,
        name: typeof season.name === "string" ? season.name : null,
        episodeCount: Number.isInteger(season.episode_count) ? (season.episode_count as number) : 0,
        airDate:
          typeof season.air_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(season.air_date) ? season.air_date : null,
      },
    ];
  });
}

function normalize(
  value: unknown,
  knownType: TmdbMediaType | undefined,
  imageBaseUrl: string,
  extra?: { seasons?: TmdbSeason[]; totalEpisodes?: number | null; airedEpisodes?: number | null },
): TmdbMedia[] {
  if (!isRecord(value)) return [];
  const mediaType = knownType ?? value.media_type;
  if (mediaType !== "movie" && mediaType !== "tv") return [];
  const title = mediaType === "movie" ? value.title : value.name;
  if (!Number.isInteger(value.id) || typeof title !== "string" || !title.trim()) return [];
  const originalTitle = mediaType === "movie" ? value.original_title : value.original_name;
  const date = mediaType === "movie" ? value.release_date : value.first_air_date;
  const genres = Array.isArray(value.genres)
    ? value.genres.map((genre) => (isRecord(genre) && typeof genre.name === "string" ? genre.name : "")).filter(Boolean)
    : undefined;
  const credits = isRecord(value.credits) ? value.credits : undefined;
  const cast = Array.isArray(credits?.cast)
    ? credits.cast
        .slice(0, 8)
        .map((person) => (isRecord(person) && typeof person.name === "string" ? person.name : ""))
        .filter(Boolean)
    : undefined;
  const directors = Array.isArray(credits?.crew)
    ? (credits.crew as unknown[])
        .filter((person) => isRecord(person) && person.job === "Director" && typeof person.name === "string")
        .slice(0, 4)
        .map((person) => (person as { name: string }).name)
    : undefined;
  const castAvatars = Array.isArray(credits?.cast)
    ? credits.cast
        .slice(0, 24)
        .map((person) => {
          if (!isRecord(person) || typeof person.name !== "string") return null;
          return {
            name: person.name,
            character: typeof person.character === "string" ? person.character : null,
            avatarUrl: imageUrl(imageBaseUrl, "w185", person.profile_path),
          };
        })
        .filter(
          (person): person is { name: string; character: string | null; avatarUrl: string | null } => person !== null,
        )
    : undefined;
  const videos = isRecord(value.videos) && Array.isArray(value.videos.results) ? value.videos.results : [];
  const trailer = videos.find(
    (video) => isRecord(video) && video.site === "YouTube" && video.type === "Trailer" && typeof video.key === "string",
  );
  const finiteNumber = (input: unknown): number | null => (Number.isFinite(Number(input)) ? Number(input) : null);
  return [
    {
      id: value.id as number,
      mediaType,
      title,
      originalTitle: typeof originalTitle === "string" ? originalTitle : title,
      releaseYear: readYear(date),
      releaseDate: typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      overview: typeof value.overview === "string" ? value.overview : "",
      posterUrl: imageUrl(imageBaseUrl, "w500", value.poster_path),
      backdropUrl: imageUrl(imageBaseUrl, "w1280", value.backdrop_path),
      runtime: mediaType === "movie" ? finiteNumber(value.runtime) : null,
      genres: genres && genres.length ? genres : undefined,
      status: typeof value.status === "string" ? value.status : null,
      voteAverage: finiteNumber(value.vote_average),
      directors: directors && directors.length ? directors : undefined,
      cast: cast && cast.length ? cast : undefined,
      castAvatars: castAvatars && castAvatars.length ? castAvatars : undefined,
      trailerKey: trailer ? (trailer as { key: string }).key : null,
      budget: finiteNumber(value.budget),
      revenue: finiteNumber(value.revenue),
      ...(mediaType === "tv" && extra
        ? {
            totalEpisodes: extra.totalEpisodes ?? null,
            seasons: extra.seasons ?? [],
            airedEpisodes: extra.airedEpisodes ?? null,
          }
        : {}),
    },
  ];
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readYear(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number(value.slice(0, 4));
}

function readIsoDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function imageUrl(baseUrl: string, size: string, value: unknown): string | null {
  return typeof value === "string" && value.startsWith("/") ? `${baseUrl}/${size}${value}` : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
