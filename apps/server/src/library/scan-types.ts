/**
 * 扫描产物的公共类型。
 *
 * 原来定义在 strm-scanner.ts 里；媒体库改由 Emby 驱动后 STRM 扫描器被删除，
 * 但"一次扫描产出什么"的类型仍被 Emby 扫描器与库存服务共用，所以搬到这里。
 */
export type EpisodeNumberingMode = "seasonal" | "absolute" | "unresolved";

/** 一个条目的季集身份（Emby 扫描器直接按 IndexNumber/ParentIndexNumber 构造）。 */
export interface EpisodeIdentity {
  physicalSeason: number | null;
  parsedSeason: number | null;
  episodeNumbers: number[];
  absoluteEpisodeNumbers: number[];
  numberingMode: EpisodeNumberingMode;
  warning: string | null;
}

export interface ScannedMediaItem {
  relativePath: string;
  identity: EpisodeIdentity;
  /**
   * Emby 条目 Id（有它就是"真身份"）。落库时用它认行：Emby 改名/重新整理后
   * relativePath 会变，靠路径认行会把同一部作品当成新条目、并把旧行删掉。
   */
  embyItemId?: string;
  /** 海报引用（`emby:<条目Id>`）；媒体库改由 Emby 驱动后不再指向磁盘文件。 */
  posterPath?: string | null;
  /** Release-quality tags parsed from the path, e.g. 2160p / HEVC / DoVi / Atmos. */
  tags?: string[];
  /** 题材（Emby 侧直接给；STRM 侧过去只能靠 TMDB 补）。 */
  genres?: string[];
  /** 入库时间（Emby 的 DateCreated；STRM 时代是文件修改时间）。 */
  fileModifiedAt?: string | null;
  /**
   * 作品名与年份的**权威值**（Emby 的 Name / ProductionYear）。
   *
   * 以前片名只能从相对路径里用正则猜；路径是应用自己拼出来的合成值，
   * 猜法一旦不匹配（别名、去掉的副标题、年份写法）匹配就会静默失准。有权威值就优先用。
   */
  sourceTitleHint?: string;
  sourceYearHint?: number | null;
  /**
   * Emby 给的 TMDB Id（ProviderIds.Tmdb）。
   * 有了它就不必"拿片名去 TMDB 搜"：Emby 本身就是元数据源，直接按 id 认条目即可。
   */
  tmdbId?: number | null;
}

/** 只有完整抓取并验证全部分页的扫描器才能声明 complete；不完整结果不得用于删除旧库存。 */
export interface ScannedMediaBatch {
  items: readonly ScannedMediaItem[];
  complete: boolean;
}

/** 旧测试/只读扫描器仍可返回数组，但数组本身不授予清理旧库存的权限。 */
export type ScanOutput = readonly ScannedMediaItem[] | ScannedMediaBatch;
