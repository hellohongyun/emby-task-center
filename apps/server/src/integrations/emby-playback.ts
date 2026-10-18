/**
 * 播放详情解析（纯函数，便于单测）。
 *
 * 目标：把 Emby `/Sessions` 里那坨嵌套结构，压成管理端"一眼看得懂"的播放状态 ——
 * 也就是 Emby 客户端顶部那块：剧名 S4E4 · 集名、4:39 / 21:07、OPPO-PLG110、MKV 6 mbps、
 * 4K HEVC、Chinese EAC3 stereo。判断逻辑放这里，路由与会话视图模型只做拼装。
 *
 * 三个刻意的原则：
 *  1) **不猜**：Emby 没给的信息（比如会话里没有 MediaStreams）就留空，由调用方决定是否去补齐；
 *  2) **直连优先**：TranscodingInfo 为 null 就是直接播放，此时视频/音频都算直出；
 *  3) **显示文案与原始值分开**：原始 codec/height 保留，另外给一个 label 供界面直接用。
 */
import type { EmbyMediaStream, EmbySession, EmbyTranscodingInfo } from "./emby-client";

export interface PlaybackItem {
  id: string | null;
  /** 剧集为剧名、电影为片名（列表主标题）。 */
  title: string;
  /** 集标题（"镇魔古洞"）；电影为 null。 */
  episodeTitle: string | null;
  type: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** 一行展示："诛仙 S4E4 · 镇魔古洞"。 */
  displayTitle: string;
  /** "第 4 季第 4 集"，没有季集号时为 null。 */
  episodeLabel: string | null;
}

export interface PlaybackTranscoding {
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  audioChannels: number | null;
  framerate: number | null;
  hardwareAcceleration: string | null;
  /** 原始原因码（ContainerNotSupported…）。 */
  reasons: string[];
  /** 原因码的中文说明（界面直接显示）。 */
  reasonsLabel: string;
}

export interface PlaybackDescriptor {
  item: PlaybackItem | null;
  /** DirectPlay / DirectStream / Transcode（Emby 原始值）。 */
  playMethod: string | null;
  playMethodLabel: string;
  videoDirect: boolean | null;
  audioDirect: boolean | null;
  container: string | null;
  bitrate: number | null;
  videoLabel: string | null;
  audioLabel: string | null;
  audioStreams: string[];
  subtitleLabel: string | null;
  mediaSourceName: string | null;
  transcoding: PlaybackTranscoding | null;
  /** 已播时长（ticks）；null = 客户端这次没报进度（跟"停在片头 0:00"是两回事）。 */
  positionTicks: number | null;
  /** 总时长（ticks）；null = Emby 没给（.strm / 网盘直链片源最常见）。 */
  runTimeTicks: number | null;
  /**
   * 进度百分比；**总时长未知时是 null，不是 0**。
   *
   * 为什么不能退回 0：strm / 网盘片源在 Emby 里没有 RunTimeTicks，"已播 ÷ 总时长"算不出来，
   * 早先这里直接给 0，界面把 0 画成"0% 宽的进度条"——那次会话看起来就是"只有播放时间、
   * 没有进度条"。0 表示"确实在片头"，null 表示"算不出来"，两者必须分开表达，
   * 界面才有机会画出不确定态（而不是一个假的空条）。
   */
  progressPercent: number | null;
}

/** 分辨率档位：按高度归档（4K=2160、1080P=1080…）。 */
export function resolutionLabel(width?: number | null, height?: number | null): string | null {
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0) return null;
  if (h >= 2000) return "4K";
  if (h >= 1000) return "1080P";
  if (h >= 700) return "720P";
  if (h >= 500) return "576P";
  if (h >= 400) return "480P";
  void width;
  return `${Math.round(h)}P`;
}

/** 编码名统一成界面上常见的写法。 */
export function codecLabel(codec?: string | null): string | null {
  const value = (codec ?? "").trim().toLowerCase();
  if (!value) return null;
  const map: Record<string, string> = {
    hevc: "HEVC",
    h265: "HEVC",
    h264: "H.264",
    avc: "H.264",
    av1: "AV1",
    vp9: "VP9",
    vc1: "VC-1",
    mpeg2video: "MPEG-2",
    mpeg4: "MPEG-4",
    aac: "AAC",
    ac3: "AC3",
    eac3: "EAC3",
    truehd: "TrueHD",
    dts: "DTS",
    flac: "FLAC",
    opus: "Opus",
    mp3: "MP3",
    pcm_s16le: "PCM",
    subrip: "SRT",
    ass: "ASS",
    pgssub: "PGS",
  };
  return map[value] ?? value.toUpperCase();
}

/** 声道数 → 常见叫法（Emby 的 DisplayTitle 里也是这么写的）。 */
export function channelsLabel(channels?: number | null, layout?: string | null): string | null {
  const n = Number(channels);
  if (Number.isFinite(n) && n > 0) {
    if (n === 1) return "mono";
    if (n === 2) return "stereo";
    if (n === 6) return "5.1";
    if (n === 7) return "6.1";
    if (n === 8) return "7.1";
    return `${n}ch`;
  }
  const raw = (layout ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "mono" || raw === "1.0") return "mono";
  if (raw === "stereo" || raw === "2.0") return "stereo";
  return raw;
}

/** 码率展示："6 mbps" / "800 kbps"；未知返回 null。 */
export function bitrateLabel(bps?: number | null): string | null {
  const value = Number(bps);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) {
    const mbps = value / 1_000_000;
    return `${mbps >= 10 ? Math.round(mbps) : Number(mbps.toFixed(1))} mbps`;
  }
  return `${Math.round(value / 1000)} kbps`;
}

/** 容器名统一大写（mkv → MKV）。 */
export function containerLabel(container?: string | null): string | null {
  const value = (container ?? "").trim();
  return value ? value.toUpperCase() : null;
}

/** Emby 的 TranscodeReasons → 中文（界面直接显示，省得管理员去查文档）。 */
export function transcodeReasonLabel(reasons: readonly string[] | null | undefined): string {
  const map: Record<string, string> = {
    ContainerNotSupported: "容器不支持",
    VideoCodecNotSupported: "视频编码不支持",
    AudioCodecNotSupported: "音频编码不支持",
    SubtitleCodecNotSupported: "字幕格式不支持",
    AudioIsExternal: "音频需单独取流",
    SecondaryAudioNotSupported: "不支持次音轨",
    VideoProfileNotSupported: "视频档次不支持",
    VideoLevelNotSupported: "视频等级不支持",
    VideoResolutionNotSupported: "分辨率不支持",
    VideoBitDepthNotSupported: "位深不支持",
    VideoFramerateNotSupported: "帧率不支持",
    VideoBitrateNotSupported: "码率超限",
    AudioBitrateNotSupported: "音频码率超限",
    AudioChannelsNotSupported: "声道数不支持",
    AudioProfileNotSupported: "音频档次不支持",
    AudioSampleRateNotSupported: "采样率不支持",
    VideoRangeNotSupported: "HDR 色彩不支持",
    RefFramesNotSupported: "参考帧不支持",
    AnamorphicVideoNotSupported: "变形宽银幕不支持",
    InterlacedVideoNotSupported: "隔行扫描不支持",
    VideoRotationNotSupported: "画面旋转不支持",
    UnknownVideoStreamInfo: "视频信息缺失",
    UnknownAudioStreamInfo: "音频信息缺失",
    DirectPlayError: "直接播放失败",
  };
  const list = (reasons ?? []).filter((reason): reason is string => typeof reason === "string" && !!reason);
  if (!list.length) return "";
  return list.map((reason) => map[reason] ?? reason).join("、");
}

function isAudioStream(stream: EmbyMediaStream): boolean {
  return (stream.Type ?? "").toLowerCase() === "audio";
}
function isVideoStream(stream: EmbyMediaStream): boolean {
  return (stream.Type ?? "").toLowerCase() === "video";
}
function isSubtitleStream(stream: EmbyMediaStream): boolean {
  return (stream.Type ?? "").toLowerCase() === "subtitle";
}

/** 音轨展示文案：优先用 Emby 给的 DisplayTitle（带语言与"默认"标记），否则自己拼。 */
export function audioStreamLabel(stream: EmbyMediaStream): string {
  const display = (stream.DisplayTitle ?? "").trim();
  if (display) return display;
  const language = (stream.DisplayLanguage ?? stream.Language ?? "").trim();
  const codec = codecLabel(stream.Codec) ?? "";
  const channels = channelsLabel(stream.Channels, stream.ChannelLayout) ?? "";
  const title = [language, codec, channels].filter(Boolean).join(" ");
  return title || (stream.Title ?? "").trim() || "音轨";
}

/** 视频流展示文案："4K HEVC"（HDR 会追加）。 */
export function videoStreamLabel(stream: EmbyMediaStream): string {
  const resolution = resolutionLabel(stream.Width, stream.Height);
  const codec = codecLabel(stream.Codec);
  const range = (stream.VideoRangeType ?? stream.VideoRange ?? "").toUpperCase();
  const hdr = range && range !== "SDR" ? (range.includes("DOLBY") ? "DolbyVision" : range) : "";
  const parts = [resolution, codec, hdr].filter(Boolean);
  return parts.join(" ");
}

/** 从会话里挑出"正在看的那一路"媒体源（多版本条目：4K / 1080P 各自一条）。 */
function pickMediaSource(session: EmbySession): {
  streams: EmbyMediaStream[];
  container: string | null;
  bitrate: number | null;
  name: string | null;
  runTimeTicks: number | null;
} {
  const item = session.NowPlayingItem;
  const sources = item?.MediaSources ?? [];
  const wanted = session.PlayState?.MediaSourceId ?? null;
  const source = (wanted ? sources.find((candidate) => candidate.Id === wanted) : undefined) ?? sources[0];
  const streams = item?.MediaStreams?.length ? item.MediaStreams : (source?.MediaStreams ?? []);
  return {
    streams,
    container: source?.Container ?? item?.Container ?? null,
    bitrate: source?.Bitrate ?? item?.Bitrate ?? null,
    name: source?.Name ?? null,
    runTimeTicks: source?.RunTimeTicks ?? null,
  };
}

/** ticks 转成"有效时长"；非正数/非法一律当作没有（Emby 用 0 表示未知比真 0 多）。 */
function firstTicks(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    const ticks = Number(value);
    if (Number.isFinite(ticks) && ticks > 0) return ticks;
  }
  return null;
}

/** 播放方式：Emby 把 PlayMethod 放在 PlayState 或顶层（版本差异），转码时也看 TranscodingInfo。 */
export function readPlayMethod(session: EmbySession): string | null {
  const value = session.PlayState?.PlayMethod ?? session.PlayMethod ?? null;
  if (value) return value;
  return session.TranscodingInfo ? "Transcode" : null;
}

export function playMethodLabel(method: string | null): string {
  switch ((method ?? "").toLowerCase()) {
    case "directplay":
      return "直接播放";
    case "directstream":
      return "直接串流";
    case "transcode":
      return "转码";
    default:
      return method ?? "";
  }
}

/** 把一次会话解析成播放详情。没有 NowPlayingItem 时 item 为 null（只是连着，没在播）。 */
export function describePlayback(session: EmbySession): PlaybackDescriptor {
  const raw = session.NowPlayingItem ?? null;
  const { streams, container, bitrate, name, runTimeTicks: sourceRunTimeTicks } = pickMediaSource(session);
  const videoStream = streams.find(isVideoStream) ?? null;
  const audioStreamList = streams.filter(isAudioStream);

  const audioIndex = session.PlayState?.AudioStreamIndex ?? null;
  const audioStream =
    (audioIndex != null ? audioStreamList.find((stream) => stream.Index === audioIndex) : undefined) ??
    audioStreamList.find((stream) => stream.IsDefault) ??
    audioStreamList[0] ??
    null;

  const subtitleIndex = session.PlayState?.SubtitleStreamIndex ?? null;
  const subtitleStream =
    subtitleIndex != null && subtitleIndex >= 0
      ? (streams.filter(isSubtitleStream).find((stream) => stream.Index === subtitleIndex) ?? null)
      : null;

  const transcoding = session.TranscodingInfo ?? null;
  const method = readPlayMethod(session);

  // 标题：剧集用剧名 + 集名，电影用片名。Emby 对剧集的 Name 就是集名。
  const item: PlaybackItem | null = raw
    ? (() => {
        const seriesName = (raw.SeriesName ?? "").trim();
        const name = (raw.Name ?? "").trim();
        const isEpisode = (raw.Type ?? "").toLowerCase() === "episode" || Boolean(seriesName);
        const season = Number.isInteger(raw.ParentIndexNumber) ? (raw.ParentIndexNumber as number) : null;
        const episode = Number.isInteger(raw.IndexNumber) ? (raw.IndexNumber as number) : null;
        const episodeLabel =
          isEpisode && (season != null || episode != null)
            ? [season != null ? `第 ${season} 季` : "", episode != null ? `第 ${episode} 集` : ""]
                .filter(Boolean)
                .join(" ")
            : null;
        const tag = isEpisode && season != null && episode != null ? ` S${season}E${episode}` : "";
        const title = isEpisode ? seriesName || name : name || seriesName;
        const displayTitle = isEpisode
          ? [title + tag, name && name !== title ? name : ""].filter(Boolean).join(" · ")
          : title;
        return {
          id: raw.Id ?? null,
          title: title || name,
          episodeTitle: isEpisode && name && name !== title ? name : null,
          type: raw.Type ?? null,
          seasonNumber: season,
          episodeNumber: episode,
          displayTitle,
          episodeLabel,
        };
      })()
    : null;

  // 已播：Emby 在播时一定给（停在片头就是 0，是 0 不是"没有"）。
  const rawPosition = Number(session.PlayState?.PositionTicks);
  const positionTicks = Number.isFinite(rawPosition) && rawPosition >= 0 ? rawPosition : null;
  // 总时长：条目层没有就问选中的媒体源层；两层都没有 = 这片子 Emby 自己也不知道多长。
  const runTimeTicks = firstTicks(raw?.RunTimeTicks, sourceRunTimeTicks);

  const directLabel = (isDirect: boolean | null | undefined): boolean | null =>
    transcoding ? isDirect !== false : true;

  return {
    item,
    playMethod: method,
    playMethodLabel: playMethodLabel(method),
    videoDirect: raw ? directLabel(transcoding?.IsVideoDirect) : null,
    audioDirect: raw ? directLabel(transcoding?.IsAudioDirect) : null,
    container: containerLabel(container),
    bitrate: bitrate ?? transcoding?.Bitrate ?? null,
    videoLabel: videoStream ? videoStreamLabel(videoStream) : null,
    audioLabel: audioStream ? audioStreamLabel(audioStream) : null,
    audioStreams: audioStreamList.map(audioStreamLabel),
    subtitleLabel: subtitleStream ? (subtitleStream.DisplayTitle ?? subtitleStream.Language ?? "字幕") : null,
    mediaSourceName: name,
    transcoding: transcoding
      ? {
          videoCodec: codecLabel(transcoding.VideoCodec),
          audioCodec: codecLabel(transcoding.AudioCodec),
          container: containerLabel(transcoding.Container),
          bitrate: transcoding.Bitrate ?? null,
          width: transcoding.Width ?? null,
          height: transcoding.Height ?? null,
          audioChannels: transcoding.AudioChannels ?? null,
          framerate: transcoding.Framerate ?? null,
          hardwareAcceleration: transcoding.HardwareAccelerationType ?? null,
          reasons: (transcoding.TranscodeReasons ?? []).filter(
            (reason): reason is string => typeof reason === "string",
          ),
          reasonsLabel: transcodeReasonLabel(transcoding.TranscodeReasons),
        }
      : null,
    positionTicks,
    runTimeTicks,
    progressPercent:
      positionTicks != null && runTimeTicks != null
        ? Math.max(0, Math.min(100, (positionTicks / runTimeTicks) * 100))
        : null,
  };
}

/** 会话时长/进度显示："4:39 / 21:07"（前端也用它做一致性）。 */
export function ticksToClock(ticks?: number | null): string {
  const value = Number(ticks);
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const totalSeconds = Math.floor(value / 10_000_000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export type { EmbyTranscodingInfo };
