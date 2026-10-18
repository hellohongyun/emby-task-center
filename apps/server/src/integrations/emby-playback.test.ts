import { describe, expect, it } from "vitest";

import type { EmbySession } from "./emby-client";
import {
  audioStreamLabel,
  bitrateLabel,
  describePlayback,
  resolutionLabel,
  ticksToClock,
  transcodeReasonLabel,
  videoStreamLabel,
} from "./emby-playback";

/** 示例设备和分集播放会话（Yamby + OPPO-PLG110 播《诛仙》S4E4）。 */
const sampleSession: EmbySession = {
  Id: "session-1",
  UserId: "user-1",
  UserName: "member@example.com",
  DeviceName: "OPPO-PLG110",
  DeviceId: "device-1",
  Client: "Yamby",
  ApplicationVersion: "2.0.5.5",
  RemoteEndPoint: "192.0.2.10:52344",
  NowPlayingItem: {
    Id: "item-1",
    Name: "镇魔古洞",
    SeriesName: "诛仙",
    Type: "Episode",
    ParentIndexNumber: 4,
    IndexNumber: 4,
    RunTimeTicks: 12_670_000_000, // 21:07
    Container: "mkv",
    MediaSources: [
      {
        Id: "source-1",
        Name: "流媒体",
        Container: "mkv",
        Bitrate: 6_000_000,
        MediaStreams: [
          { Type: "Video", Index: 0, Codec: "hevc", Width: 3840, Height: 2160, VideoRange: "HDR10" },
          {
            Type: "Audio",
            Index: 1,
            Codec: "eac3",
            Channels: 2,
            IsDefault: true,
            DisplayTitle: "Chinese EAC3 stereo (默认)",
          },
          { Type: "Subtitle", Index: 2, Codec: "subrip", Language: "chi", DisplayTitle: "Chinese (SRT)" },
        ],
      },
    ],
  },
  PlayState: {
    PositionTicks: 2_790_000_000, // 4:39
    PlayMethod: "DirectPlay",
    AudioStreamIndex: 1,
    SubtitleStreamIndex: -1,
    MediaSourceId: "source-1",
  },
};

describe("emby playback formatting", () => {
  it("formats the Yamby/4K example the way the Emby client shows it", () => {
    const playback = describePlayback(sampleSession);
    expect(playback.item?.displayTitle).toBe("诛仙 S4E4 · 镇魔古洞");
    expect(playback.item?.episodeLabel).toBe("第 4 季 第 4 集");
    expect(playback.item?.seasonNumber).toBe(4);
    expect(playback.item?.episodeNumber).toBe(4);
    expect(playback.playMethodLabel).toBe("直接播放");
    expect(playback.container).toBe("MKV");
    expect(bitrateLabel(playback.bitrate)).toBe("6 mbps");
    expect(playback.mediaSourceName).toBe("流媒体");
    expect(playback.videoLabel).toBe("4K HEVC HDR10");
    expect(playback.videoDirect).toBe(true);
    expect(playback.audioLabel).toBe("Chinese EAC3 stereo (默认)");
    expect(playback.audioDirect).toBe(true);
    expect(playback.subtitleLabel).toBeNull();
    expect(playback.transcoding).toBeNull();
    expect(playback.progressPercent).toBeCloseTo(22.02, 1);
    expect(ticksToClock(2_790_000_000)).toBe("4:39");
    expect(ticksToClock(12_670_000_000)).toBe("21:07");
  });

  it("describes a transcoded stream with reasons and per-stream direct flags", () => {
    const playback = describePlayback({
      Id: "session-2",
      NowPlayingItem: {
        Id: "item-2",
        Name: "测试片",
        Type: "Movie",
        RunTimeTicks: 7_200_000_000,
        MediaStreams: [
          { Type: "Video", Codec: "hevc", Height: 1080 },
          { Type: "Audio", Codec: "truehd", Channels: 8, Language: "jpn" },
        ],
      },
      PlayMethod: "Transcode",
      TranscodingInfo: {
        VideoCodec: "h264",
        AudioCodec: "aac",
        Container: "ts",
        IsVideoDirect: false,
        IsAudioDirect: true,
        Bitrate: 2_400_000,
        TranscodeReasons: ["VideoCodecNotSupported", "WeirdVendorReason"],
      },
    });
    expect(playback.playMethodLabel).toBe("转码");
    expect(playback.videoDirect).toBe(false);
    expect(playback.audioDirect).toBe(true);
    expect(playback.transcoding?.videoCodec).toBe("H.264");
    expect(playback.transcoding?.container).toBe("TS");
    expect(playback.transcoding?.reasonsLabel).toBe("视频编码不支持、WeirdVendorReason");
    // 音频流没有 DisplayTitle 时自己拼：语言 + 编码 + 声道
    expect(playback.audioLabel).toBe("jpn TrueHD 7.1");
    expect(playback.videoLabel).toBe("1080P HEVC");
    // 电影标题不带季集
    expect(playback.item?.displayTitle).toBe("测试片");
    expect(playback.item?.episodeLabel).toBeNull();
  });

  it("keeps idle sessions empty instead of inventing playback details", () => {
    const playback = describePlayback({ Id: "session-3", UserId: "u", DeviceName: "客厅电视" });
    expect(playback.item).toBeNull();
    expect(playback.videoLabel).toBeNull();
    expect(playback.audioLabel).toBeNull();
    // 没在播就没有进度可言：null（"不知道"），不是 0（"停在片头"）。
    expect(playback.positionTicks).toBeNull();
    expect(playback.runTimeTicks).toBeNull();
    expect(playback.progressPercent).toBeNull();
    expect(playback.playMethodLabel).toBe("");
  });

  /**
   * 回归场景：示例会员 用 Emby Web 播《92霸王花与霸王花》（.strm 网盘直链），
   * 采样到 PositionTicks=28780397291（47:58）而 RunTimeTicks=null —— 条目层与媒体源层都没有总时长。
   * 旧代码把"算不出百分比"退回 0，界面画成 0% 宽的进度条，于是那次会话"只有时间、没有进度条"。
   */
  it("reports an unknown progress instead of a fake 0% when Emby has no runtime", () => {
    const playback = describePlayback({
      Id: "session-strm",
      UserId: "user-2",
      UserName: "sample-member",
      Client: "Emby Web",
      NowPlayingItem: {
        Id: "item-strm",
        Name: "92霸王花与霸王花",
        Type: "Movie",
        MediaSources: [
          {
            Id: "source-strm",
            Name: "92霸王花与霸王花 (1992) - 1080p.BluRay REMUX.H.264.DTS-HD 2.0",
            Container: "strm",
            RunTimeTicks: null,
            MediaStreams: [{ Type: "Video", Codec: "h264", Height: 1080 }],
          },
        ],
      },
      PlayState: { PositionTicks: 28_780_397_291, PlayMethod: "DirectStream", MediaSourceId: "source-strm" },
    });

    expect(playback.item?.displayTitle).toBe("92霸王花与霸王花");
    expect(playback.positionTicks).toBe(28_780_397_291);
    expect(ticksToClock(playback.positionTicks)).toBe("47:58");
    // 时长未知 → 百分比未知（而不是 0）
    expect(playback.runTimeTicks).toBeNull();
    expect(playback.progressPercent).toBeNull();
  });

  it("falls back to the selected media source runtime when the item has none", () => {
    const playback = describePlayback({
      Id: "session-4",
      NowPlayingItem: {
        Id: "item-4",
        Name: "多版本电影",
        Type: "Movie",
        MediaSources: [
          { Id: "source-1080", Container: "mkv", RunTimeTicks: 6_000_000_000 },
          { Id: "source-4k", Container: "mkv", RunTimeTicks: 12_000_000_000 },
        ],
      },
      PlayState: { PositionTicks: 3_000_000_000, MediaSourceId: "source-4k" },
    });
    // 选中 4K 那一路：用它自己的时长，而不是第一路的
    expect(playback.runTimeTicks).toBe(12_000_000_000);
    expect(playback.progressPercent).toBeCloseTo(25, 5);
  });

  it("maps resolution, bitrate and reason codes", () => {
    expect(resolutionLabel(3840, 2160)).toBe("4K");
    expect(resolutionLabel(1920, 1080)).toBe("1080P");
    expect(resolutionLabel(1280, 720)).toBe("720P");
    expect(resolutionLabel(720, 480)).toBe("480P");
    expect(resolutionLabel(null, null)).toBeNull();
    expect(bitrateLabel(6_000_000)).toBe("6 mbps");
    expect(bitrateLabel(12_500_000)).toBe("13 mbps");
    expect(bitrateLabel(800_000)).toBe("800 kbps");
    expect(bitrateLabel(null)).toBeNull();
    expect(transcodeReasonLabel(["ContainerNotSupported"])).toBe("容器不支持");
    expect(transcodeReasonLabel([])).toBe("");
    expect(videoStreamLabel({ Type: "Video", Codec: "av1", Height: 2160, VideoRange: "SDR" })).toBe("4K AV1");
    expect(audioStreamLabel({ Type: "Audio", Codec: "aac", Channels: 1 })).toBe("AAC mono");
  });
});
