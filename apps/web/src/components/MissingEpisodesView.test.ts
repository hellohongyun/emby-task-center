import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { describe, expect, it, vi } from "vitest";

import MissingEpisodesView from "./MissingEpisodesView.vue";
import type { MissingEpisodesPayload } from "../types";

/**
 * 缺集总览展示组件：服务端已经算好缺集口径（这里不重复相减），
 * 组件负责把「剧 → 季 → 集」逐集列出来，并支持搜索/排序/媒体库筛选与批量删除。
 */
const payload: MissingEpisodesPayload = {
  generatedAt: "2026-09-19T08:00:00.000Z",
  lastScanAt: "2026-09-19T07:30:00.000Z",
  scanning: false,
  progress: null,
  mismatchCount: 1,
  mismatches: [
    {
      mediaItemId: 99,
      title: "我们的宇宙",
      tmdbId: 66757,
      embySeriesId: "series-99",
      embyTmdbId: 213608,
    },
  ],
  emby: { webBaseUrl: "https://emby.test", serverId: "server-1" },
  showCount: 2,
  pendingShowCount: 0,
  episodeCount: 3,
  pendingEpisodeCount: 1,
  shows: [
    {
      mediaItemId: 11,
      tmdbId: 202,
      title: "暗黑",
      posterUrl: null,
      airProgress: 3,
      storedProgress: 2,
      missingCount: 1,
      pendingCount: 0,
      libraries: [
        { rootId: "tv", name: "剧集", mediaType: "tv", episodeCount: 2, fileCount: 2, seasons: [1], path: "Dark" },
      ],
      unmatchedSeasons: [{ seasonNumber: 3, airedEpisodes: 8 }],
      suspectSeasons: [],
      embySeriesId: "series-11",
      pendingSeasons: [],
      seasons: [
        {
          seasonNumber: 1,
          aired: 3,
          stored: 2,
          libraries: [{ rootId: "tv", name: "剧集", mediaType: "tv", episodeCount: 2, path: "Dark/Season 01" }],
          episodes: [{ episodeNumber: 2, name: "谎言", airDate: "2018-01-01" }],
          embySeasonId: "season-11",
        },
      ],
    },
    {
      mediaItemId: 22,
      tmdbId: 303,
      title: "斗破苍穹",
      posterUrl: null,
      airProgress: 210,
      storedProgress: 208,
      missingCount: 2,
      pendingCount: 1,
      libraries: [
        {
          rootId: "anime",
          name: "动漫",
          mediaType: "tv",
          episodeCount: 208,
          fileCount: 208,
          seasons: [5],
          path: "斗破苍穹 年番",
        },
      ],
      unmatchedSeasons: [],
      suspectSeasons: [],
      embySeriesId: "series-22",
      // 当天播出、还在入库宽限期内：不算缺集，单独标出来（缺集仍是 S05E18/E19 那两集）
      pendingSeasons: [
        {
          seasonNumber: 5,
          episodes: [{ episodeNumber: 210, name: "今日更新", airDate: "2026-09-19" }],
          embySeasonId: "season-22",
        },
      ],
      seasons: [
        {
          seasonNumber: 5,
          aired: 210,
          stored: 208,
          libraries: [],
          episodes: [
            { episodeNumber: 18, name: "三年之约", airDate: "2024-05-01" },
            { episodeNumber: 19, name: null, airDate: null },
          ],
        },
      ],
    },
  ],
};

/**
 * 仅"今日更新待入库"、没有其它缺集的剧：列表里能看到（知道自己不是漏了），
 * 但缺 0 集、不给勾选框、不进"共 N 部剧缺 M 集"。
 */
const pendingOnlyPayload: MissingEpisodesPayload = {
  generatedAt: "2026-09-21T08:00:00.000Z",
  lastScanAt: "2026-09-21T07:30:00.000Z",
  scanning: false,
  progress: null,
  mismatchCount: 0,
  mismatches: [],
  emby: null,
  showCount: 0,
  pendingShowCount: 1,
  episodeCount: 0,
  pendingEpisodeCount: 1,
  shows: [
    {
      mediaItemId: 33,
      tmdbId: 79481,
      title: "斗破苍穹",
      posterUrl: null,
      airProgress: 210,
      storedProgress: 209,
      missingCount: 0,
      pendingCount: 1,
      libraries: [
        {
          rootId: "anime",
          name: "动漫",
          mediaType: "tv",
          episodeCount: 209,
          fileCount: 209,
          seasons: [5],
          path: "斗破苍穹 年番",
        },
      ],
      unmatchedSeasons: [],
      suspectSeasons: [],
      seasons: [],
      pendingSeasons: [
        {
          seasonNumber: 5,
          episodes: [{ episodeNumber: 210, name: "今日更新", airDate: "2026-09-21" }],
          embySeasonId: null,
        },
      ],
      embySeriesId: "series-33",
      error: null,
    },
  ],
};

describe("MissingEpisodesView", () => {
  it("lists missing episodes of the first media library by default and follows tab switches", async () => {
    render(MissingEpisodesView, { props: { payload } });

    expect(screen.getByRole("heading", { name: "缺集总览" })).toBeInTheDocument();
    expect(screen.getByText("共 2 部剧缺 3 集")).toBeInTheDocument();
    // 没有「不限媒体库」：默认落在第一个库（动漫）
    expect(screen.queryByRole("tab", { name: /不限媒体库/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /动漫/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("斗破苍穹")).toBeInTheDocument();
    expect(screen.queryByText("暗黑")).not.toBeInTheDocument();
    expect(screen.getByText("S05E18")).toBeInTheDocument();
    expect(screen.getByText("三年之约")).toBeInTheDocument();
    expect(screen.getByText("S05E19")).toBeInTheDocument();
    // TMDB 没有集名时只显示集号，不臆造
    expect(screen.getByText("集名待补")).toBeInTheDocument();
    // 上次检测时间可见
    expect(screen.getByText(/上次检测/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("tab", { name: /剧集/ }));
    expect(screen.getByText("暗黑")).toBeInTheDocument();
    expect(screen.queryByText("斗破苍穹")).not.toBeInTheDocument();
    expect(screen.getByText("S01E02")).toBeInTheDocument();
    expect(screen.getByText("谎言")).toBeInTheDocument();
    // 季号对不上的季单独提示（与看板同一口径，不冒充缺集）
    expect(screen.getByText(/S03 库内无对应季号（共 8 集），未计入/)).toBeInTheDocument();
  });

  it("keeps the grace-period explainer out of the page head (it squeezed the title into a 1-char column)", () => {
    const { container } = render(MissingEpisodesView, { props: { payload } });

    const note = container.querySelector("p.page-note")!;
    expect(note).not.toBeNull();
    // 说明句必须在页头之外：塞进 .page-head 的左栏会被右侧 flex:none 的动作区挤成一条竖线
    // （实测 1440 下 104×144、1024 下 61×234），页头高度从 ~100px 涨到 478px。
    expect(note.closest(".page-head")).toBeNull();
    expect(note.closest(".page-title")).toBeNull();
    expect(note.parentElement?.className).toContain("missing-view");
  });

  it("lists a show whose only gap is a today-update, without offering to delete it", () => {
    render(MissingEpisodesView, { props: { payload: pendingOnlyPayload } });

    // 缺集口径不变：0 部缺 0 集；今日更新单独一句，并说明这类剧不可删除
    expect(screen.getByText("共 0 部剧缺 0 集")).toBeInTheDocument();
    expect(screen.getByText("另有 1 集今日更新待入库")).toBeInTheDocument();
    expect(screen.getByText(/其中 1 部仅此一项/)).toBeInTheDocument();

    const card = screen.getByText("斗破苍穹").closest(".show-card")!;
    expect(card.textContent).toContain("仅今日更新待入库");
    expect(card.textContent).toContain("无缺集");
    expect(card.textContent).toContain("今日更新 E210");
    // 缺 0 集 → 不给勾选框；"全选当前"也不把它拉进删除范围
    expect(card.querySelector('input[type="checkbox"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全选当前" }));
    expect(screen.getByRole("button", { name: /删除选中/ })).toBeDisabled();
  });

  it("shows the 「今日更新」 episodes without counting them as missing", async () => {
    render(MissingEpisodesView, { props: { payload } });

    // 头部合计仍是缺集口径，今日更新单独一句话说清楚
    expect(screen.getByText("共 2 部剧缺 3 集")).toBeInTheDocument();
    expect(screen.getByText("另有 1 集今日更新待入库")).toBeInTheDocument();
    // 斗破苍穹（默认库）：缺集仍只有 E18/E19，当天播出的 E210 只标「今日更新」
    const show = screen.getByText("斗破苍穹").closest(".show-card")!;
    expect(show.textContent).toContain("缺 2 集");
    expect(show.textContent).toContain("今日更新 E210");
    expect(show.textContent).toContain("宽限期内不计缺集");
    expect(show.textContent).not.toContain("S05E210");
    // 没有今日更新的剧不显示这一行
    await fireEvent.click(screen.getByRole("tab", { name: /剧集/ }));
    expect(screen.getByText("暗黑").closest(".show-card")!.textContent).not.toContain("今日更新");
  });

  it("filters by title within the selected media library", async () => {
    render(MissingEpisodesView, { props: { payload } });

    await fireEvent.update(screen.getByPlaceholderText("搜索剧名"), "斗破");
    expect(screen.getByText("斗破苍穹")).toBeInTheDocument();

    // 暗黑在「剧集」库里，不在当前（动漫）库 → 搜索给空态；切库后可见
    await fireEvent.update(screen.getByPlaceholderText("搜索剧名"), "暗黑");
    expect(screen.getByText(/没有匹配「暗黑」的剧/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("tab", { name: /剧集/ }));
    expect(screen.getByText("暗黑")).toBeInTheDocument();
  });

  it("shows one library at a time with per-library counts", async () => {
    render(MissingEpisodesView, { props: { payload } });

    // 筛选条只有各库名，数字是"这个库下缺集的剧集数"
    expect(screen.getByRole("tab", { name: /动漫/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /剧集/ })).toHaveTextContent("1");
    expect(screen.getByText("斗破苍穹")).toBeInTheDocument();
    expect(screen.queryByText("暗黑")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("tab", { name: /剧集/ }));
    expect(screen.getByText("暗黑")).toBeInTheDocument();
    expect(screen.queryByText("斗破苍穹")).not.toBeInTheDocument();
  });

  it("flags suspect numbering without counting it as missing", () => {
    const annotated: MissingEpisodesPayload = {
      ...payload,
      shows: [{ ...payload.shows[0]!, suspectSeasons: [{ seasonNumber: 1, aired: 41, stored: 20 }] }],
    };
    render(MissingEpisodesView, { props: { payload: annotated } });

    expect(
      screen.getByText(/S01 编号体系疑似与 TMDB 不一致（库内 20 集 \/ TMDB 41 集），未判定缺集/),
    ).toBeInTheDocument();
  });

  it("lists TMDB-id mismatches separately with both ids and an Emby link", () => {
    render(MissingEpisodesView, { props: { payload } });

    const section = screen.getByRole("region", { name: /未纳入检测/ });
    expect(section).toHaveTextContent("未纳入检测：1 部剧的 TMDB 标识与 Emby 实际不一致");
    expect(section).toHaveTextContent("我们的宇宙");
    expect(section).toHaveTextContent("本地 TMDB 66757 · Emby 实际 213608");
    const link = within(section).getByRole("link", { name: /在 Emby 查看/ });
    expect(link).toHaveAttribute("href", "https://emby.test/web/index.html#!/item?id=series-99&serverId=server-1");
  });

  it("links each season (and its missing episodes) to the Emby web item page", async () => {
    render(MissingEpisodesView, { props: { payload } });

    // 只看缺集列表里的链接（底部/顶部还有"未纳入检测"段落自己的链接）
    const list = document.querySelector(".show-list") as HTMLElement;
    const seasonLinks = () => within(list).getAllByRole("link", { name: /在 Emby 查看/ });

    // 默认库（动漫）下的斗破没有季 Id → 回落到剧集条目
    expect(seasonLinks()[0]).toHaveAttribute(
      "href",
      "https://emby.test/web/index.html#!/item?id=series-22&serverId=server-1",
    );

    // 切到「剧集」库：季标题与缺集卡片都跳那一季
    await fireEvent.click(screen.getByRole("tab", { name: /剧集/ }));
    expect(seasonLinks()[0]).toHaveAttribute(
      "href",
      "https://emby.test/web/index.html#!/item?id=season-11&serverId=server-1",
    );
    expect(seasonLinks()[0]).toHaveAttribute("target", "_blank");
    // 缺的集在 Emby 里不存在，点集号也是跳到季页面核对
    const episodeLink = within(list).getByRole("link", { name: /S01E02/ });
    expect(episodeLink).toHaveAttribute(
      "href",
      "https://emby.test/web/index.html#!/item?id=season-11&serverId=server-1",
    );
  });

  it("hides Emby links when no Emby web address is configured", () => {
    render(MissingEpisodesView, { props: { payload: { ...payload, emby: null } } });

    expect(screen.queryByRole("link", { name: /在 Emby 查看/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /S01E02/ })).not.toBeInTheDocument();
  });

  it("sorts by title on demand", async () => {
    // 两部剧放同一个库里，才能比较排序（页面一次只显示一个库）
    const bothInAnime: MissingEpisodesPayload = {
      ...payload,
      shows: payload.shows.map((show, index) => ({
        ...show,
        libraries: [
          {
            rootId: "anime",
            name: "动漫",
            mediaType: "tv",
            episodeCount: 1,
            fileCount: 1,
            seasons: [1],
            path: `作品${index}`,
          },
        ],
      })),
    };
    render(MissingEpisodesView, { props: { payload: bothInAnime } });

    await fireEvent.click(screen.getByRole("button", { name: "剧名" }));
    expect(screen.getAllByRole("heading", { level: 2 }).map((el) => el.textContent)).toEqual(["暗黑", "斗破苍穹"]);
  });

  it("selects shows and confirms a batch delete through Emby", async () => {
    const deleteShows = vi.fn().mockResolvedValue({
      deleted: 1,
      failed: 0,
      results: [{ mediaItemId: 22, title: "斗破苍穹", ok: true, embyItemIds: ["series-1"] }],
    });
    render(MissingEpisodesView, { props: { payload, deleteShows } });

    // 当前库（动漫）只有一部：全选 → 1 部
    await fireEvent.click(screen.getByRole("button", { name: "全选当前" }));
    expect(screen.getByRole("button", { name: /删除选中（1）/ })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
    // 单选一部 → 弹确认
    await fireEvent.click(screen.getByRole("checkbox", { name: "选择 斗破苍穹" }));
    await fireEvent.click(screen.getByRole("button", { name: /删除选中（1）/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("从「动漫」删除 1 部剧？");
    expect(dialog).toHaveTextContent("斗破苍穹");
    expect(dialog).toHaveTextContent("此操作不可恢复");

    await fireEvent.click(within(dialog).getByRole("button", { name: "确认删除 1 部" }));
    await waitFor(() => expect(deleteShows).toHaveBeenCalledWith([22], "anime"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("clears selection and confirmation when switching libraries, including a shared show", async () => {
    const deleteShows = vi.fn();
    const shared = {
      ...payload,
      shows: payload.shows.map((show) =>
        show.mediaItemId === 22
          ? {
              ...show,
              libraries: [
                ...show.libraries,
                {
                  rootId: "tv",
                  name: "剧集",
                  mediaType: "tv" as const,
                  episodeCount: 208,
                  fileCount: 208,
                  seasons: [5],
                  path: "斗破苍穹 年番",
                },
              ],
            }
          : show,
      ),
    };
    render(MissingEpisodesView, { props: { payload: shared, deleteShows } });
    await fireEvent.click(screen.getByRole("checkbox", { name: "选择 斗破苍穹" }));
    await fireEvent.click(screen.getByRole("button", { name: /删除选中（1）/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("其他媒体库中的副本保留");
    await fireEvent.click(screen.getByRole("tab", { name: /剧集/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择 斗破苍穹" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "删除选中" })).toBeDisabled();
    expect(deleteShows).not.toHaveBeenCalled();
  });

  it("shows scan progress and disables the trigger while scanning", () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined);
    render(MissingEpisodesView, {
      props: { payload: { ...payload, scanning: true, progress: { processed: 3, total: 10 } }, triggerScan },
    });

    expect(screen.getByText("检测中 3/10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /检测中…/ })).toBeDisabled();
  });

  it("shows the all-clear empty state and the error state", async () => {
    const empty: MissingEpisodesPayload = {
      ...payload,
      showCount: 0,
      episodeCount: 0,
      shows: [],
    };
    const { unmount } = render(MissingEpisodesView, { props: { payload: empty } });
    expect(screen.getByText("当前媒体库未发现缺集")).toBeInTheDocument();
    expect(screen.getByText("当前媒体库最近一次检测没有发现缺集。")).toBeInTheDocument();
    unmount();

    render(MissingEpisodesView, { props: { payload: null, error: "缺集清单暂时不可用，请稍后重试。" } });
    expect(screen.getByRole("alert")).toHaveTextContent("缺集清单暂时不可用");
  });
});
