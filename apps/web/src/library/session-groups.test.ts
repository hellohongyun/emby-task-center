import { describe, expect, it } from "vitest";

import type { EmbySessionRow } from "../types";
import { groupSessions, isSystemSession } from "./session-groups";

function session(overrides: Partial<EmbySessionRow> & { id: string }): EmbySessionRow {
  return {
    userId: "u1",
    userName: "member@example.com",
    deviceName: "客厅电视",
    deviceId: "d1",
    client: "Emby Web",
    applicationVersion: "1.0",
    remoteAddress: "1.2.3.4:52000",
    lastActivityDate: "2026-01-01T00:00:00.000Z",
    item: null,
    nowPlaying: null,
    nowPlayingType: null,
    runTimeTicks: null,
    positionTicks: null,
    positionText: null,
    runTimeText: null,
    isPaused: false,
    playMethod: null,
    playMethodLabel: "",
    progressPercent: null,
    container: null,
    bitrate: null,
    bitrateText: null,
    mediaSourceName: null,
    videoLabel: null,
    videoDirect: null,
    audioLabel: null,
    audioDirect: null,
    audioStreams: [],
    subtitleLabel: null,
    transcoding: null,
    isPlaying: false,
    ...overrides,
  };
}

const item: EmbySessionRow["item"] = {
  id: "i1",
  title: "诛仙",
  episodeTitle: "镇魔古洞",
  type: "Episode",
  seasonNumber: 4,
  episodeNumber: 4,
  displayTitle: "诛仙 S4E4 · 镇魔古洞",
  episodeLabel: "第 4 季 第 4 集",
};

describe("groupSessions", () => {
  it("keeps playing sessions in front and folds the connected-but-idle ones", () => {
    const groups = groupSessions([
      session({ id: "idle-old", isPlaying: false, lastActivityDate: "2026-01-01T10:00:00.000Z" }),
      session({
        id: "play-1",
        isPlaying: true,
        item,
        nowPlaying: item.displayTitle,
        lastActivityDate: "2026-01-01T12:00:00.000Z",
      }),
      session({ id: "idle-new", isPlaying: false, lastActivityDate: "2026-01-01T11:00:00.000Z" }),
      session({ id: "play-2", isPlaying: true, item, lastActivityDate: "2026-01-01T13:00:00.000Z" }),
    ]);

    expect(groups.playing.map((s) => s.id)).toEqual(["play-2", "play-1"]);
    expect(groups.idle.map((s) => s.id)).toEqual(["idle-new", "idle-old"]);
  });

  it("sorts sessions without an activity date to the end instead of throwing", () => {
    const groups = groupSessions([
      session({ id: "no-date", isPlaying: true, lastActivityDate: null }),
      session({ id: "dated", isPlaying: true, lastActivityDate: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(groups.playing.map((s) => s.id)).toEqual(["dated", "no-date"]);
  });

  it("flags sessions without an Emby user as system/application sessions", () => {
    expect(isSystemSession(session({ id: "self", userId: null, userName: null, client: "媒体任务中心" }))).toBe(true);
    expect(isSystemSession(session({ id: "member" }))).toBe(false);
  });
});
