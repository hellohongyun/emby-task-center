import { fireEvent, render, screen } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import TaskTrackingBoard from "./TaskTrackingBoard.vue";
import type { Task } from "../types";

const tasks: Task[] = [
  {
    id: 1,
    tmdbId: 70523,
    mediaType: "tv",
    title: "暗黑",
    taskType: "ingest",
    seasonNumber: null,
    status: "pending",
    statusMessage: null,
    airProgress: 18,
    storedProgress: 10,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    lastCheckedAt: "2026-09-10T08:30:00.000Z",
    missingEpisodes: [11, 12, 13, 14, 15, 16, 17, 18],
    libraries: [
      {
        rootId: "tv",
        name: "剧集",
        mediaType: "tv",
        episodeCount: 10,
        fileCount: 10,
        seasons: [1],
        path: "Dark",
      },
    ],
    seasons: [
      {
        seasonNumber: 1,
        status: "tracking",
        airProgress: 10,
        storedProgress: 10,
        lastCheckedAt: "2026-09-10T08:30:00.000Z",
        missingEpisodes: [],
        // 分季明细要能看出这一季存在哪个库、在该库里哪个目录
        libraries: [{ rootId: "tv", name: "剧集", mediaType: "tv", episodeCount: 10, path: "Dark/Season 01" }],
      },
      {
        seasonNumber: 2,
        status: "tracking",
        airProgress: 8,
        storedProgress: 0,
        lastCheckedAt: "2026-09-10T08:30:00.000Z",
        missingEpisodes: [1, 2, 3, 4, 5, 6, 7, 8],
      },
    ],
  },
  {
    id: 2,
    tmdbId: 110064,
    mediaType: "tv",
    title: "花开锦绣",
    taskType: "ingest",
    seasonNumber: null,
    status: "completed",
    statusMessage: null,
    airProgress: 24,
    storedProgress: 24,
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    lastCheckedAt: null,
    missingEpisodes: [],
    seasons: [
      {
        seasonNumber: 1,
        status: "finished",
        airProgress: 24,
        storedProgress: 24,
        lastCheckedAt: null,
        missingEpisodes: [],
      },
    ],
  },
];

/**
 * 「今日更新」用例的固定数据：已播 25、已存 24，唯一"没入库"的 E25 是今天刚播的（还在宽限期内）。
 * 早上 8 点打开看板时它不该算缺集，而是要标成「今日更新」。
 */
const pendingTasks: Task[] = [
  {
    id: 3,
    tmdbId: 79481,
    mediaType: "tv",
    title: "斗破苍穹",
    taskType: "ingest",
    seasonNumber: null,
    status: "pending",
    statusMessage: null,
    airProgress: 25,
    airPendingProgress: 1,
    storedProgress: 24,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-19T00:30:00.000Z",
    lastCheckedAt: "2026-09-19T00:30:00.000Z",
    missingEpisodes: [],
    pendingEpisodes: [25],
    seasons: [
      {
        seasonNumber: 1,
        status: "tracking",
        airProgress: 25,
        airPendingProgress: 1,
        storedProgress: 24,
        lastCheckedAt: "2026-09-19T00:30:00.000Z",
        missingEpisodes: [],
        pendingEpisodes: [25],
      },
    ],
  },
];

function stubViewport(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: narrow,
      media: "(max-width: 900px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } satisfies MediaQueryList),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("TaskTrackingBoard", () => {
  it("renders a sortable table with per-task counts on desktop", () => {
    stubViewport(false);
    const { container } = render(TaskTrackingBoard, { props: { tasks } });

    expect(container.querySelector("table.tracking-table")).not.toBeNull();
    expect(screen.getByRole("button", { name: "TMDB 已播" })).toBeInTheDocument();
    expect(screen.getByText("暗黑")).toBeInTheDocument();
    // 任务行：缺 8 集（任务级计数由服务端算好）
    expect(screen.getByText("缺 8 集")).toBeInTheDocument();
    // 状态筛选 chips：数字与行内胶囊同一口径（2 条里 1 条缺集、1 条已齐）
    expect(screen.getByRole("tab", { name: /全部/ })).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: /缺集中/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /已齐/ })).toHaveTextContent("1");
    // 行内状态胶囊
    expect(container.querySelector(".tracking-table td .pill")?.textContent).toContain("缺集中");
    // 移动卡片不在 DOM 里（两套 DOM，不是 CSS 隐藏）
    expect(container.querySelector(".card-list")).toBeNull();
    expect(container.querySelector(".fab")).toBeNull();
  });

  it("expands a task row into per-season rows with the missing episode numbers", async () => {
    stubViewport(false);
    const { container } = render(TaskTrackingBoard, { props: { tasks } });

    await fireEvent.click(screen.getByRole("button", { name: /^暗黑/ }));

    expect(container.querySelector("table.season-table")).not.toBeNull();
    expect(screen.getByText("第 1 季")).toBeInTheDocument();
    expect(screen.getByText("第 2 季")).toBeInTheDocument();
    // 第 2 季：已播 8、已存 0 → 缺 E01..E08
    expect(screen.getByText("E01、E02、E03、E04、E05、E06、E07、E08")).toBeInTheDocument();
    // 第 1 季已追平
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("sorts rows by the missing-episode column", async () => {
    stubViewport(false);
    render(TaskTrackingBoard, { props: { tasks } });

    const titleOrder = screen.getAllByRole("rowheader").map((cell) => cell.textContent?.trim());
    expect(titleOrder[0]).toContain("暗黑");

    await fireEvent.click(screen.getByRole("button", { name: "缺集" }));

    // 升序：缺 0 集的排在缺 6 集的前面
    const afterSort = screen.getAllByRole("rowheader").map((cell) => cell.textContent?.trim());
    expect(afterSort[0]).toContain("花开锦绣");
    expect(afterSort[1]).toContain("暗黑");
  });

  it("renders cards and no table on narrow viewports", async () => {
    stubViewport(true);
    const { container } = render(TaskTrackingBoard, { props: { tasks } });

    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".card-list")).not.toBeNull();
    expect(screen.getByText("暗黑")).toBeInTheDocument();
    // 窄屏没有表头按钮，创建入口是悬浮按钮 + 抽屉
    expect(screen.getByLabelText("新建任务")).toBeInTheDocument();

    // 手风琴展开：缺集与分季明细
    await fireEvent.click(screen.getByRole("button", { name: /^暗黑/ }));
    expect(container.querySelector(".accordion")).not.toBeNull();
    expect(screen.getByText("缺：E01、E02、E03、E04、E05、E06、E07、E08")).toBeInTheDocument();
  });

  it("filters rows by the board's own status chips", async () => {
    stubViewport(false);
    render(TaskTrackingBoard, { props: { tasks } });

    expect(screen.getAllByRole("rowheader").length).toBe(2);

    await fireEvent.click(screen.getByRole("tab", { name: /已齐/ }));
    const complete = screen.getAllByRole("rowheader").map((cell) => cell.textContent?.trim());
    expect(complete).toHaveLength(1);
    expect(complete[0]).toContain("花开锦绣");

    await fireEvent.click(screen.getByRole("tab", { name: /缺集中/ }));
    const missing = screen.getAllByRole("rowheader").map((cell) => cell.textContent?.trim());
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("暗黑");
  });

  it("shows a neutral 「今日更新」 pill when the only gap is today's episode", async () => {
    stubViewport(false);
    const { container } = render(TaskTrackingBoard, { props: { tasks: pendingTasks } });

    // 当天 18 点更新、20 点才入库：早上不该显示"缺集"，而是中性的「今日更新」
    const pill = container.querySelector(".tracking-table td .pill")!;
    expect(pill.textContent).toContain("今日更新 1 集");
    expect(pill.className).toContain("info");
    expect(screen.getByRole("tab", { name: /今日更新/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /已齐/ })).toHaveTextContent("0");
    // 缺集列同样提示（悬停说明里给出集号）；缺集为空仍显示占位符
    expect(container.querySelector(".pending-hint")?.textContent).toContain("今日更新 1 集");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);

    // 展开后分季明细给出具体集号
    await fireEvent.click(screen.getByRole("button", { name: /^斗破苍穹/ }));
    expect(screen.getByText("今日更新 E25")).toBeInTheDocument();
  });

  it("shows the today-update hint on mobile cards and season cards", async () => {
    stubViewport(true);
    const { container } = render(TaskTrackingBoard, { props: { tasks: pendingTasks } });

    expect(container.querySelector(".card-main .pending-hint")?.textContent).toContain("今日更新 1 集");

    await fireEvent.click(screen.getByRole("button", { name: /^斗破苍穹/ }));
    const accordion = container.querySelector(".accordion")!;
    expect(accordion.textContent).toContain("今日更新");
    expect(accordion.textContent).toContain("E25");
  });

  it("creates a task from the TMDB drawer", async () => {
    stubViewport(true);
    const createTask = vi.fn().mockResolvedValue({ ok: true, created: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { id: 70523, mediaType: "tv", title: "暗黑", originalTitle: "Dark", releaseYear: 2017, posterUrl: null },
              {
                id: 603,
                mediaType: "movie",
                title: "黑客帝国",
                originalTitle: "The Matrix",
                releaseYear: 1999,
                posterUrl: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { emitted } = render(TaskTrackingBoard, { props: { tasks, createTask } });

    await fireEvent.click(screen.getByLabelText("新建任务"));
    expect(await screen.findByRole("dialog", { name: "新建任务" })).toBeInTheDocument();

    await fireEvent.update(screen.getByPlaceholderText("输入剧名或片名搜索 TMDB"), "暗黑");
    await fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    // 剧集与电影都能建：这里点电影那条，验证 mediaType 一起传下去
    const hits = await screen.findAllByRole("button", { name: /新建任务 →/ });
    expect(hits).toHaveLength(2);
    await fireEvent.click(hits[1]!);
    expect(createTask).toHaveBeenCalledWith({ tmdbId: 603, title: "黑客帝国", mediaType: "movie" });
    expect(emitted().refresh).toBeTruthy();
  });

  it("rebinds a task to a manually typed TMDB id from the drawer", async () => {
    stubViewport(false);
    const rebindTask = vi.fn().mockResolvedValue({ ok: true, merged: false, metadataSynced: true });
    const { emitted } = render(TaskTrackingBoard, { props: { tasks, rebindTask } });

    await fireEvent.click(screen.getByRole("button", { name: "改绑 TMDB 暗黑" }));
    const dialog = await screen.findByRole("dialog", { name: "改绑 TMDB" });
    // 当前绑定必须先摆出来，否则改绑时看不出"从哪改到哪"
    expect(dialog.textContent).toContain("当前：");
    expect(dialog.textContent).toContain("70523");

    // 搜不到时手填 id：直接输入 + 用这个 ID + 确认
    await fireEvent.update(screen.getByLabelText(/TMDB ID/), "202");
    await fireEvent.click(screen.getByRole("button", { name: "用这个 ID" }));
    expect(screen.getByText(/将改绑为/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "确认改绑" }));
    expect(rebindTask).toHaveBeenCalledWith(1, { tmdbId: 202, mediaType: "tv" });
    expect(emitted().refresh).toBeTruthy();
  });

  it("rebinds to a TMDB search hit from the mobile card", async () => {
    stubViewport(true);
    const rebindTask = vi.fn().mockResolvedValue({ ok: true, merged: true, metadataSynced: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          results: [
            {
              id: 999,
              mediaType: "tv",
              title: "暗黑（另一版）",
              originalTitle: "Dark",
              releaseYear: 2017,
              posterUrl: null,
            },
          ],
        }),
      ),
    );
    render(TaskTrackingBoard, { props: { tasks, rebindTask } });

    // 移动端入口在卡片手风琴里
    await fireEvent.click(screen.getByRole("button", { name: /^暗黑/ }));
    await fireEvent.click(screen.getByRole("button", { name: /改绑 TMDB 条目/ }));
    expect(await screen.findByRole("dialog", { name: "改绑 TMDB" })).toBeInTheDocument();

    await fireEvent.update(screen.getByPlaceholderText("输入剧名或片名搜索 TMDB"), "暗黑");
    await fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    const hit = await screen.findByRole("button", { name: /选这条 →/ });
    await fireEvent.click(hit);
    await fireEvent.click(screen.getByRole("button", { name: "确认改绑" }));

    expect(rebindTask).toHaveBeenCalledWith(1, { tmdbId: 999, mediaType: "tv", title: "暗黑（另一版）" });
  });

  it("surfaces a failure message when the rebind is rejected", async () => {
    stubViewport(false);
    const rebindTask = vi.fn().mockResolvedValue({ ok: false, error: "tmdb_not_found" });
    render(TaskTrackingBoard, { props: { tasks, rebindTask } });

    await fireEvent.click(screen.getByRole("button", { name: "改绑 TMDB 暗黑" }));
    await fireEvent.update(screen.getByLabelText(/TMDB ID/), "1");
    await fireEvent.click(screen.getByRole("button", { name: "用这个 ID" }));
    await fireEvent.click(screen.getByRole("button", { name: "确认改绑" }));

    expect(await screen.findByText(/改绑失败/)).toBeInTheDocument();
  });

  it("deletes a tracking row from the table after confirming", async () => {
    stubViewport(false);
    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmSpy);
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    const { emitted } = render(TaskTrackingBoard, { props: { tasks, deleteTask } });

    await fireEvent.click(screen.getByRole("button", { name: "删除任务 暗黑" }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("暗黑"));
    expect(deleteTask).toHaveBeenCalledWith(1);
    expect(emitted().refresh).toBeTruthy();
  });

  it("does not delete when the confirmation is dismissed", async () => {
    stubViewport(false);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    render(TaskTrackingBoard, { props: { tasks, deleteTask } });

    await fireEvent.click(screen.getByRole("button", { name: "删除任务 暗黑" }));

    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("surfaces a failure message when the delete is rejected by the server", async () => {
    stubViewport(false);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const deleteTask = vi.fn().mockRejectedValue(new Error("action_failed"));
    render(TaskTrackingBoard, { props: { tasks, deleteTask } });

    await fireEvent.click(screen.getByRole("button", { name: "删除任务 暗黑" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("删除「暗黑」失败");
  });

  it("shows which media library holds the stored episodes", () => {
    stubViewport(false);
    const { container } = render(TaskTrackingBoard, { props: { tasks } });

    expect(screen.getByRole("columnheader", { name: "媒体库" })).toBeInTheDocument();
    const chips = [...container.querySelectorAll(".tracking-table tbody .lib-chip")].map((chip) =>
      chip.textContent?.replace(/\s+/g, ""),
    );
    expect(chips).toEqual(["剧集10集"]);
    // 库内目录也一并给出（悬停提示里带上，方便直接去 Emby 定位）
    expect(container.querySelector(".lib-path")?.textContent).toContain("Dark");
    // 一集都没入库的任务（花开锦绣没有 libraries）要显式说"未入库"
    expect(screen.getByText("未入库")).toBeInTheDocument();
  });

  it("expands a row into per-season library attribution", async () => {
    stubViewport(false);
    const { container } = render(TaskTrackingBoard, { props: { tasks } });

    await fireEvent.click(screen.getByRole("button", { name: /^暗黑/ }));

    const seasonTable = container.querySelector("table.season-table")!;
    expect(screen.getByRole("columnheader", { name: /媒体库（已存在哪个库/ })).toBeInTheDocument();
    expect(seasonTable.textContent).toContain("剧集10 集");
    expect(seasonTable.textContent).toContain("Dark/Season 01");
  });

  it("filters rows by media library", async () => {
    stubViewport(false);
    render(TaskTrackingBoard, { props: { tasks } });

    await fireEvent.click(screen.getByRole("tab", { name: /剧集/ }));
    const filtered = screen.getAllByRole("rowheader").map((cell) => cell.textContent?.trim());
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toContain("暗黑");

    await fireEvent.click(screen.getByRole("tab", { name: /不限媒体库/ }));
    expect(screen.getAllByRole("rowheader")).toHaveLength(2);
  });

  it("shows the media library on mobile cards and season cards", async () => {
    stubViewport(true);
    const { container } = render(TaskTrackingBoard, { props: { tasks } });

    expect(container.querySelector(".card-libraries")?.textContent).toContain("库：剧集 10 集");

    await fireEvent.click(screen.getByRole("button", { name: /^暗黑/ }));
    const seasonLibrary = container.querySelector(".season-library");
    expect(seasonLibrary?.textContent).toContain("剧集 10 集");
    expect(seasonLibrary?.textContent).toContain("Dark/Season 01");
  });

  it("offers the delete action inside the mobile accordion", async () => {
    stubViewport(true);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    render(TaskTrackingBoard, { props: { tasks, deleteTask } });

    await fireEvent.click(screen.getByRole("button", { name: /^暗黑/ }));
    const button = await screen.findByRole("button", { name: /删除这条任务/ });
    // 触控目标不小于 44px（CSS 里 min-height: 44px，这里校验它是卡片里的整宽按钮）
    expect(button.className).toContain("card-delete");

    await fireEvent.click(button);
    expect(deleteTask).toHaveBeenCalledWith(1);
  });
});
