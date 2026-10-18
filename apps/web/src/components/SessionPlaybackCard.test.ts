import { fireEvent, render, screen } from "@testing-library/vue";
import { describe, expect, it } from "vitest";

import type { EmbySessionRow } from "../types";
import SessionPlaybackCard from "./SessionPlaybackCard.vue";

/** 与线上实际一致的一路会话（Yamby + OPPO-PLG110 播《诛仙》S4E4，4K HEVC 直连）。 */
const playing: EmbySessionRow = {
  id: "s1",
  userId: "u1",
  userName: "viewer@example.com",
  deviceName: "OPPO-PLG110",
  deviceId: "d1",
  client: "Yamby",
  applicationVersion: "2.0.5.5",
  remoteAddress: "192.0.2.10:52344",
  lastActivityDate: "2026-01-15T12:00:00.000Z",
  item: {
    id: "i1",
    title: "诛仙",
    episodeTitle: "镇魔古洞",
    type: "Episode",
    seasonNumber: 4,
    episodeNumber: 4,
    displayTitle: "诛仙 S4E4 · 镇魔古洞",
    episodeLabel: "第 4 季 第 4 集",
  },
  nowPlaying: "诛仙 S4E4 · 镇魔古洞",
  nowPlayingType: "Episode",
  runTimeTicks: 12_670_000_000,
  positionTicks: 2_790_000_000,
  positionText: "4:39",
  runTimeText: "21:07",
  isPaused: false,
  playMethod: "DirectPlay",
  playMethodLabel: "直接播放",
  progressPercent: 22,
  container: "MKV",
  bitrate: 6_000_000,
  bitrateText: "6 mbps",
  mediaSourceName: "流媒体",
  videoLabel: "4K HEVC",
  videoDirect: true,
  audioLabel: "Chinese EAC3 stereo (默认)",
  audioDirect: true,
  audioStreams: ["Chinese EAC3 stereo (默认)"],
  subtitleLabel: null,
  transcoding: null,
  isPlaying: true,
};

describe("SessionPlaybackCard", () => {
  it("shows the full playback state: title, season/episode, progress, device, method, codecs", () => {
    const { unmount } = render(SessionPlaybackCard, {
      props: { session: playing, memberEmail: "viewer@example.com" },
    });

    expect(screen.getByText("诛仙 S4E4 · 镇魔古洞")).toBeInTheDocument();
    expect(screen.getByText("4:39")).toBeInTheDocument();
    expect(screen.getByText("/ 21:07")).toBeInTheDocument();
    expect(screen.getByText("第 4 季 第 4 集")).toBeInTheDocument();
    expect(screen.getByText("OPPO-PLG110")).toBeInTheDocument();
    expect(screen.getByText("Yamby 2.0.5.5")).toBeInTheDocument();
    expect(screen.getByText("192.0.2.10:52344")).toBeInTheDocument();
    // "直接播放"同时出现在播放方式与视频/音频的直出标记上
    expect(screen.getAllByText("直接播放").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("MKV · 6 mbps")).toBeInTheDocument();
    expect(screen.getByText("4K HEVC")).toBeInTheDocument();
    expect(screen.getByText("Chinese EAC3 stereo (默认)")).toBeInTheDocument();
    expect(screen.getByText("流媒体")).toBeInTheDocument();
    // 进度条宽度 = 服务端给的比例
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "22");
    unmount();
  });

  it("surfaces transcode reasons and lets the operator end the session", async () => {
    const { emitted, unmount } = render(SessionPlaybackCard, {
      props: {
        session: {
          ...playing,
          playMethod: "Transcode",
          playMethodLabel: "转码",
          videoDirect: false,
          transcoding: {
            videoCodec: "H.264",
            audioCodec: "AAC",
            container: "TS",
            bitrate: 2_400_000,
            width: 1920,
            height: 1080,
            audioChannels: 2,
            framerate: 25,
            hardwareAcceleration: "vaapi",
            reasons: ["VideoCodecNotSupported"],
            reasonsLabel: "视频编码不支持",
          },
        },
      },
    });
    expect(screen.getByText(/转码原因：视频编码不支持/)).toBeInTheDocument();
    expect(screen.getByText(/硬件加速 vaapi/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "断开" }));
    expect(emitted().end).toEqual([["s1"]]);
    unmount();
  });

  it("renders idle sessions as connected instead of faking playback", () => {
    const { unmount } = render(SessionPlaybackCard, {
      props: {
        session: {
          ...playing,
          item: null,
          nowPlaying: null,
          nowPlayingType: null,
          isPlaying: false,
          positionText: null,
          runTimeText: null,
          progressPercent: 0,
          videoLabel: null,
          audioLabel: null,
        },
      },
    });
    expect(screen.getByText("已连接（未播放）")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("视频")).toBeNull();
    unmount();
  });

  /**
   * 线上真实那一幕：Emby 没给总时长（.strm 网盘直链），只能显示已播时间。
   * 旧行为会把未知画成 0% 宽的进度条 —— 管理员看到的就是"只有时间、没有进度条"。
   */
  it("shows an indeterminate bar and 已播…总时长未知 when Emby has no runtime", () => {
    const { unmount } = render(SessionPlaybackCard, {
      props: {
        session: {
          ...playing,
          runTimeTicks: null,
          runTimeText: null,
          progressPercent: null,
          positionTicks: 28_780_397_291,
          positionText: "47:58",
          mediaSourceName: "92霸王花与霸王花 (1992) - 1080p.BluRay REMUX.H.264.DTS-HD 2.0",
        },
      },
    });

    expect(screen.getByText("已播")).toBeInTheDocument();
    expect(screen.getByText("47:58")).toBeInTheDocument();
    expect(screen.getByText("· 总时长未知")).toBeInTheDocument();
    // 没有总时长就绝不显示"x / y"里的 y
    expect(screen.queryByText("/ 21:07")).toBeNull();
    const bar = screen.getByRole("progressbar");
    // 未知进度不报 aria-valuenow（念成 0% 是错的），改成文字说明
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuetext", "总时长未知，仅显示已播时间");
    expect(document.querySelector(".bar")).toHaveClass("sweeping");
    unmount();
  });

  it("labels sessions that belong to the app itself instead of a member", () => {
    const { unmount } = render(SessionPlaybackCard, {
      props: { session: { ...playing, userId: null, userName: null, client: "媒体任务中心" } },
    });
    // 身份位写"系统 / 应用会话"而不是"未知用户"；具体哪个客户端在"设备"一行里
    expect(screen.getByText("系统 / 应用会话")).toBeInTheDocument();
    // 设备一行里是「客户端 + 版本」
    expect(screen.getByText(/媒体任务中心/)).toBeInTheDocument();
    unmount();
  });
});
