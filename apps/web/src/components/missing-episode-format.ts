import type {
  MissingEpisodePendingSeason,
  MissingEpisodeSuspectSeason,
  TaskLibrarySource,
  TaskUnmatchedSeason,
} from "../types";
export function pendingEpisodesText(seasons: MissingEpisodePendingSeason[]): string {
  const format = (episodeNumber: number) => `E${String(episodeNumber).padStart(2, "0")}`;
  return seasons
    .map((season) => {
      const numbers = season.episodes.map((episode) => format(episode.episodeNumber));
      const shown =
        numbers.length > 6 ? `${numbers.slice(0, 6).join("、")} 等 ${numbers.length} 集` : numbers.join("、");
      return seasons.length > 1 ? `S${String(season.seasonNumber).padStart(2, "0")} ${shown}` : shown;
    })
    .join(" · ");
}

export function seasonLabel(seasonNumber: number): string {
  return seasonNumber === 0 ? "整剧 / 特别篇" : `第 ${seasonNumber} 季`;
}

/** 集号：S05E18（与任务看板的 E18 同源，只是这里带上季号方便直接去库里找）。 */
export function episodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

/** 这部剧的已存落在哪个库；一集都没有就是整剧还没入库。 */
export function libraryLine(libraries: TaskLibrarySource[]): string {
  if (!libraries.length) return "未入库";
  return libraries.map((library) => `${library.name} ${library.episodeCount} 集`).join(" · ");
}

/** 季号对不上、未纳入缺集计算的季（与任务看板同一文案口径）。 */
export function unmatchedText(seasons: TaskUnmatchedSeason[]): string {
  const numbers = seasons.map((season) => `S${String(season.seasonNumber).padStart(2, "0")}`).join("、");
  const aired = seasons.reduce((sum, season) => sum + season.airedEpisodes, 0);
  return `${numbers} 库内无对应季号（共 ${aired} 集），未计入`;
}

/** 编号体系疑似不一致的季（如 TVDB 半集合并 vs TMDB 分段）：只提示，不当缺集。 */
export function suspectText(seasons: MissingEpisodeSuspectSeason[]): string {
  const numbers = seasons.map((season) => `S${String(season.seasonNumber).padStart(2, "0")}`).join("、");
  const aired = seasons.reduce((sum, season) => sum + season.aired, 0);
  const stored = seasons.reduce((sum, season) => sum + season.stored, 0);
  return `${numbers} 编号体系疑似与 TMDB 不一致（库内 ${stored} 集 / TMDB ${aired} 集），未判定缺集`;
}

export function generatedText(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
