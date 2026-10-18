import { fireEvent, render, screen } from "@testing-library/vue";
import { describe, expect, it } from "vitest";
import type { MissingEpisodesPayload, MissingMetadataIssue } from "../types";
import MissingMetadataNotice from "./MissingMetadataNotice.vue";
import MissingEpisodesView from "./MissingEpisodesView.vue";

const issue: MissingMetadataIssue = {
  mediaItemId: 1,
  tmdbId: 100,
  title: "待检测剧",
  stale: true,
  error: "tmdb_partial_unavailable",
  failedSeasons: [2],
  unavailableSeasons: [2],
  lastCompleteAt: null,
  expiresAt: null,
  attemptedAt: "2026-10-03T00:00:00Z",
  retryAt: "2026-10-03T00:05:00Z",
};

describe("missing metadata diagnostics", () => {
  it("shows unknown seasons and earliest retry without claiming a complete result", async () => {
    render(MissingMetadataNotice, { props: { issues: [issue] } });
    expect(screen.getByText(/当前合计不能代表全库已齐/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "查看失败详情" }));
    expect(screen.getByText("待检测剧")).toBeInTheDocument();
    expect(screen.getByText("尚无分集缓存：S2")).toBeInTheDocument();
    expect(screen.getByText(/上次完整结果：尚无完整结果/)).toBeInTheDocument();
    expect(screen.getByText(/下一次检测会重新拉取/)).toBeInTheDocument();
  });

  it("does not render 全部已齐 when no snapshots exist but first metadata fetch failed", () => {
    const payload: MissingEpisodesPayload = {
      generatedAt: "2026-10-03T00:00:00Z",
      lastScanAt: null,
      scanning: false,
      progress: null,
      mismatchCount: 0,
      mismatches: [],
      emby: null,
      showCount: 0,
      pendingShowCount: 0,
      episodeCount: 0,
      pendingEpisodeCount: 0,
      shows: [],
      metadataIssueCount: 1,
      metadataIssues: [issue],
    };
    render(MissingEpisodesView, { props: { payload } });
    expect(screen.queryByText("全部已齐")).not.toBeInTheDocument();
    expect(screen.getByText("检测结果不完整")).toBeInTheDocument();
    expect(screen.getByText(/不能确认当前媒体库已齐/)).toBeInTheDocument();
  });
});
