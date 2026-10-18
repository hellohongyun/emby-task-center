import { fireEvent, render, screen } from "@testing-library/vue";
import { describe, expect, it, vi } from "vitest";
import MissingEpisodesView from "./MissingEpisodesView.vue";
import type { MissingEpisodesPayload, MissingEpisodesShow } from "../types";

const libraries = [
  { rootId: "a-guid", name: "A库" },
  { rootId: "b-guid", name: "B库" },
];
function show(rootId = "a-guid", missingCount = 1): MissingEpisodesShow {
  return {
    mediaItemId: 1,
    tmdbId: 100,
    title: "同一部剧",
    posterUrl: null,
    airProgress: 2,
    storedProgress: 1,
    missingCount,
    pendingCount: 0,
    libraries: [
      {
        rootId,
        name: rootId === "a-guid" ? "A库" : "B库",
        mediaType: "tv",
        episodeCount: 1,
        fileCount: 1,
        seasons: [1],
        path: "Show",
      },
    ],
    unmatchedSeasons: [],
    suspectSeasons: [],
    pendingSeasons: [],
    seasons: missingCount
      ? [
          {
            seasonNumber: 1,
            aired: 2,
            stored: 1,
            libraries: [],
            episodes: [{ episodeNumber: 2, name: "分集二", airDate: "2020-01-01" }],
          },
        ]
      : [],
  };
}
function data(rootId = "a-guid", shows: MissingEpisodesShow[] = []): MissingEpisodesPayload {
  return {
    rootId,
    libraries,
    generatedAt: "2026-10-18T00:00:00Z",
    lastScanAt: "2026-10-18T00:00:00Z",
    scanning: false,
    progress: null,
    mismatchCount: 0,
    mismatches: [],
    emby: null,
    showCount: shows.filter((s) => s.missingCount > 0).length,
    pendingShowCount: 0,
    episodeCount: shows.reduce((n, s) => n + s.missingCount, 0),
    pendingEpisodeCount: 0,
    shows,
  };
}
describe("root-scoped missing episode page", () => {
  it.each(["scan_failed", "not_scanned"] as const)("does not claim an empty %s inventory is complete", (issue) => {
    render(MissingEpisodesView, { props: { payload: { ...data(), inventoryIssue: issue } } });
    expect(screen.getByText("检测结果不完整")).toBeInTheDocument();
    expect(screen.queryByText("当前媒体库未发现缺集")).not.toBeInTheDocument();
    expect(screen.getByText("请先完成库存同步，再核对当前媒体库的缺集结果。")).toBeInTheDocument();
  });
  it("keeps enabled library navigation when the selected library has no missing shows", async () => {
    const view = render(MissingEpisodesView, { props: { payload: data(), selectedRootId: "a-guid" } });
    expect(screen.getByText("当前媒体库未发现缺集")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("tab", { name: "B库" }));
    expect(view.emitted("select-library")).toEqual([["b-guid"]]);
    expect(screen.getByRole("tab", { name: "A库" })).toBeInTheDocument();
  });
  it("clears selection and retains library tabs while a new root is loading", async () => {
    const remove = vi.fn().mockResolvedValue({ deleted: 1, failed: 0, results: [] });
    const view = render(MissingEpisodesView, {
      props: { payload: data("a-guid", [show()]), selectedRootId: "a-guid", deleteShows: remove },
    });
    await fireEvent.click(screen.getByRole("checkbox", { name: "选择 同一部剧" }));
    await fireEvent.click(screen.getByRole("button", { name: "删除选中（1）" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await view.rerender({ payload: null, selectedRootId: "b-guid", loading: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("同一部剧")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "B库" })).toHaveAttribute("aria-selected", "true");
    await view.rerender({ payload: data("b-guid", [show("b-guid")]), selectedRootId: "b-guid", loading: false });
    await fireEvent.click(screen.getByRole("button", { name: "全选当前" }));
    await fireEvent.click(screen.getByRole("button", { name: "删除选中（1）" }));
    expect(screen.getByRole("heading", { name: "从「B库」删除 1 部剧？" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "确认删除 1 部" }));
    expect(remove).toHaveBeenCalledWith([1], "b-guid");
  });
  it("shows suspect-only results without labelling them as pending updates or allowing deletion", async () => {
    const suspect = show("a-guid", 0);
    suspect.suspectSeasons = [{ seasonNumber: 1, aired: 30, stored: 12 }];
    render(MissingEpisodesView, { props: { payload: data("a-guid", [suspect]), selectedRootId: "a-guid" } });
    expect(screen.getByText(/编号体系疑似与 TMDB 不一致/)).toBeInTheDocument();
    expect(screen.getByText("检测待核对")).toBeInTheDocument();
    expect(screen.queryByText("仅今日更新待入库")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "全选当前" }));
    expect(screen.getByRole("button", { name: "删除选中" })).toBeDisabled();
  });
  it("removes selection if a refresh resolves missing episodes, and does not claim completion on read failure", async () => {
    const view = render(MissingEpisodesView, {
      props: { payload: data("a-guid", [show()]), selectedRootId: "a-guid" },
    });
    await fireEvent.click(screen.getByRole("checkbox", { name: "选择 同一部剧" }));
    await view.rerender({ payload: data("a-guid", [show("a-guid", 0)]) });
    expect(screen.getByRole("button", { name: "删除选中" })).toBeDisabled();
    await view.rerender({ payload: null, error: "网络异常" });
    expect(screen.queryByText("当前媒体库未发现缺集")).not.toBeInTheDocument();
    expect(screen.getByText("缺集清单未读取成功，请重试。")).toBeInTheDocument();
  });
});
